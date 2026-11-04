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
  return {generate};
}
module.exports={createThumbnailGenerator,frameArgs,checkedRoot};
