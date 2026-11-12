"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createThumbnailGenerator}=require("../src/thumbnail-generator.cjs");
const {createThumbnailOverlay}=require("../src/thumbnail-overlay.cjs");

test("Timeline shows the first decoded NAS thumbnail while the next frame is still generating",async()=>{
  const video="/Volumes/Media/Review/slow.mkv";
  const cache="/tmp/Library/Caches/com.colliderli.iina/nas-review-generated";
  const hash="0123456789abcdef0123456789abcdef";
  const jpeg=Uint8Array.from([255,216,0,255,217]);
  const files=new Map(),overlayCalls=[];
  let secondStartedResolve,releaseSecond;
  const secondStarted=new Promise(resolve=>{secondStartedResolve=resolve;});
  let decodeCount=0;
  const utils={
    resolvePath(){return cache;},
    async exec(command,args){
      if(command==="/sbin/mount")
        return {status:0,stdout:"//user@nas/Media on /Volumes/Media (smbfs, nodev, nosuid)"};
      if(command==="/usr/bin/stat")return {status:0,stdout:"12345 1700000000"};
      if(command==="/sbin/md5")return {status:0,stdout:hash};
      if(command==="/bin/mkdir")return {status:0};
      if(command==="/opt/homebrew/bin/ffprobe")return {status:0,stdout:"h264"};
      if(command==="/opt/homebrew/bin/gtimeout"){
        decodeCount++;
        if(decodeCount===2){
          secondStartedResolve();
          await new Promise(resolve=>{releaseSecond=resolve;});
        }
        files.set(args.at(-1),jpeg);
        return {status:0};
      }
      throw Error("unexpected command "+command);
    }
  };
  const file={
    exists:path=>files.has(path),
    handle(path){return {readToEnd:()=>files.get(path),close(){}};}
  };
  const generator=createThumbnailGenerator({utils,file});
  const events={};
  const overlay={
    simpleMode(){},setStyle(){},setContent(html){overlayCalls.push(html);},
    setClickable(){},show(){},hide(){},
    onMessage(name,fn){events[name]=fn;}
  };
  const core={status:{duration:1200},seekTo(){}};
  const controller=createThumbnailOverlay({
    overlay,core,file,utils,
    preferences:{get:key=>key==="thumbnail_interval_minutes"?5:null},
    getCurrentPath:()=>video,
    generatePreviewFrames:(path,opts)=>generator.generate(path,opts)
  });
  controller.onFileLoaded();
  await secondStarted;
  try{
    assert.equal(await controller.toggle(),true);
    const html=overlayCalls.at(-1);
    assert.match(html,/class="tile"/,
      "after frame 1 decodes, Timeline should not remain empty while frame 2 is in progress");
  }finally{
    releaseSecond?.();
    await controller.waitForPrefetch();
    controller.close();
  }
});

test("a failed auto VideoToolbox decoder falls back to software for subsequent HEVC videos",async()=>{
  const videos=["/Volumes/Media/Review/a.mkv","/Volumes/Media/Review/b.mkv"];
  const cache="/tmp/Library/Caches/com.colliderli.iina/nas-review-generated";
  const jpeg=Uint8Array.from([255,216,0,255,217]);
  const files=new Map(),decoders=[];
  const utils={
    resolvePath(){return cache;},
    async exec(command,args){
      if(command==="/sbin/mount")
        return {status:0,stdout:"//user@nas/Media on /Volumes/Media (smbfs, nodev, nosuid)"};
      if(command==="/usr/bin/stat")return {status:0,stdout:"12345 1700000000"};
      if(command==="/sbin/md5"){
        return {status:0,stdout:args[1].includes("/a.mkv")?"a".repeat(32):"b".repeat(32)};
      }
      if(command==="/bin/mkdir")return {status:0};
      if(command==="/opt/homebrew/bin/ffprobe")return {status:0,stdout:"hevc"};
      if(command==="/opt/homebrew/bin/gtimeout"){
        const hw=args.includes("videotoolbox");
        decoders.push(hw?"videotoolbox":"software");
        if(hw)return {status:1};
        files.set(args.at(-1),jpeg);
        return {status:0};
      }
      throw Error("unexpected command "+command);
    }
  };
  const file={
    exists:path=>files.has(path),
    handle:path=>({readToEnd:()=>files.get(path),close(){}})
  };
  const generator=createThumbnailGenerator({utils,file});
  for(const video of videos){
    const result=await generator.generate(video,{duration:60,count:1,mode:"auto"});
    assert.equal(result.length,1);
  }
  assert.deepEqual(decoders,["videotoolbox","software","software"],
    "after verified hardware failure, auto mode must not stall again on next HEVC clip");
});