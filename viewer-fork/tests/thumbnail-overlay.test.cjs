"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {createThumbnailOverlay}=require("../src/thumbnail-overlay.cjs");
const root="/private/tmp/iina-nas-review-fixture-thumb";
const video=root+"/video.mp4";
const cacheName="0123456789abcdef0123456789abcdef";
function cache(){
 const header=Buffer.alloc(17);header[0]=2;header.writeBigUInt64LE(456n,1);header.writeBigInt64LE(1700000000n,9);
 return new Uint8Array(Buffer.concat([header,...[5,15,25,35].map((t,i)=>{
  const jpg=Buffer.from([255,216,i,255,217]),h=Buffer.alloc(16);
  h.writeBigUInt64LE(BigInt(jpg.length+8),0);h.writeDoubleLE(t,8);return Buffer.concat([h,jpg]);
 })]));
}
function make({cached=true,allow=true,bindings={},generated=null,prefStore=new Map()}={}){
 const calls=[],handlers={},keys={},debug=[];
 let allowed=allow, current=video;
 const overlay={
  simpleMode(){calls.push("simple");},
  setStyle(css){calls.push(["style",css]);},
  setContent(html){calls.push(["content",html]);},
  setClickable(v){calls.push(["clickable",v]);},
  show(){calls.push("show");},
  hide(){calls.push("hide");},
  onMessage(name,cb){handlers[name]=cb;}
 };
 const core={status:{url:"file://"+video,duration:40},seekTo(sec){calls.push(["seek",sec]);}};
 const file={
  exists(p){return cached && p.endsWith(cacheName);},
  handle(p,mode){assert.equal(mode,"read");assert.ok(p.endsWith(cacheName));calls.push(["handle",mode]);
   return {readToEnd(){return cache();},close(){calls.push("close-handle");}};}
 };
 const utils={
  resolvePath(p){assert.match(p,/thumb_cache/);return "/tmp/iina-cache";},
  async exec(cmd,args){
   assert.ok(["/usr/bin/stat","/sbin/md5"].includes(cmd));
   if(cmd==="/sbin/md5")return {status:0,stdout:cacheName+"\n"};
   if(args.includes("%z %m"))return {status:0,stdout:"456 1700000000\n"};
   if(args.includes("%z"))return {status:0,stdout:String(cache().length)+"\n"};
   throw new Error("Unexpected command");
  }
 };
 const input={
  PRIORITY_HIGH:10,
  normalizeKeyCode:k=>k,getAllKeyBindings:()=>bindings,
  onKeyDown(k,fn,p){keys[k]={fn,priority:p};}
 };
 const controller=createThumbnailOverlay({
  overlay,core,file,utils,input,generatePreviewFrames:generated,
  preferences:{
    get:key=>prefStore.get(key)??null,
    set:(key,value)=>prefStore.set(key,value),
    sync(){}
  },
  getCurrentPath:()=>allowed?current:null,
  log:(event,data)=>debug.push({event,data})
 });
 return {controller,overlay,calls,handlers,keys,core,debug,prefStore,
  setAllowed:v=>{allowed=v;},setCurrent:v=>{current=v;}};
}
test("native cached timeline opens only in managed Review, clicking a tile seeks",async()=>{
 const h=make();
 h.controller.register();
 assert.equal(h.keys["0"].priority,10);
 assert.equal(h.keys["0"].fn({isRepeat:false}),true);
 await h.controller.waitForLoad();
 const html=h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1];
 assert.match(html,/data:image\/jpeg;base64/);
 assert.match(html,/thumbnail-seek/);
 assert.equal(h.calls.includes("show"),true);
 assert.ok(h.calls.some(x=>Array.isArray(x)&&x[0]==="handle"&&x[1]==="read"));
 h.handlers["thumbnail-seek"](0);
 assert.deepEqual(h.calls.find(x=>Array.isArray(x)&&x[0]==="seek"),["seek",15]);
 assert.equal(h.calls.includes("hide"),true);
 assert.deepEqual(h.calls.at(-1),["clickable",false]);
});
test("overlay tile click travels through inline WebView postMessage and leaves diagnostic evidence",async()=>{
 const h=make();
 await h.controller.toggle();await h.controller.waitForLoad();
 const html=h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1];
 const tile=html.match(/<button data-clickable class="tile"[^>]*onclick="([^"]+)"[^>]*>/);
 assert.ok(tile,"tile must be an overlay-clickable button");
 const css=h.calls.find(x=>Array.isArray(x)&&x[0]==="style");
 assert.ok(css);
 assert.match(css[1],/\.tile img,\.tile span\{pointer-events:none\}/,
   "decorative image and timestamp must not steal IINA's clickable hit test");
 const received=[];
 vm.runInNewContext(tile[1],{iina:{postMessage:(event,data)=>{
   received.push({event,data});
   h.handlers[event]?.(data);
 }}});
 assert.equal(received.length,1);
 assert.equal(received[0].event,"thumbnail-seek");
 assert.ok(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"));
 assert.ok(h.debug.some(x=>x.event==="thumbnail.click.received"),
   "diagnostic must distinguish WebView click reception from no click");
 assert.ok(h.debug.some(x=>x.event==="thumbnail.seek.accepted"));
});
test("thumbnail click rejection is observable and never leaks paths or mutates playback",async()=>{
 const h=make();
 await h.controller.toggle();await h.controller.waitForLoad();
 h.handlers["thumbnail-seek"]("0");
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
 assert.ok(h.debug.some(x=>x.event==="thumbnail.click.received"));
 assert.ok(h.debug.some(x=>x.event==="thumbnail.seek.rejected"&&x.data.reason==="invalid_index"));
 assert.equal(h.debug.some(x=>JSON.stringify(x).includes(root)),false);
 h.setCurrent(root+"/other.mp4");
 h.handlers["thumbnail-seek"](1);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
 assert.ok(h.debug.some(x=>x.event==="thumbnail.seek.rejected"&&x.data.reason==="media_mismatch"));
 h.handlers["thumbnail-seek"](0);
 assert.ok(h.debug.some(x=>x.event==="thumbnail.seek.rejected"&&x.data.reason==="overlay_not_visible"));
});
test("outside Review or conflicted 0 binding cannot intercept player",()=>{
 const h=make({allow:false});
 h.controller.register();
 assert.equal(h.keys["0"].fn({isRepeat:false}),false);
 assert.equal(h.calls.includes("show"),false);
 const conflicted=make({bindings:{"0":{action:"custom"}}});
 conflicted.controller.register();
 assert.equal(conflicted.keys["0"],undefined);
});
test("missing native cache reports safe unavailability without creating or deleting files",async()=>{
 const h=make({cached:false});
 assert.equal(await h.controller.toggle(),true);
 await h.controller.waitForLoad();
 assert.ok(h.calls.some(x=>Array.isArray(x)&&x[0]==="content"&&
  x[1].includes("Native IINA thumbnail cache unavailable")));
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="handle"),false);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
});
test("a matched SMB Review video generates previews on demand instead of rejecting /Volumes",async()=>{
 const nasPath="/Volumes/Media/Review/movie.mp4";
 const requests=[];
 const h=make({cached:false,generated:async(path,opts)=>{
   requests.push({path,count:opts.count,mode:opts.mode});
   return [{time:5,image:"data:image/jpeg;base64,/9j/2Q=="},{
     time:25,image:"data:image/jpeg;base64,/9j/2Q=="}];
 }});
 h.setCurrent(nasPath);
 assert.equal(await h.controller.toggle(),true);
 await h.controller.waitForLoad();
 assert.equal(requests.length,1);
 assert.equal(requests[0].path,nasPath);
 const content=h.calls.filter(c=>Array.isArray(c)&&c[0]==="content").at(-1)[1];
 assert.match(content,/class="tile"/);
 assert.ok(h.debug.some(x=>x.event==="thumbnail.generated.ready"));
 h.handlers["thumbnail-seek"](1);
  assert.ok(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"&&x[1]===25));
});
test("NAS preview mode is selectable, and expired load cannot render after media change",async()=>{
 const source="/Volumes/Media/Review/a.mp4";
 let resolveResult;
 const requests=[];
 const h=make({cached:false,generated:(path,opts)=>{
   requests.push({path,mode:opts.mode});
   return new Promise(resolve=>{resolveResult=resolve;});
 }});
 h.setCurrent(source);
 assert.equal(await h.controller.toggle(),true);
 h.handlers["thumbnail-mode"]("videotoolbox");
 assert.equal(requests.at(-1).mode,"videotoolbox");
 h.setCurrent("/Volumes/Media/Review/b.mp4");
 resolveResult([{time:2,image:"data:image/jpeg;base64,/9j/2Q=="}]);
 await h.controller.waitForLoad();
 assert.equal(h.debug.some(x=>x.event==="thumbnail.generated.ready"),false);
 h.handlers["thumbnail-seek"](0);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
});
test("NAS interval requests all 120 positions in 35-frame pages without a total cap",async()=>{
 const requests=[];
 const h=make({cached:false,generated:async(_path,opts)=>{
   requests.push({count:opts.count,startIndex:opts.startIndex,pageSize:opts.pageSize});
   return [{time:opts.duration*(opts.startIndex+0.5)/opts.count,
     image:"data:image/jpeg;base64,/9j/2Q=="}];
 }});
 h.setCurrent("/Volumes/Media/Review/clip.mp4");
 h.core.status.duration=7200;
 await h.controller.toggle();
 await h.controller.waitForLoad();
 assert.equal(requests.at(-1).count,12,"120-minute video at 10-minute interval");
 h.handlers["thumbnail-interval"](5);
 await h.controller.waitForLoad();
 assert.equal(requests.at(-1).count,24);
 h.handlers["thumbnail-interval"](1);
 await h.controller.waitForLoad();
 assert.ok(requests.some(x=>x.count===120&&x.startIndex===0&&x.pageSize===35));
 const html=h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1];
 assert.match(html,/min.*sample/);
 assert.match(html,/120 samples/);
 assert.doesNotMatch(html,/40.*max/i);
 assert.match(html,/Page 1 \/ 4/);
 const next=html.match(/<button data-clickable[^>]*onclick="([^"]+)"[^>]*>Next<\/button>/);
 assert.ok(next,"paged timeline must have a clickable Next control");
 vm.runInNewContext(next[1],{iina:{postMessage:(name,payload)=>h.handlers[name]?.(payload)}});
 await h.controller.waitForLoad();
 assert.ok(requests.some(x=>x.count===120&&x.startIndex===35&&x.pageSize===35));
 await h.controller.waitForPrefetch();
 assert.deepEqual(requests.filter(x=>x.count===120).map(x=>x.startIndex),
   [0,35,70,105],"all four pages pre-generated with no duplicate requests");
 const nextHtml=h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1];
 assert.match(nextHtml,/Page 2 \/ 4/);
 h.handlers["thumbnail-seek"](0);
 assert.equal(h.calls.find(x=>Array.isArray(x)&&x[0]==="seek")[1],2130);
 h.handlers["thumbnail-interval"](0);
 assert.equal(requests.at(-1).count,120);
});
test("overlay interval input posts minutes, persists preference and applies on reopened overlay",async()=>{
 const prefStore=new Map();
 const video="/Volumes/Media/Review/movie.mp4";
 const sent=[];
 const mockGenerate=async(_path,options)=>{
   sent.push(options.count);return [{time:10,image:"data:image/jpeg;base64,/9j/2Q=="}];
 };
 const h=make({cached:false,generated:mockGenerate,prefStore});
 h.core.status.duration=3600;
 h.setCurrent(video);
 await h.controller.toggle();await h.controller.waitForLoad();
 assert.equal(sent.at(-1),6);
 const html=h.calls.filter(c=>Array.isArray(c)&&c[0]==="content").at(-1)[1];
 const field=html.match(/<input data-clickable[^>]*onchange="([^"]+)"/);
 assert.ok(field,"minute interval must be an editable native overlay input");
 const messages=[];
 vm.runInNewContext(field[1],{
   value:"5",
   iina:{postMessage:(event,payload)=>{
     messages.push([event,payload]);h.handlers[event]?.(payload);
   }}
 });
 await h.controller.waitForLoad();
 assert.deepEqual(messages,[["thumbnail-interval",5]]);
 assert.equal(sent.at(-1),12);
 assert.equal(prefStore.get("thumbnail_interval_minutes"),5);
 h.handlers["thumbnail-interval"](1.5);
 h.handlers["thumbnail-interval"](61);
 assert.equal(sent.at(-1),12,"invalid settings must not trigger new generations");
 h.controller.close();
 const reopened=make({cached:false,generated:mockGenerate,prefStore});
 reopened.core.status.duration=3600;
 reopened.setCurrent(video);
 await reopened.controller.toggle();await reopened.controller.waitForLoad();
 assert.equal(sent.at(-1),12,"saved minutes per sample reused after restart");
});
test("switching away or closing Review removes previous overlay and blocks stale selection",async()=>{
 const h=make();
 await h.controller.toggle();
 await h.controller.waitForLoad();
 h.setCurrent(root+"/other.mp4");
 h.handlers["thumbnail-seek"](2);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
 assert.equal(h.calls.includes("hide"),true);
 assert.deepEqual(h.calls.at(-1),["clickable",false]);
 h.setCurrent(video);
 await h.controller.toggle();await h.controller.waitForLoad();
 h.controller.close();
 h.handlers["thumbnail-seek"](1);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
});
test("overlay control messages distinguish WebView Close and Refresh from external Review exit",async()=>{
 const h=make();
 await h.controller.toggle();await h.controller.waitForLoad();
 h.handlers["thumbnail-retry"]();
 await h.controller.waitForLoad();
 assert.ok(h.debug.some(x=>x.event==="thumbnail.control.received"&&x.data.reason==="refresh"));
 h.handlers["thumbnail-close"]();
 assert.ok(h.debug.some(x=>x.event==="thumbnail.control.received"&&x.data.reason==="close"));
 assert.ok(h.debug.some(x=>x.event==="thumbnail.closed"));
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
});
test("local native cache count follows duration and selected minutes, not fixed count",async()=>{
 const h=make();
 await h.controller.toggle();await h.controller.waitForLoad();
 const html=h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1];
 assert.match(html,/min.*sample/);
 assert.equal((html.match(/class="tile"/g)||[]).length,1,"40-second movie has one sample");
 h.core.status.duration=1800;
 h.handlers["thumbnail-interval"](5);
 await h.controller.waitForLoad();
 assert.equal((h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1].match(/class="tile"/g)||[]).length,6);
});
test("file-loaded pre-generates NAS timeline without opening overlay or seeking",async()=>{
 const source="/Volumes/Media/Review/early.mkv",requests=[];
 const h=make({cached:false,generated:async(path,opts)=>{
   requests.push({path,count:opts.count,pageSize:opts.pageSize});
   return [{time:10,image:"data:image/jpeg;base64,/9j/2Q=="}];
 }});
 h.setCurrent(source);h.core.status.duration=3600;
 h.controller.onFileLoaded();
 await h.controller.waitForPrefetch();
 assert.deepEqual(requests,[{path:source,count:6,pageSize:35}]);
 assert.equal(h.calls.includes("show"),false);
 assert.equal(h.calls.some(x=>Array.isArray(x)&&x[0]==="seek"),false);
 await h.controller.toggle();await h.controller.waitForLoad();
 assert.equal(requests.length,1,"pressing 0 must reuse completed prefetch");
 assert.match(h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1],/class="tile"/);
});
test("duplicate file-loaded for unchanged NAS video reuses prefetch instead of restarting it",async()=>{
  const source="/Volumes/Media/Review/reloaded.mkv",requests=[];
  const h=make({cached:false,generated:async(path,opts)=>{
    requests.push({path,index:opts.startIndex});
    return [{time:10,image:"data:image/jpeg;base64,/9j/2Q=="}];
  }});
  h.setCurrent(source);h.core.status.duration=600;
  h.controller.onFileLoaded();
  await h.controller.waitForPrefetch();
  h.controller.onFileLoaded();
  await h.controller.waitForPrefetch();
  assert.equal(requests.length,1,"same-file duplicate event must reuse prior page");
  await h.controller.toggle();await h.controller.waitForLoad();
  assert.equal(requests.length,1,"opening overlay must keep the reused page");
});
test("pressing 0 while prefetch is in flight does not generate the same page twice",async()=>{
 const source="/Volumes/Media/Review/slow.mkv",requests=[];
 let release;
 const h=make({cached:false,generated:(path,opts)=>{
   requests.push({path,opts});
   return new Promise(resolve=>{release=resolve;});
 }});
 h.setCurrent(source);h.core.status.duration=600;
 h.controller.onFileLoaded();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,1);
 await h.controller.toggle();
 assert.equal(requests.length,1);
 release([{time:60,image:"data:image/jpeg;base64,/9j/2Q=="}]);
 await h.controller.waitForLoad();
 assert.equal(requests.length,1);
 assert.match(h.calls.filter(x=>Array.isArray(x)&&x[0]==="content").at(-1)[1],/class="tile"/);
});
test("background prefetch cancels obsolete video before moving to later pages",async()=>{
 const old="/Volumes/Media/Review/old.mkv",calls=[];
 let resolveOld;
 const h=make({cached:false,generated:(path,opts)=>{
   calls.push({path,index:opts.startIndex,cancelled:opts.isCancelled});
   if(path===old)return new Promise(resolve=>{resolveOld=resolve;});
   return Promise.resolve([{time:10,image:"data:image/jpeg;base64,/9j/2Q=="}]);
 }});
 h.prefStore.set("thumbnail_interval_minutes",1);
 h.setCurrent(old);h.core.status.duration=5400;
 h.controller.onFileLoaded();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);
 h.setCurrent("/Volumes/Media/Review/new.mkv");
 h.core.status.duration=1200;
 h.controller.onFileLoaded();
 assert.equal(calls[0].cancelled(),true);
 resolveOld([]);
 await h.controller.waitForPrefetch();
 assert.equal(calls.filter(c=>c.path===old).length,1);
 assert.ok(calls.some(c=>c.path.endsWith("new.mkv")));
});
test("duration-not-ready at file-loaded defers NAS prefetch until duration event",async()=>{
 const calls=[];
 const h=make({cached:false,generated:async(_path,opts)=>{
   calls.push(opts.count);
   return [{time:5,image:"data:image/jpeg;base64,/9j/2Q=="}];
 }});
 h.setCurrent("/Volumes/Media/Review/late.mkv");
 h.core.status.duration=0;
 h.controller.onFileLoaded();
 await h.controller.waitForPrefetch();
 assert.equal(calls.length,0);
 h.core.status.duration=1800;
 await h.controller.prefetchCurrent();
 await h.controller.prefetchCurrent();
 assert.deepEqual(calls,[3],"repeated duration notifications must share one generation");
});
