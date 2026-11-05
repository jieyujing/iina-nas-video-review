"use strict";
// Read-only source access; all generated JPEGs are local IINA cache files.
// Hardware acceleration is a decode option, not a promise of faster JPEG
// extraction. No shell is used and no command writes to the SMB source.
const Nas=require("./nas-source.cjs");
const Cache=require("./thumbnail-cache.cjs");
const Sampling=require("./thumbnail-sampling.cjs");
const FFMPEG="/opt/homebrew/bin/ffmpeg";
const FFPROBE="/opt/homebrew/bin/ffprobe";
const CACHE_SUBDIR="/Library/Caches/com.colliderli.iina/nas-review-generated";
// One decoding request is strictly a page. The theoretical maximum number
// of positions is 1440 (24h video at 1 min/sample), not a generator cap at 40.
const MAX_DURATION_SECONDS=86400;
const PAGE_SIZE=Sampling.NAS_PAGE_SIZE;
const MAX_JPEG_BYTES=240000;
function fail(reason){throw new Error(reason);}
function checkedRoot(resolved){
  if(typeof resolved!=="string" || !resolved.startsWith("/") ||
    !resolved.endsWith(CACHE_SUBDIR) || resolved.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(resolved))fail("cache_path_invalid");
  return resolved;
}
// Destructive cache cleanup must have a much narrower root check than
// read-only thumbnail loading. Never accept an SMB mount or arbitrary path.
function checkedCleanupRoot(path){
  checkedRoot(path);
  const suffix=CACHE_SUBDIR;
  if(!(/^\/Users\/[^/]+$/.test(path.slice(0,-suffix.length)) ||
       path==="/tmp"+suffix))fail("cleanup_cache_root_invalid");
  return path;
}
function sourceFingerprint(path,size,mtime){
  return path+"\n"+size+"\n"+mtime;
}
function cacheIdentity(identity){
  if(typeof identity!=="string")fail("cleanup_file_identity_invalid");
  const fields=identity.split("|");
  if(fields.length!==5 || !fields.every(x=>/^\d+$/.test(x)) ||
     (parseInt(fields[0],8)&0o170000)!==0o100000)
    fail("cleanup_file_identity_invalid");
  const size=Number(fields[3]),mtime=Number(fields[4]);
  if(!Number.isSafeInteger(size)||size<=0 ||
     !Number.isSafeInteger(mtime)||mtime<=0)
    fail("cleanup_file_identity_invalid");
  return {size,mtime};
}
function jpegData(file,path){
  if(!file?.exists?.(path))return null;
  let handle,bytes;
  try{
    handle=file.handle(path,"read");
    bytes=handle.readToEnd();
  }finally{try{handle?.close();}catch(_){}}
  if(!(bytes instanceof Uint8Array) || bytes.byteLength<4 ||
    bytes.byteLength>MAX_JPEG_BYTES ||
    bytes[0]!==255 || bytes[1]!==216 ||
    bytes[bytes.length-2]!==255 || bytes[bytes.length-1]!==217)
    return null;
  return "data:image/jpeg;base64,"+Cache.toBase64(bytes);
}
function frameArgs(path,out,time,hardware){
  const cmd=["-hide_banner","-loglevel","error","-nostdin","-y",
    "-ss",time.toFixed(3),"-hwaccel",hardware?"videotoolbox":"none",
    "-i",path,"-map","0:v:0","-an","-sn","-dn",
    "-frames:v","1","-vf","scale=320:-2:flags=fast_bilinear",
    "-q:v","5","-f","image2","-update","1",out];
  return cmd;
}
function createThumbnailGenerator({utils,file,log=()=>{}}={}){
  // Serialize page requests so rapid page changes cannot spawn concurrent
  // FFmpeg decoders against a mounted NAS. Stale requests still honor their
  // isCancelled callback before starting the next frame.
  let previous=Promise.resolve();
  const knownHashes=new Map();
  function remember(path,size,mtime,hash){
    const key=sourceFingerprint(path,size,mtime);
    if(!knownHashes.has(key)){
      if(knownHashes.size>=128)knownHashes.delete(knownHashes.keys().next().value);
      knownHashes.set(key,new Set());
    }
    const hashes=knownHashes.get(key);
    if(hashes.size>=16)hashes.delete(hashes.values().next().value);
    hashes.add(hash);
  }
  async function generatePage(path,{duration,count=20,startIndex=0,pageSize=PAGE_SIZE,
    mode="auto",isCancelled=()=>false,onProgress=()=>{}}={}){
    if(!Nas.normalize(path))fail("invalid_nas_path");
    if(!Number.isFinite(duration)||duration<=0||duration>86400)
      fail("duration_unavailable");
    if(!Number.isInteger(count)||count<1||count>MAX_DURATION_SECONDS/60)
      fail("generation_sample_limit");
    if(!Number.isInteger(startIndex)||startIndex<0||startIndex>=count||
       !Number.isInteger(pageSize)||pageSize<1||pageSize>PAGE_SIZE)
      fail("generation_page_invalid");
    if(!["auto","videotoolbox","software"].includes(mode))
      fail("decode_mode_invalid");
    if(!utils?.exec||!utils?.resolvePath||!file?.exists||!file?.handle)
      fail("file_api_unavailable");
    const mounted=await utils.exec("/sbin/mount",[]);
    if(mounted?.status!==0 || !Nas.probe(path,mounted.stdout).allowed)
      fail("not_mounted_smbfs");
    const stat=await utils.exec("/usr/bin/stat",["-f","%z %m",path]);
    const metadata=String(stat?.stdout||"").trim().match(/^(\d+)\s+(\d+)$/);
    if(stat?.status!==0||!metadata)fail("video_stat_failed");
    const size=Number(metadata[1]),mtime=Number(metadata[2]);
    if(!Number.isSafeInteger(size)||size<=0||!Number.isSafeInteger(mtime)||mtime<=0)
      fail("video_metadata_invalid");
    const key=await utils.exec("/sbin/md5",[
      "-qs",path+"\n"+size+"\n"+mtime+"\n"+duration
    ]);
    const hash=String(key?.stdout||"").trim().toLowerCase();
    if(key?.status!==0||!/^[0-9a-f]{32}$/.test(hash))
      fail("cache_key_unavailable");
    remember(path,size,mtime,hash);
    const dir=checkedRoot(utils.resolvePath("~"+CACHE_SUBDIR));
    const mkdir=await utils.exec("/bin/mkdir",["-p",dir]);
    if(mkdir?.status!==0)fail("cache_dir_unavailable");
    let codec="";
    if(mode==="auto"){
      try{
        const probe=await utils.exec(FFPROBE,["-v","error","-select_streams","v:0",
          "-show_entries","stream=codec_name","-of","default=noprint_wrappers=1:nokey=1",path]);
        if(probe?.status===0)codec=String(probe.stdout||"").trim().toLowerCase();
      }catch(_){}
    }
    // Small H.264 JPEG extraction can be faster on CPU due to VT
    // upload/readback overhead. Prefer VT for HEVC, retain user override.
    const hardware=mode==="videotoolbox" ||
      (mode==="auto" && ["hevc","h265"].includes(codec));
    log("thumbnail.decode.selected",{reason:hardware?"videotoolbox":"software"});
    const images=[];
    const endIndex=Math.min(count,startIndex+pageSize);
    const pageTotal=endIndex-startIndex;
    for(let i=startIndex;i<endIndex;i++){
      if(isCancelled())return [];
      const time=duration*(i+0.5)/count;
      const out=dir+"/"+hash+"-"+count+"-"+i+".jpg";
      let image;
      try{image=jpegData(file,out);}catch(_){image=null;}
      if(!image){
        let result;
        try{result=await utils.exec(FFMPEG,frameArgs(path,out,time,hardware));}
        catch(_){result=null;}
        if(result?.status===0){
          try{image=jpegData(file,out);}catch(_){image=null;}
        }
        if(!image && hardware){
          log("thumbnail.decode.fallback",{reason:"videotoolbox_failed"},"warn");
          try{result=await utils.exec(FFMPEG,frameArgs(path,out,time,false));}
          catch(_){result=null;}
          if(result?.status===0){
            try{image=jpegData(file,out);}catch(_){image=null;}
          }
        }
      }
      if(isCancelled())return [];
      if(image)images.push({time,image});
      const pageCompleted=i-startIndex+1;
      if(pageCompleted%4===0||pageCompleted===pageTotal)
        onProgress({completed:pageCompleted,total:pageTotal,images:images.slice()});
    }
    if(!images.length)fail("preview_decode_failed");
    log("thumbnail.generated.summary",{count:images.length,total:pageTotal});
    return images;
  }
  function generate(path,options={}){
    const task=previous.then(()=>generatePage(path,options));
    previous=task.catch(()=>{});
    return task;
  }
  // Snapshot is taken BEFORE the video's unlink, from its independently
  // verified file identity. No video bytes or native IINA caches are touched.
  async function captureForDeletion(path,{fileIdentity,duration}={}){
    if(!Nas.normalize(path))fail("cleanup_source_invalid");
    const {size,mtime}=cacheIdentity(fileIdentity);
    const dir=checkedCleanupRoot(utils.resolvePath("~"+CACHE_SUBDIR));
    const hashes=new Set(knownHashes.get(sourceFingerprint(path,size,mtime))||[]);
    if(Number.isFinite(duration)&&duration>0&&duration<=MAX_DURATION_SECONDS){
      try{
        const digest=await utils.exec("/sbin/md5",[
          "-qs",path+"\n"+size+"\n"+mtime+"\n"+duration
        ]);
        const hash=String(digest?.stdout||"").trim().toLowerCase();
        if(digest?.status===0 && /^[0-9a-f]{32}$/.test(hash))hashes.add(hash);
      }catch(_){/* Retain recorded hashes from this plugin session. */}
    }
    if(!hashes.size)fail("cleanup_identity_unavailable");
    return {dir,hashes:[...hashes].slice(0,16)};
  }
  async function removeCachedFrames(snapshot){
    if(!snapshot || typeof snapshot!=="object"||
       typeof file?.list!=="function"||typeof utils?.exec!=="function")
      fail("cleanup_api_unavailable");
    const dir=checkedCleanupRoot(utils.resolvePath("~"+CACHE_SUBDIR));
    if(snapshot.dir!==dir || !Array.isArray(snapshot.hashes) ||
       snapshot.hashes.length<1||snapshot.hashes.length>16 ||
       !snapshot.hashes.every(x=>typeof x==="string"&&/^[0-9a-f]{32}$/.test(x)))
      fail("cleanup_snapshot_invalid");
    const folder=await utils.exec("/usr/bin/stat",["-f","%p",dir]);
    if(folder?.status!==0 && file?.exists?.(dir)===false){
      // No cache folder exists at all, so there are no JPEGs to reclaim.
      log("thumbnail.cleanup.completed",{removed:0,failed:0});
      return {removed:0,failed:0};
    }
    if(folder?.status!==0 ||
       (parseInt(String(folder.stdout||"").trim(),8)&0o170000)!==0o040000)
      fail("cleanup_directory_unverified");
    const listed=file.list(dir);
    if(!Array.isArray(listed)||listed.length>50000)fail("cleanup_list_unavailable");
    const hashes=new Set(snapshot.hashes);
    const targets=[];
    for(const row of listed){
      const name=row?.filename;
      if(typeof name!=="string"||row.isDir===true||row.isSymlink===true||
         row.symlink===true||row.isSymbolicLink===true)continue;
      const match=/^([0-9a-f]{32})-([1-9]\d{0,3})-(0|[1-9]\d{0,3})\.jpg$/.exec(name);
      if(!match || !hashes.has(match[1]))continue;
      const count=Number(match[2]),index=Number(match[3]);
      if(count>1440 || index>=count)continue;
      if(row.path!==name&&row.path!=="/"+name&&row.path!==dir+"/"+name)
        continue;
      targets.push(dir+"/"+name);
      if(targets.length>2000)fail("cleanup_too_many_matches");
    }
    let removed=0,failed=0;
    for(const target of targets){
      try{
        // A local JPEG must still be a regular file immediately before rm.
        const meta=await utils.exec("/usr/bin/stat",["-f","%p",target]);
        if(meta?.status!==0 ||
           (parseInt(String(meta.stdout||"").trim(),8)&0o170000)!==0o100000){
          failed++;continue;
        }
        const result=await utils.exec("/bin/rm",["--",target]);
        if(result?.status===0)removed++;
        else failed++;
      }catch(_){failed++;}
    }
    log("thumbnail.cleanup.completed",{removed,failed});
    return {removed,failed};
  }
  // The SAME serialized queue used for page decoding guarantees that an
  // in-flight FFmpeg job cannot recreate a JPEG after this cleanup runs.
  function queueCleanup(snapshot){
    const task=previous.then(()=>removeCachedFrames(snapshot));
    previous=task.catch(()=>{});
    return task;
  }
  return {generate,captureForDeletion,queueCleanup};
}
module.exports={createThumbnailGenerator,frameArgs,checkedRoot,checkedCleanupRoot};
