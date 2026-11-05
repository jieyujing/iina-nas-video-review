"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createThumbnailGenerator,frameArgs}=require("../src/thumbnail-generator.cjs");
const source="/Volumes/Media/Review/example.mkv";
const mount="//user@nas.example/Media on /Volumes/Media (smbfs, nodev, nosuid)";
const hash="0123456789abcdef0123456789abcdef";
const cache="/tmp/Library/Caches/com.colliderli.iina/nas-review-generated";
const jpeg=Uint8Array.from([255,216,255,219,0,255,217]);
function mock({codec="hevc",mounts=mount,hardwareFails=false,onFFmpeg=null,
  cacheRmFails=false,cacheSymlinks=[],missingCacheDir=false}={}){
 const files=new Map(),calls=[],events=[],removed=[];
 const utils={
  resolvePath(x){assert.equal(x,"~/Library/Caches/com.colliderli.iina/nas-review-generated");return cache;},
  async exec(cmd,args){
   calls.push({cmd,args});
   if(cmd==="/sbin/mount")return {status:0,stdout:mounts};
   if(cmd==="/usr/bin/stat"){
     if(args[1]==="%p")return missingCacheDir&&args[2]===cache?
       {status:1,stderr:"No such file or directory"}:
       {status:0,stdout:args[2]===cache?"40755":"100644"};
     return {status:0,stdout:"12345 1700000000"};
   }
   if(cmd==="/sbin/md5")return {status:0,stdout:hash};
   if(cmd==="/bin/mkdir")return {status:0,stdout:""};
   if(cmd==="/bin/rm"){
     assert.equal(args.length,2);
     assert.equal(args[0],"--");
     assert.ok(args[1].startsWith(cache+"/"));
     if(cacheRmFails)return {status:1,stderr:"Permission denied"};
     removed.push(args[1]);files.delete(args[1]);
     return {status:0,stderr:""};
   }
   if(cmd==="/opt/homebrew/bin/ffprobe")return {status:0,stdout:codec};
   if(cmd==="/opt/homebrew/bin/ffmpeg"){
    const output=args.at(-1);
    assert.ok(output.startsWith(cache+"/"+hash+"-"));
    assert.equal(args[args.indexOf("-i")+1],source);
    if(onFFmpeg)await onFFmpeg();
    if(hardwareFails && args.includes("videotoolbox"))
      return {status:1,stdout:"",stderr:"unsupported codec"};
    files.set(output,jpeg);
    return {status:0,stdout:""};
   }
   throw Error("unexpected command");
  }
 };
 const file={
  exists:path=>files.has(path),
  list(dir){
   assert.equal(dir,cache);
   return [...files.keys()].filter(x=>x.startsWith(dir+"/")).map(path=>{
     const filename=path.slice(dir.length+1);
     return {filename,path:"/"+filename,isDir:false,
       isSymlink:cacheSymlinks.includes(filename)};
   });
  },
  handle(path,mode){
   assert.equal(mode,"read");
   assert.ok(path.startsWith(cache+"/"));
   return {readToEnd:()=>files.get(path),close(){}};
  }
 };
 return {generator:createThumbnailGenerator({utils,file,log:(event,data)=>events.push({event,data})}),
  calls,events,files,removed};
}
const identity="100644|18|23|12345|1700000000";
test("delete cache cleanup only removes exact JPEG hashes for this video",async()=>{
 const h=mock();
 await h.generator.generate(source,{duration:60,count:4});
 const other=cache+"/abcdefabcdefabcdefabcdefabcdefab-4-0.jpg";
 const nativeCache="/tmp/Library/Caches/com.colliderli.iina/thumb_cache/native";
 const backup=cache+"/"+hash+"-4-0.jpg.bak";
 h.files.set(other,jpeg);h.files.set(backup,jpeg);h.files.set(nativeCache,jpeg);
 const snapshot=await h.generator.captureForDeletion(source,{
   fileIdentity:identity,duration:60
 });
 const result=await h.generator.queueCleanup(snapshot);
 assert.deepEqual(result,{removed:4,failed:0});
 assert.equal(h.removed.length,4);
 assert.equal(h.files.has(other),true);
 assert.equal(h.files.has(backup),true);
 assert.equal(h.files.has(nativeCache),true);
 assert.ok(h.removed.every(p=>p.startsWith(cache+"/"+hash+"-4-")));
});
test("no cache and failed cache unlink are best-effort without deleting other files",async()=>{
 const empty=mock();
 const snapshot=await empty.generator.captureForDeletion(source,{
   fileIdentity:identity,duration:60
 });
 assert.deepEqual(await empty.generator.queueCleanup(snapshot),{removed:0,failed:0});
 const failed=mock({cacheRmFails:true});
 await failed.generator.generate(source,{duration:60,count:2});
 const key=await failed.generator.captureForDeletion(source,{fileIdentity:identity,duration:60});
 assert.deepEqual(await failed.generator.queueCleanup(key),{removed:0,failed:2});
 assert.equal(failed.files.size,2);
});
test("nonexistent plugin cache directory is an empty successful cleanup",async()=>{
 const h=mock({missingCacheDir:true});
 const snapshot=await h.generator.captureForDeletion(source,{
   fileIdentity:identity,duration:60
 });
 assert.deepEqual(await h.generator.queueCleanup(snapshot),{removed:0,failed:0});
 assert.equal(h.removed.length,0);
});
test("cache removal cannot escape local root or remove symlinked entries",async()=>{
 const h=mock({cacheSymlinks:[hash+"-2-0.jpg"]});
 await h.generator.generate(source,{duration:60,count:2});
 const snapshot=await h.generator.captureForDeletion(source,{fileIdentity:identity,duration:60});
 const malicious={...snapshot,dir:"/Volumes/Media/Library/Caches/com.colliderli.iina/nas-review-generated"};
 await assert.rejects(h.generator.queueCleanup(malicious),/cleanup_snapshot_invalid/);
 assert.equal(h.removed.length,0);
 const res=await h.generator.queueCleanup(snapshot);
 assert.deepEqual(res,{removed:1,failed:0});
 assert.equal(h.files.has(cache+"/"+hash+"-2-0.jpg"),true);
});
test("cleanup waits behind in-flight FFmpeg generation before unlinking cache",async()=>{
 let release,started=0;
 const hold=new Promise(resolve=>{release=resolve;});
 const h=mock({onFFmpeg:async()=>{if(++started===1)await hold;}});
 const work=h.generator.generate(source,{duration:60,count:2});
 await new Promise(resolve=>setImmediate(resolve));
 const snapshot=await h.generator.captureForDeletion(source,{
   fileIdentity:identity,duration:60
 });
 const cleanup=h.generator.queueCleanup(snapshot);
 assert.equal(h.removed.length,0);
 release();
 await work;
 assert.deepEqual(await cleanup,{removed:2,failed:0});
 assert.equal(h.files.size,0,"no in-flight old video JPEG must be recreated after cleanup");
});
test("SMB frame generation prefers VideoToolbox for HEVC and caches only on local Mac",async()=>{
 const h=mock();
 const progress=[];
 const images=await h.generator.generate(source,{
  duration:60,count:4,onProgress:p=>progress.push(p)
 });
 assert.equal(images.length,4);
 assert.deepEqual(images.map(x=>x.time),[7.5,22.5,37.5,52.5]);
 assert.ok(images.every(x=>x.image.startsWith("data:image/jpeg;base64,")));
 const ff=h.calls.filter(x=>x.cmd.endsWith("/ffmpeg"));
 assert.equal(ff.length,4);
 assert.ok(ff.every(x=>x.args.includes("videotoolbox")));
 assert.ok(ff.every(x=>x.args.at(-1).startsWith(cache+"/")));
 assert.equal(progress.at(-1).completed,4);
 assert.equal(h.events.some(x=>x.event==="thumbnail.generated.summary"),true);
 await h.generator.generate(source,{duration:60,count:4});
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,4,
  "cached thumbnails should not re-decode same-size/mtime source");
});
test("120 requested frames generate in bounded 35-frame pages with global timestamps and cache reuse",async()=>{
 const h=mock();
 const first=await h.generator.generate(source,{
   duration:7200,count:120,startIndex:0,pageSize:35
 });
 assert.equal(first.length,35);
 assert.equal(first[0].time,30);
 assert.equal(first[34].time,2070);
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,35);
 const second=await h.generator.generate(source,{
   duration:7200,count:120,startIndex:35,pageSize:35
 });
 assert.equal(second.length,35);
 assert.equal(second[0].time,2130);
 assert.equal(second[34].time,4170);
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,70);
 await h.generator.generate(source,{duration:7200,count:120,startIndex:0,pageSize:35});
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,70,
   "page revisit must reuse existing local JPEG cache files");
});
test("the last page contains only its remaining samples",async()=>{
 const h=mock();
 const last=await h.generator.generate(source,{
   duration:2700,count:45,startIndex:35,pageSize:35
 });
 assert.equal(last.length,10);
 assert.deepEqual(last.map(x=>x.time),
   Array.from({length:10},(_,i)=>2130+i*60));
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,10);
});
test("generator rejects requests above the per-page budget of 35",async()=>{
 const h=mock();
 await assert.rejects(h.generator.generate(source,{
   duration:7200,count:120,startIndex:0,pageSize:36
 }),/generation_page_invalid/);
 assert.equal(h.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,0);
});
test("rapid page changes serialize FFmpeg and cancellation releases the next page",async()=>{
 let release,started=0,active=0,peak=0,cancelFirst=false;
 const hold=new Promise(resolve=>{release=resolve;});
 const h=mock({onFFmpeg:async()=>{
  started++;active++;peak=Math.max(peak,active);
  if(started===1)await hold;
  active--;
 }});
 const first=h.generator.generate(source,{
   duration:7200,count:120,startIndex:0,pageSize:1,
   isCancelled:()=>cancelFirst
 });
 const next=h.generator.generate(source,{
   duration:7200,count:120,startIndex:20,pageSize:1
 });
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(started,1,"only one FFmpeg page request may be in flight");
 cancelFirst=true;release();
 const [oldResult,newResult]=await Promise.all([first,next]);
 assert.deepEqual(oldResult,[]);
 assert.equal(newResult.length,1);
 assert.equal(newResult[0].time,1230);
 assert.equal(peak,1);
});
test("H264 auto selects CPU measured lower overhead; explicit GPU fallback to CPU",async()=>{
 const cpu=mock({codec:"h264"});
 await cpu.generator.generate(source,{duration:30,count:2});
 assert.ok(cpu.calls.filter(x=>x.cmd.endsWith("/ffmpeg"))
  .every(x=>x.args.includes("none")));
 const vt=mock({hardwareFails:true});
 const frames=await vt.generator.generate(source,{
  duration:30,count:2,mode:"videotoolbox"
 });
 assert.equal(frames.length,2);
 assert.equal(vt.calls.filter(x=>x.cmd.endsWith("/ffmpeg")).length,4);
 assert.equal(vt.events.filter(x=>x.event==="thumbnail.decode.fallback").length,2);
});
test("unmounted volume and path injection are rejected before launching FFmpeg or writing",async()=>{
 for(const path of [source,"/Volumes/Media/../Other/file.mp4","/private/tmp/a.mp4"]){
  const h=mock({mounts:"/dev/disk3 on /Volumes/Media (apfs, local)"});
  await assert.rejects(h.generator.generate(path,{duration:30,count:2}),
    /invalid_nas_path|not_mounted_smbfs/);
  assert.equal(h.calls.some(x=>x.cmd.endsWith("/ffmpeg")||x.cmd==="/bin/mkdir"),false);
 }
});
test("frame args seek before input and write JPEG to local cache without shell",()=>{
 const args=frameArgs(source,cache+"/frame.jpg",12.5,true);
 assert.ok(args.indexOf("-ss")<args.indexOf("-i"));
 assert.equal(args[args.indexOf("-hwaccel")+1],"videotoolbox");
 assert.equal(args.at(-1),cache+"/frame.jpg");
 assert.equal(args.includes("-nostdin"),true);
});
