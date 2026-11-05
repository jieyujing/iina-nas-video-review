"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const Path=require("node:path");
const root="/private/tmp/iina-nas-review-fixture-demo";
const nasRoot="/Volumes/Movies/Review";
const nasMount="//user@nas.local/Movies on /Volumes/Movies (smbfs, nodev, nosuid, mounted by user)";
const mockCacheRoot="/tmp/Library/Caches/com.colliderli.iina/nas-review-generated";
const mockCacheHash="0123456789abcdef0123456789abcdef";
function bootstrap({keyBindings={},iinaListLeadingSlash=false,store=new Map(),persistFail=false,failSyncOn=null,listOverride=null,mountOutput="",seekDoesNothing=false,pauseDoesNothing=false,withThumbnailOverlay=false,withMenu=false,autoFileLoaded=true,clock=null,experimentalDeleteMock=false,unloadPlayerOnDelete=false,failNextPlaybackOnDelete=false,rmFailureStatus=null,rmFailureStderr="",rmFailureButTargetMissing=false,staleExistsAfterDelete=false,stalePostcheckAll=false,failQueuePersistAfterRm=false,initialMediaExists=true,rmTargetPath=nasRoot+"/sample.mkv",nestedParentSymlink=false,simulateTimelineCache=false,cacheCleanupFails=false}={}){
 const source=fs.readFileSync(Path.join(__dirname,"../src/index.js"),"utf8")
   .replace(/import VIDEO_EXTENSIONS from 'video-extensions';/, "const VIDEO_EXTENSIONS=['mp4','mkv','avi','mov','webm'];")
   .replace(/import Path from "path-browserify"/,"const Path=require('node:path').posix;");
 const callbacks={},messages=[],opened=[],keyHandlers={},keyPriorities={},timers=[];
 // mpv key names are case-sensitive: k = plain k; K = Shift+k.
 const physicalHandlers={};
 function mpvKeyCode(code){
   const value=String(code);
   const shifted=value.match(/^Shift\+([a-z])$/i);
   return shifted?shifted[1].toUpperCase():value;
 }
 const playerWrites=[],menuItems=[],menuCalls=[],sidebarVisibility=[],mpvFlags={};
 const deletedPaths=[],alerts=[];let simulatedMediaExists=initialMediaExists,simulatedCanaryExists=false;
 const cachedFiles=new Map(),cacheRemoved=[];
 if(simulateTimelineCache){
   cachedFiles.set(mockCacheRoot+"/"+mockCacheHash+"-2-0.jpg",true);
   cachedFiles.set(mockCacheRoot+"/"+mockCacheHash+"-2-1.jpg",true);
   cachedFiles.set(mockCacheRoot+"/abcdefabcdefabcdefabcdefabcdefab-2-0.jpg",true);
 }
 let rmSucceeded=false;
 const simulatedCanary=nasRoot+"/.iina-nas-review-delete-canary.ABC12345";
 let fullscreen=false;
 const overlayCalls=[],overlayEvents={};
 let syncCount=0;
 const iina={
  menu:withMenu?{
   item(title,action,options){return {title,action,...options};},
   addItem(item){menuItems.push(item);menuCalls.push("add");},
   forceUpdate(){menuCalls.push("update");}
  }:undefined,
  overlay:withThumbnailOverlay?{
    simpleMode(){overlayCalls.push("simple");},
    setStyle(v){overlayCalls.push("style");},
    setContent(v){overlayCalls.push(["content",v]);},
    setClickable(v){overlayCalls.push(["clickable",v]);},
    show(){overlayCalls.push("show");},
    hide(){overlayCalls.push("hide");},
    onMessage(name,fn){overlayEvents[name]=fn;}
  }:undefined,
  sidebar:{loadFile(p){messages.push({kind:"loaded",p})},
    show(){sidebarVisibility.push("show");},
    onMessage(name,fn){callbacks[name]=fn;},
    postMessage(name,data){messages.push({kind:"message",name,data})},
    hide(){sidebarVisibility.push("hide");}},
  mpv:{getFlag(name){return mpvFlags[name]===true;}},
  event:{on(name,fn){callbacks["event:"+name]=fn}},
  input:{
    PRIORITY_HIGH:10,
    PRIORITY_LOW:0,
    normalizeKeyCode(code){return mpvKeyCode(code);},
    getAllKeyBindings(){return keyBindings;},
    onKeyDown(code,fn,priority){
      physicalHandlers[mpvKeyCode(code)]=fn;
      // Legacy direct invocation handles retained for existing tests only.
      keyHandlers[String(code).toUpperCase()]=fn;
      keyPriorities[String(code).toUpperCase()]=priority;
    }
  },
  console,preferences:{
    get(key){return store.get(key)||null;},
    set(key,value){
      if(persistFail || (failQueuePersistAfterRm&&rmSucceeded&&
        key==="nasSMBReviewCheckpointV1"))
        throw new Error("Simulated disk full");
      store.set(key,value);
    },
    sync(){
      syncCount++;
      if(persistFail || (failSyncOn!==null&&syncCount>=failSyncOn))
        throw new Error("Simulated sync failure");
    }
  },
  core:{
    window:{
      get fullscreen(){return fullscreen;},
      set fullscreen(v){fullscreen=!!v;}
    },
    status:{url:"",position:0,duration:100,paused:false},
    audio:{id:null,tracks:[]},subtitle:{id:null,tracks:[]},
    open(p){
      if(failNextPlaybackOnDelete && deletedPaths.length>0)
        throw new Error("SimulatedNextPlaybackFailure");
      opened.push(p);this.status.url="file://"+p;
      // Default legacy tests model a fully completed immediate IINA load.
      // Targeted race tests use autoFileLoaded:false to hold the asynchronous
      // file-loaded event while core.status.url already reflects the new item.
      if(autoFileLoaded)callbacks["event:iina.file-loaded"]?.();
    },
    pause(){playerWrites.push("pause");if(!pauseDoesNothing)this.status.paused=true;},
    resume(){playerWrites.push("resume");this.status.paused=false;},
    seekTo(s){playerWrites.push("seek");if(!seekDoesNothing)this.status.position=s;}
  },
  file:{
    exists(p){return cachedFiles.has(p)?true:p.startsWith(mockCacheRoot+"/")?false:
      p===simulatedCanary?simulatedCanaryExists:
      (staleExistsAfterDelete||stalePostcheckAll)&&!simulatedMediaExists?
        true:simulatedMediaExists;},
    delete(p){
      throw Error("DeleteAPIUnavailable"); // IINA API absence must not break test mode.
    },
    list(p){
      if(simulateTimelineCache&&p===mockCacheRoot)return [...cachedFiles.keys()]
        .map(path=>({filename:path.slice(mockCacheRoot.length+1),
          path:"/"+path.slice(mockCacheRoot.length+1),isDir:false}));
      const rows=listOverride?listOverride(p):p===root?[
        {filename:"video10.mp4",path:iinaListLeadingSlash?"/video10.mp4":"video10.mp4",isDir:false},
        {filename:"video2.mp4",path:iinaListLeadingSlash?"/video2.mp4":"video2.mp4",isDir:false}
      ]:[];
      return experimentalDeleteMock && (rmFailureButTargetMissing||staleExistsAfterDelete) &&
        !simulatedMediaExists && p===nasRoot?
        rows.filter(x=>x.filename!=="sample.mkv"):rows;
    }},
  utils:{chooseFile(){return Promise.resolve(null);},ask(message){alerts.push(String(message));return experimentalDeleteMock===true;},
    resolvePath(path){
      if(!simulateTimelineCache||path!=="~/Library/Caches/com.colliderli.iina/nas-review-generated")
        throw Error("MockCacheUnavailable");
      return mockCacheRoot;
    },
    exec(command,args){
      if(simulateTimelineCache&&command==="/sbin/md5")
        return Promise.resolve({status:0,stdout:mockCacheHash});
      if(simulateTimelineCache&&command==="/usr/bin/stat"&&args[1]==="%p"&&
         (args[2]===mockCacheRoot||String(args[2]).startsWith(mockCacheRoot+"/")))
        return Promise.resolve({status:0,stdout:args[2]===mockCacheRoot?"40755":"100644"});
      if(simulateTimelineCache&&command==="/bin/rm"&&
         String(args[1]).startsWith(mockCacheRoot+"/")){
        assert.deepEqual(Array.from(args).slice(0,1),["--"]);
        if(cacheCleanupFails)return Promise.resolve({status:1,stderr:"cache cleanup test failure"});
        cacheRemoved.push(String(args[1]));cachedFiles.delete(String(args[1]));
        return Promise.resolve({status:0,stderr:""});
      }
      if(experimentalDeleteMock && command==="/usr/bin/mktemp"){
        assert.deepEqual(Array.from(args),[nasRoot+"/.iina-nas-review-delete-canary.XXXXXXXX"]);
        simulatedCanaryExists=true;
        return Promise.resolve({status:0,stdout:simulatedCanary+"\n",stderr:""});
      }
      if(experimentalDeleteMock && command==="/bin/rm"&&String(args[1])===simulatedCanary){
        assert.deepEqual(Array.from(args),["--",simulatedCanary]);
        simulatedCanaryExists=false;
        return Promise.resolve({status:0,stdout:"",stderr:""});
      }
      if(experimentalDeleteMock && command==="/bin/rm"){
        assert.deepEqual(Array.from(args),["--",rmTargetPath]);
        if(rmFailureStatus!==null){
          if(rmFailureButTargetMissing)simulatedMediaExists=false;
          return Promise.resolve({status:rmFailureStatus,stdout:"",stderr:rmFailureStderr});
        }
        deletedPaths.push(String(args[1]));
        simulatedMediaExists=false;
        rmSucceeded=true;
        if(unloadPlayerOnDelete)iina.core.status.url="";
        return Promise.resolve({status:0,stdout:"",stderr:""});
      }
      if(command==="/usr/bin/stat" &&
         ["/Volumes/Movies",nasRoot].includes(String(args[2]))){
        return Promise.resolve({status:0,stdout:"40755|18|23|12|1000\n",stderr:""});
      }
      if(experimentalDeleteMock && command==="/usr/bin/stat"){
        const path=String(args[2]);
        if((rmFailureButTargetMissing||staleExistsAfterDelete) &&
           !stalePostcheckAll && !simulatedMediaExists &&
           path===nasRoot+"/sample.mkv")
          return Promise.resolve({status:1,stdout:"",stderr:"No such file or directory"});
        const nestedParent=nasRoot+"/Season 1";
        const mode=path===rmTargetPath||path===simulatedCanary?"100644":
          nestedParentSymlink&&path===nestedParent?"120777":"40755";
        return Promise.resolve({status:0,stdout:mode+"|18|23|12|1000\n",stderr:""});
      }
      assert.equal(command,"/sbin/mount");
      assert.deepEqual(Array.from(args),[]);
      return Promise.resolve({status:0,stdout:mountOutput,stderr:""});
    }}
 };
 const TestDate=clock?class extends Date{
   static now(){return Date.now()+clock.offsetMs;}
 }:Date;
 vm.runInNewContext(source,{iina,Date:TestDate,require:(name)=>
   name==="./review-core.cjs"?require("../src/review-core.cjs"):
   name==="./debug-log.cjs"?require("../src/debug-log.cjs"):
    name==="./review-session.cjs"?require("../src/review-session.cjs"):
    name==="./smb-review-checkpoint.cjs"?require("../src/smb-review-checkpoint.cjs"):
    name==="./nas-source.cjs"?require("../src/nas-source.cjs"):
    name==="./review-scan.cjs"?require("../src/review-scan.cjs"):
    name==="./delete-coordinator.cjs"?require("../src/delete-coordinator.cjs"):
    name==="./experimental-delete.cjs"?require("../src/experimental-delete.cjs"):
    name==="./delete-canary.cjs"?require("../src/delete-canary.cjs"):
   name==="./thumbnail-overlay.cjs"?require("../src/thumbnail-overlay.cjs"):
   name==="./cache-cleanup-queue.cjs"?require("../src/cache-cleanup-queue.cjs"):
   name==="./thumbnail-generator.cjs"?require("../src/thumbnail-generator.cjs"):require(name),
   setInterval(fn,ms){timers.push({fn,ms,kind:"interval"});return timers.length;},
   clearInterval(){},setTimeout(fn,ms){timers.push({fn,ms,kind:"timeout"});return timers.length;},
   clearTimeout(){}});
 callbacks["event:iina.window-loaded"]();
 return {callbacks,messages,opened,keyHandlers,keyPriorities,core:iina.core,store,timers,overlayCalls,overlayEvents,playerWrites,menuItems,menuCalls,sidebarVisibility,mpvFlags,deletedPaths,alerts,cachedFiles,cacheRemoved,
   physicalKeyDown:(key,data={isRepeat:false})=>physicalHandlers[mpvKeyCode(key)]?.(data)??false,
   physicalRegisteredKeys:()=>Object.keys(physicalHandlers)
 };
}
function reviewState(h){return h.messages.filter(x=>x.name==="review-state").at(-1).data;}
function flushTimeouts(h,max=25){
 for(let i=0;i<max;i++){
  const timer=h.timers.find(x=>x.kind==="timeout"&&!x.ran);
  if(!timer)return;
  timer.ran=true;
  timer.fn();
 }
 throw new Error("Restoration timer loop exceeded the deterministic test limit");
}
test("File Viewer baseline folder navigation and player bridge remain present",()=>{
 const h=bootstrap();
 for(const name of ["get-files","open-file","choose-folder","review-start","review-keep"])assert.equal(typeof h.callbacks[name],"function");
 assert.equal(h.messages.find(x=>x.kind==="loaded").p,"dist/ui/sidebar/index.html");
 h.callbacks["get-files"]({path:root,currentPath:root,tabId:1});
 const response=h.messages.find(x=>x.name==="files-list");
 assert.ok(response);
 assert.equal(response.data.files[0].filename,"video2.mp4");
 h.callbacks["open-file"]({path:root+"/video2.mp4"});
 assert.equal(h.opened.at(-1),root+"/video2.mp4");
});
test("IINA sidebar stays open after window/file load and manual video open",()=>{
 const h=bootstrap();
 assert.ok(h.sidebarVisibility.includes("show"));
 h.callbacks["event:iina.file-loaded"]();
 h.callbacks["open-file"]({path:root+"/video2.mp4"});
 assert.equal(h.sidebarVisibility.at(-1),"show");
 assert.equal(h.sidebarVisibility.includes("hide"),false);
});
test("fullscreen change re-shows plugin sidebar after native fullscreen hide",()=>{
 const h=bootstrap();
 const baseline=h.sidebarVisibility.filter(x=>x==="show").length;
 h.core.window.fullscreen=true;
 h.callbacks["event:iina.window-fs.changed"]?.(true);
 h.sidebarVisibility.push("native-fullscreen-auto-hide");
 flushTimeouts(h);
 assert.equal(h.sidebarVisibility.at(-1),"show",
   "fullscreen transition should end with plugin sidebar shown");
 assert.ok(h.sidebarVisibility.filter(x=>x==="show").length>baseline);
});
test("obsolete fullscreen-entry timers cannot override a newer fullscreen-exit event",()=>{
 const h=bootstrap();
 h.core.window.fullscreen=true;
 h.callbacks["event:iina.window-fs.changed"]?.(true);
 h.core.window.fullscreen=false;
 h.callbacks["event:iina.window-fs.changed"]?.(false);
 const count=h.sidebarVisibility.filter(x=>x==="show").length;
 flushTimeouts(h);
 assert.equal(h.sidebarVisibility.filter(x=>x==="show").length,count,
   "old delayed fullscreen entry callbacks must not reopen after exit");
});
test("click pending Review video selects without KEEP-ing skipped videos; next wraps",()=>{
 const h=bootstrap({listOverride:()=>["a.mp4","b.mp4","c.mp4"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }))});
 h.callbacks["review-start"]({path:root});
 assert.equal(h.callbacks["review-play"]({position:2}),true);
 assert.equal(reviewState(h).cursor,2);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["PENDING","PENDING","PENDING"]);
 assert.equal(h.opened.at(-1),root+"/c.mp4");
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).cursor,0);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["PENDING","PENDING","KEEP"]);
 const stored=JSON.parse(h.store.get("nasReviewCheckpointV1"));
 assert.equal(stored.cursor,0);
 assert.equal(stored.entries[2].status,"KEEP");
});
test("completed Review replays a KEEP item without changing saved progress",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
 const before=h.store.get("nasReviewCheckpointV1");
 assert.equal(h.callbacks["review-play"]({position:0}),true);
 assert.equal(h.opened.at(-1),root+"/video2.mp4");
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(h.store.get("nasReviewCheckpointV1"),before);
 assert.equal(h.callbacks["review-play"]({position:999}),false);
});
test("EOF on matching loaded video auto KEEP; duplicate EOF and stop cannot skip",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=100;
 h.mpvFlags["eof-reached"]=true;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 assert.equal(reviewState(h).cursor,0,"seek straight to EOF is not evidence of natural playback");
 h.mpvFlags["eof-reached"]=false;
 h.core.status.position=98;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=95;
 h.mpvFlags["eof-reached"]=false;
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 assert.equal(reviewState(h).cursor,0);
 h.core.status.position=100;
 h.mpvFlags["eof-reached"]=true;
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.({reason:"stop"});
 assert.equal(reviewState(h).cursor,1);
 h.callbacks["event:iina.file-loaded"]();
 h.mpvFlags["eof-reached"]=false;
 h.core.status.position=98;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=100;
 h.mpvFlags["eof-reached"]=true;
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("natural end-file EOF after IINA clears URL and position still marks completed item KEEP once",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=96;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=98;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(h.opened.at(-1),root+"/video10.mp4");
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,1,"duplicate EOF cannot KEEP the next video");
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=100;
 h.core.status.duration=100;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).cursor,1,
   "late EOF from prior file cannot skip a newly loaded Review video");
 assert.equal(reviewState(h).keptCount,1);
});
test("stale EOF after foreign media and seek-to-end do not mark a Review item KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=100;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.mpvFlags["eof-reached"]=true;
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.({reason:"stop"});
 h.callbacks["event:mpv.end-file"]?.({reason:"error"});
 assert.equal(reviewState(h).keptCount,0);
 h.core.status.url="file://"+root+"/foreign.mp4";
 h.callbacks["event:iina.file-loaded"]?.();
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,0);
});
test("plain physical k and d reach an active SMB Review via actual mpv case-sensitive key names",async()=>{
 const h=bootstrap({withMenu:true,mountOutput:nasMount,autoFileLoaded:false,
   listOverride:()=>[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false}
   ]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.physicalKeyDown("d"),true,"plain d must reach the single-file delete coordinator");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.messages.some(x=>x.name==="debug-event"&&x.data.event==="review.delete.rejected"
   &&x.data.data.reason==="SOURCE_UNAVAILABLE"),true,
   "unverified file stat must refuse without touching media");
 assert.equal(h.physicalKeyDown("k"),true,"plain k must perform KEEP");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.opened.length,2);
 assert.equal(h.physicalKeyDown("k"),false,"new item still loading must not be skipped");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.physicalKeyDown("K"),false,"Shift+K must not accidentally trigger plain k");
 assert.equal(h.physicalKeyDown("D"),false,"Shift+D must not accidentally trigger plain d");
 assert.equal(reviewState(h).cursor,1,"shifted letter presses must not mutate queue");
 assert.equal(h.physicalKeyDown("k"),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(h.physicalKeyDown("k"),false,"outside Review plain k must pass through");
 assert.deepEqual(h.physicalRegisteredKeys().sort(),["d","k"].sort());
});
test("actual IINA Swift row shape: File Viewer lists 2 and Review queues 2 instead of zero",()=>{
 const h=bootstrap({iinaListLeadingSlash:true});
 h.callbacks["get-files"]({path:root,currentPath:root,tabId:1});
 const listing=h.messages.find(x=>x.name==="files-list");
 assert.equal(listing.data.files.length,2);
 h.callbacks["review-start"]({path:root});
 assert.equal(reviewState(h).entries.length,2,"review queue must match browse listing");
 assert.equal(reviewState(h).active,true);
 const scan=h.messages.filter(x=>x.name==="debug-event").map(x=>x.data)
   .find(event=>event.event==="review.scan.summary");
 assert.equal(scan.data.total,2);
 assert.equal(scan.data.accepted,2);
 assert.equal(h.opened.at(-1),root+"/video2.mp4");
 assert.equal(h.keyHandlers.K({isRepeat:false}),true);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(h.opened.at(-1),root+"/video10.mp4");
});
test("KEEP is blocked until IINA confirms each newly opened Review video",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 const startSaved=h.store.get("nasReviewCheckpointV1");
 assert.equal(h.callbacks["review-keep"]({}),false,"file URL alone is not a loaded video");
 assert.equal(h.store.get("nasReviewCheckpointV1"),startSaved);
 assert.equal(reviewState(h).cursor,0);
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).cursor,1);
 const saved=h.store.get("nasReviewCheckpointV1");
 assert.equal(h.callbacks["review-keep"]({}),false,"rapid second KEEP must not skip next video");
 assert.equal(h.store.get("nasReviewCheckpointV1"),saved);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(h.opened.length,2);
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("rapid keyboard KEEP cannot advance before the new file-loaded event",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.keyHandlers.K({isRepeat:false}),true);
 assert.equal(h.keyHandlers.K({isRepeat:false}),false);
 assert.equal(reviewState(h).cursor,1);
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.keyHandlers.K({isRepeat:false}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("unrelated file-loaded never unlocks KEEP; explicit Reopen can retry a stalled load",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 assert.equal(reviewState(h).playbackStatus,"awaiting_file_loaded");
 assert.equal(reviewState(h).playbackMatched,false);
 h.core.status.url="file:///private/tmp/unrelated.mp4";
 h.callbacks["event:iina.file-loaded"]();
 const saved=h.store.get("nasReviewCheckpointV1");
 assert.equal(h.callbacks["review-keep"]({}),false);
 assert.equal(h.store.get("nasReviewCheckpointV1"),saved);
 assert.equal(reviewState(h).cursor,0);
 assert.equal(reviewState(h).playbackMatched,false);
 h.core.status.url="file://"+root+"/video2.mp4";
 assert.equal(h.callbacks["review-keep"]({}),false,
   "matching URL alone must not bypass a pending file-loaded barrier");
 assert.equal(h.callbacks["review-reopen"]({}),true,
   "explicit user retry remains possible after a stalled load");
 assert.equal(h.opened.length,2);
 assert.equal(h.store.get("nasReviewCheckpointV1"),saved,
   "Reopen must not rewrite queue progress");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackStatus,"exact");
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.callbacks["review-keep"]({}),true);
});
test("Review Start and Keep + Next execute using original File Viewer message bridge",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 assert.deepEqual(h.opened,[root+"/video2.mp4"]);
 assert.equal(reviewState(h).entries.length,2);
 h.callbacks["review-keep"]({});
 assert.deepEqual(h.opened,[root+"/video2.mp4",root+"/video10.mp4"]);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 h.callbacks["review-keep"]({});
 assert.equal(reviewState(h).active,false);
 assert.equal(h.opened.length,2);
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(reviewState(h).error,"");
 assert.equal(reviewState(h).entries.filter(e=>e.status==="KEEP").length,2);
 assert.ok(h.messages.some(x=>x.name==="debug-event"&&x.data.event==="review.completed"));
});
test("thumbnail overlay and 0 hotkey work only for managed local Review and close on playback change",async()=>{
 const h=bootstrap({withThumbnailOverlay:true});
 assert.equal(typeof h.callbacks["review-thumbnails-toggle"],"function");
 assert.equal(h.keyPriorities["0"],10);
 assert.equal(h.keyHandlers["0"]({isRepeat:false}),false);
 h.callbacks["review-start"]({path:root});
 assert.equal(h.keyHandlers["0"]({isRepeat:false}),true);
 assert.ok(h.overlayCalls.includes("show"));
 await Promise.resolve();await Promise.resolve();
 assert.ok(h.messages.some(m=>m.name==="debug-event" && m.data.event==="thumbnail.opened"));
 h.callbacks["event:iina.file-loaded"]();
 assert.ok(h.overlayCalls.includes("hide"));
 h.callbacks["review-exit"]({});
 assert.equal(h.keyHandlers["0"]({isRepeat:false}),false);
});
test("unmounted NAS review-start is refused before filesystem access",async()=>{
 const h=bootstrap();
 await h.callbacks["review-start"]({path:"/Volumes/NAS/Videos"});
 assert.equal(h.opened.length,0);
 assert.match(reviewState(h).error,/SMB|mount|Finder/i);
 assert.equal(h.store.size,0);
});
test("verified Finder SMB mount allows NAS Review with durable KEEP",async()=>{
 let scanned=0;
 const h=bootstrap({mountOutput:nasMount,listOverride:(path)=>{
   assert.equal(path,nasRoot);
   scanned++;
   return [{filename:"a.mp4",path:"/a.mp4",isDir:false},
           {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 },autoFileLoaded:false});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(scanned,1);
 assert.equal(h.opened[0],nasRoot+"/a.mp4");
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).nasReadOnly,true);
 assert.equal(h.store.has("nasReviewCheckpointV1"),false,
   "SMB checkpoint must never overwrite the local fixture checkpoint");
 assert.equal(h.store.has("nasSMBReviewCheckpointV1"),true);
 assert.equal(h.callbacks["review-keep"]({}),false,"keep waits for file-loaded");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.store.size,1);
 assert.equal(h.opened.at(-1),nasRoot+"/b.mp4");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal((await h.callbacks["review-delete"]({})).reason,"SOURCE_UNAVAILABLE",
   "unverified target file metadata must fail closed");
 assert.equal(h.store.size,1);
});
test("SMB KEEP is saved durably and can Resume after plugin reload without autoplay",async()=>{
 const store=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
             {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const original=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?rows:[],autoFileLoaded:false});
 await original.callbacks["review-start"]({path:nasRoot});
 original.callbacks["event:iina.file-loaded"]();
 assert.equal(original.callbacks["review-keep"]({}),true);
 assert.ok(store.has("nasSMBReviewCheckpointV1"),
   "SMB KEEP must persist before opening the next video");
 const restarted=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?rows:[]});
 await restarted.callbacks["review-ready"]();
 assert.equal(reviewState(restarted).resumeAvailable,true);
 assert.equal(reviewState(restarted).resumeKept,1);
 assert.equal(restarted.opened.length,0);
 await restarted.callbacks["review-resume"]({path:nasRoot});
 assert.equal(reviewState(restarted).keptCount,1);
 assert.equal(reviewState(restarted).cursor,1);
 assert.equal(restarted.opened.length,0,"Resume must not auto-play or seek");
});
test("IINA startup automatically resumes saved SMB Review without bookmark, playback or deletion",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const first=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await first.callbacks["review-start"]({path:nasRoot});
 assert.equal(first.callbacks["review-keep"]({}),true);
 const restored=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 assert.equal(restored.opened.length,0);
 await restored.callbacks["review-ready"]();
 const state=reviewState(restored);
 assert.equal(state.active,true);
 assert.equal(state.nasReadOnly,true);
 assert.equal(state.keptCount,1);
 assert.equal(state.cursor,1);
 assert.equal(state.root,nasRoot);
 assert.deepEqual(restored.opened,[],"restoring Review may not change IINA playback");
 assert.equal(restored.deletedPaths.length,0);
 const saved=store.get("nasSMBReviewCheckpointV1");
 await restored.callbacks["review-ready"]();
 assert.equal(store.get("nasSMBReviewCheckpointV1"),saved,
   "duplicate sidebar startup must not repeatedly restore or overwrite checkpoint");
});
test("automatic SMB startup refuses changed mount and retains checkpoint for later retry",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const source=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await source.callbacks["review-start"]({path:nasRoot});
 assert.equal(source.callbacks["review-keep"]({}),true);
 const snapshot=store.get("nasSMBReviewCheckpointV1");
 const restarted=bootstrap({store,
   mountOutput:"//someone@other.example/Movies on /Volumes/Movies (smbfs, nodev)",
   listOverride:p=>p===nasRoot?listed:[]});
 await restarted.callbacks["review-ready"]();
 assert.equal(reviewState(restarted).active,false);
 assert.equal(reviewState(restarted).resumeAvailable,true);
 assert.match(reviewState(restarted).error,/Resume blocked/i);
 assert.deepEqual(restarted.opened,[]);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),snapshot);
});
test("startup marks missing SMB media DELETED and keeps previous KEEP, without executing rm",async()=>{
 const store=new Map();
 const oldRows=["a.mp4","b.mp4","c.mp4"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const source=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?oldRows:[]});
 await source.callbacks["review-start"]({path:nasRoot});
 assert.equal(source.callbacks["review-keep"]({}),true);
 const originalCheckpoint=store.get("nasSMBReviewCheckpointV1");
 const restored=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?[oldRows[0],oldRows[2]]:[]});
 await restored.callbacks["review-ready"]();
 const state=reviewState(restored);
 assert.equal(state.active,true);
 assert.equal(state.keptCount,1);
 assert.equal(state.missingCount,0);
 assert.equal(state.deletedCount,1);
 assert.equal(state.cursor,2);
 assert.equal(state.entries[0].status,"KEEP");
 assert.equal(state.entries[1].status,"DELETED");
 assert.equal(state.entries[2].status,"PENDING");
 assert.deepEqual(restored.opened,[],"startup must not auto-open media");
 assert.deepEqual(restored.deletedPaths,[]);
 assert.equal(store.get("nasSMBReviewRecoveryBackupV1"),originalCheckpoint,
   "original checkpoint must be preserved before recovery");
 assert.equal(restored.callbacks["review-play"]({position:1}),false);
 assert.deepEqual(restored.opened,[]);
 const reloaded=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?[oldRows[0],oldRows[2]]:[]});
 await reloaded.callbacks["review-ready"]();
 assert.equal(reviewState(reloaded).keptCount,1);
 assert.equal(reviewState(reloaded).cursor,2);
 assert.equal(reviewState(reloaded).entries[1].status,"DELETED");
});
test("SMB resume automatically resolves old UNKNOWN for an absent same-cursor file, no rm or playback",async()=>{
 const store=new Map();
 const oldRows=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const original=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,rmFailureStatus:1,
   rmFailureButTargetMissing:true,rmFailureStderr:"Input/output error",
   listOverride:p=>p===nasRoot?oldRows:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal((await original.callbacks["review-delete"]({})).status,"UNKNOWN");
 const oldRaw=store.get("nasExperimentalDeleteJournalV1");
 const saved=store.get("nasSMBReviewCheckpointV1");
 const restarted=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,rmFailureButTargetMissing:true,
   initialMediaExists:false,
   listOverride:p=>p===nasRoot?oldRows:[]});
 await restarted.callbacks["review-ready"]();
 const state=reviewState(restarted);
 assert.equal(state.active,true);
 assert.equal(state.cursor,1);
 assert.equal(state.entries[0].status,"DELETED");
 assert.equal(state.entries[1].status,"PENDING");
 assert.equal(state.deletedCount,1);
 assert.equal(state.deleteRecoveryPending,false);
 assert.equal(store.get("nasSMBReviewRecoveryBackupV1"),saved);
 assert.equal(store.get("nasDeleteUnknownRecoveryBackupV1"),oldRaw);
 assert.equal(JSON.parse(store.get("nasExperimentalDeleteJournalV1")).state,
   "RECOVERED_ABSENT");
 assert.deepEqual(restarted.deletedPaths,[]);
 assert.deepEqual(restarted.opened,[]);
});
test("SMB resume keeps UNKNOWN locked when prior target exists on the verified share",async()=>{
 const store=new Map();
 const listed=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const original=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,rmFailureStatus:1,rmFailureButTargetMissing:true,
   listOverride:p=>p===nasRoot?listed:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal((await original.callbacks["review-delete"]({})).status,"UNKNOWN");
 const oldRaw=store.get("nasExperimentalDeleteJournalV1");
 const restarted=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,initialMediaExists:true,
   listOverride:p=>p===nasRoot?listed:[]});
 await restarted.callbacks["review-ready"]();
 assert.equal(reviewState(restarted).active,true);
 assert.equal(reviewState(restarted).deleteRecoveryPending,true);
 assert.equal(reviewState(restarted).cursor,0);
 assert.equal(reviewState(restarted).entries[0].status,"PENDING");
 assert.equal(store.get("nasExperimentalDeleteJournalV1"),oldRaw);
 assert.deepEqual(restarted.deletedPaths,[]);
 assert.deepEqual(restarted.opened,[]);
});
test("closing Review during asynchronous auto-resume cannot resurrect the old queue",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const original=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal(original.callbacks["review-keep"]({}),true);
 const before=store.get("nasSMBReviewCheckpointV1");
 const restarted=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 const restoring=restarted.callbacks["review-ready"]();
 restarted.callbacks["review-exit"]({});
 await restoring;
 assert.equal(reviewState(restarted).active,false);
 assert.deepEqual(restarted.opened,[]);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),before,
   "exit during verification must not rewrite saved progress");
});
test("unexpected SMB inventory blocks auto-resume but can be retried after restoring folder",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const original=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal(original.callbacks["review-keep"]({}),true);
 const old=store.get("nasSMBReviewCheckpointV1");
 let mountOk=false;
 const recovered=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?mountOk?listed:[
     ...listed,{filename:"unexpected.mp4",path:"/unexpected.mp4",isDir:false}
   ]:[]});
 await recovered.callbacks["review-ready"]();
 assert.equal(reviewState(recovered).active,false);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),old);
 mountOk=true;
 await recovered.callbacks["review-resume"]({path:nasRoot});
 assert.equal(reviewState(recovered).active,true);
 assert.equal(reviewState(recovered).keptCount,1);
 assert.deepEqual(recovered.opened,[]);
});
test("automatic startup restores local test checkpoint with no playback mutation",async()=>{
 const store=new Map();
 const original=bootstrap({store});
 original.callbacks["review-start"]({path:root});
 assert.equal(original.callbacks["review-keep"]({}),true);
 const newInstance=bootstrap({store});
 await newInstance.callbacks["review-ready"]();
 assert.equal(reviewState(newInstance).active,true);
 assert.equal(reviewState(newInstance).keptCount,1);
 assert.equal(reviewState(newInstance).cursor,1);
 assert.deepEqual(newInstance.opened,[]);
});
test("SMB Resume refuses an unexpected added video without overwriting saved KEEP",async()=>{
 const store=new Map();
 const original=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false}
   ]:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal(original.callbacks["review-keep"]({}),true);
 const before=store.get("nasSMBReviewCheckpointV1");
 const restarted=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false},
     {filename:"unexpected.mp4",path:"/unexpected.mp4",isDir:false}
   ]:[]});
 await restarted.callbacks["review-ready"]();
 await restarted.callbacks["review-resume"]({path:nasRoot});
 assert.equal(reviewState(restarted).active,false);
 assert.equal(reviewState(restarted).resumeAvailable,true);
 assert.match(reviewState(restarted).error,/SMB Resume blocked/);
 assert.equal(restarted.opened.length,0);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),before);
});
test("SMB Resume refuses a reconnected different share and never opens video",async()=>{
 const store=new Map();
 const original=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false}
   ]:[]});
 await original.callbacks["review-start"]({path:nasRoot});
 assert.equal(original.callbacks["review-keep"]({}),true);
 const before=store.get("nasSMBReviewCheckpointV1");
 const altered="//other@another.example/Movies on /Volumes/Movies (smbfs, nodev, nosuid)";
 const restarted=bootstrap({store,mountOutput:altered,
   listOverride:p=>p===nasRoot?[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false}
   ]:[]});
 await restarted.callbacks["review-resume"]({path:nasRoot});
 assert.equal(restarted.opened.length,0);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),before);
 assert.equal(reviewState(restarted).resumeAvailable,true);
});
test("SMB Review D directly requests an individual confirmation, without mode toggle or canary",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(reviewState(h).deletionSupported,true);
 assert.equal(h.callbacks["review-delete-test-mode"],undefined);
 assert.equal(h.callbacks["review-delete-canary-test"],undefined);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
 assert.equal(h.alerts.length,1);
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(h.store.has("nasExperimentalDeleteJournalV1"),true);
 h.callbacks["review-exit"]({});
 assert.equal(reviewState(h).deletionSupported,false);
});
test("nonzero rm status with unchanged file produces a native error dialog, not UNKNOWN",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureStatus:1,rmFailureStderr:"rm: /Volumes/Movies/Review/sample.mkv: Permission denied\n",
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"COMMAND_FAILED");
 assert.equal(result.exitCode,1);
 assert.equal(h.alerts.length,2,"confirm first, then show the native failure dialog");
 assert.match(h.alerts[1],/Permission denied/);
 assert.match(h.alerts[1],/exited with code 1/i);
 assert.doesNotMatch(h.alerts[1],/\/Volumes\/Movies\/Review/);
 assert.equal(reviewState(h).deletedCount,0);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,"CONFIRMED_FAILED");
 assert.deepEqual(h.deletedPaths,[]);
});
test("nonzero rm with uncertain target state shows system error and preserves UNKNOWN",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureStatus:1,rmFailureButTargetMissing:true,
   rmFailureStderr:"rm: /Volumes/Movies/Review/sample.mkv: Input/output error\n",
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"UNKNOWN");
 assert.equal(result.commandFailed,true);
 assert.equal(result.exitCode,1);
 assert.equal(h.alerts.length,2);
 assert.match(h.alerts.at(-1),/Input\/output error/);
 assert.match(h.alerts.at(-1),/could NOT be verified/i);
 assert.doesNotMatch(h.alerts.at(-1),/\/Volumes\/Movies\/Review/);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,"UNKNOWN");
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 assert.deepEqual(h.deletedPaths,[]);
});
test("successful rm + stale file.exists is verified by fresh stat and folder listing, not UNKNOWN",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   staleExistsAfterDelete:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(reviewState(h).entries[0].status,"DELETED");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,
   "RM_EXIT_ZERO");
 assert.equal(h.deletedPaths.length,1,"exactly one rm is invoked");
});
test("real D flow cleans only the deleted video's JPEG cache after rm exit 0",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   simulateTimelineCache:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.deletedPaths.length,1,"only one NAS video rm");
 assert.equal(h.cacheRemoved.length,2,"remove only the target cache key's JPEGs");
 assert.ok(h.cacheRemoved.every(p=>p.includes(mockCacheHash)));
 assert.equal(h.cachedFiles.size,1,"another video's cache must survive");
 assert.equal(JSON.parse(h.store.get("nasTimelineCacheCleanupQueueV1")).length,0);
 assert.equal(reviewState(h).cursor,1);
});
test("failed rm does not schedule any cache JPEG deletion",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   simulateTimelineCache:true,rmFailureStatus:1,rmFailureStderr:"Permission denied",
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal((await h.callbacks["review-delete"]({})).status,"COMMAND_FAILED");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.cacheRemoved.length,0);
 assert.equal(h.cachedFiles.size,3);
 assert.equal(h.store.has("nasTimelineCacheCleanupQueueV1"),false);
});
test("cache cleanup failure retains a restart job without changing DELETED or Review cursor",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   simulateTimelineCache:true,cacheCleanupFails:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal((await h.callbacks["review-delete"]({})).status,"VERIFIED_DELETED");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.cacheRemoved.length,0);
 assert.equal(JSON.parse(h.store.get("nasTimelineCacheCleanupQueueV1")).length,1);
});
test("rm exit 0 wins over all stale SMB postchecks and advances Review once",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   stalePostcheckAll:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.deletedPaths.length,1);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,
   "RM_EXIT_ZERO");
 assert.equal(h.opened.length,2,"automatically open only the next pending video");
});
test("rm exit 0 with Review checkpoint write failure reports successful rm and unsaved progress",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   failQueuePersistAfterRm:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(result.nextPlayback,"PROGRESS_SAVE_FAILED");
 assert.match(reviewState(h).error,/rm succeeded.*checkpoint.*could NOT be saved/i);
 assert.equal(reviewState(h).cursor,0);
 assert.equal(reviewState(h).deletedCount,0);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,
   "RM_EXIT_ZERO");
 assert.equal(h.deletedPaths.length,1);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"ALREADY_DELETED");
 assert.equal(h.deletedPaths.length,1);
});
test("UNKNOWN with same SMB target now absent can be marked DELETED without rm retry",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureStatus:1,rmFailureButTargetMissing:true,
   rmFailureStderr:"Input/output error",
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"UNKNOWN");
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 const originalKeeps=reviewState(h).keptCount;
 const beforeRm=h.deletedPaths.length;
 const resolution=await h.callbacks["review-delete-test-acknowledge-unknown"]({});
 assert.equal(resolution.status,"ACKNOWLEDGED");
 assert.equal(resolution.missingSkipped,true);
 assert.equal(reviewState(h).entries[0].status,"DELETED");
 assert.equal(reviewState(h).entries[1].status,"PENDING");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).keptCount,originalKeeps);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(h.opened.length,1,"reconciliation must not auto-open another video");
 assert.equal(h.deletedPaths.length,beforeRm,"reconciliation must never rerun rm");
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,
   "MANUALLY_RECONCILED");
});
test("real-media unlink may unload IINA; confirmed path absence still marks DELETED and opens next PENDING",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   unloadPlayerOnDelete:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.opened[0],nasRoot+"/sample.mkv");
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).entries[0].status,"DELETED");
 assert.equal(reviewState(h).entries[1].status,"PENDING");
 assert.equal(reviewState(h).cursor,1);
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
 assert.deepEqual(h.opened,[nasRoot+"/sample.mkv",nasRoot+"/z-next.mkv"]);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,"RM_EXIT_ZERO");
 assert.equal(reviewState(h).deleteRecoveryPending,false);
});
test("next media playback failure must not relabel a verified deletion UNKNOWN",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   unloadPlayerOnDelete:true,failNextPlaybackOnDelete:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(result.nextPlayback,"FAILED");
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.match(reviewState(h).error,/rm succeeded.*next.*failed/i,
   "must display a recovery instruction when next playback fails");
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,"RM_EXIT_ZERO");
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
});
test("persisted UNKNOWN is surfaced as an explicit recovery state before repeated D",async()=>{
 const store=new Map([["nasExperimentalDeleteJournalV1",JSON.stringify({
   id:"old-unknown",state:"UNKNOWN",queueId:"old-session",cursor:0,
   mountIdentity:"old-mount",rootIdentity:"old-root",fileIdentity:"old-file"
 })]]);
 const h=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"UNRESOLVED_OPERATION");
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 assert.match(reviewState(h).error,/Reconcile previous UNKNOWN/i);
 assert.deepEqual(h.deletedPaths,[]);
});
test("old UNKNOWN remains locked with no canary handler",async()=>{
 const legacy={id:"prior-media",state:"UNKNOWN",queueId:"prior-session",cursor:1,
   mountIdentity:"share-previous",rootIdentity:"root-previous",fileIdentity:"old-file"};
 const store=new Map([["nasExperimentalDeleteJournalV1",JSON.stringify(legacy)]]);
 const h=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-delete-test-mode"],undefined);
 assert.equal(h.callbacks["review-delete-canary-test"],undefined);
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"UNRESOLVED_OPERATION");
 assert.equal(JSON.parse(store.get("nasExperimentalDeleteJournalV1")).state,"UNKNOWN");
 assert.equal(store.has("nasExperimentalDeleteCanaryJournalV1"),false);
 assert.equal(reviewState(h).deleteRecoveryPending,true);
 assert.deepEqual(h.deletedPaths,[],"never delete a user media path during canary test");
});
test("recursive SMB Review D deletes the currently playing nested video, never its directory",async()=>{
 const path=nasRoot+"/Season 1/sample.mkv";
 const listing={
   [nasRoot]:[{filename:"Season 1",path:"/Season 1",isDir:true}],
   [nasRoot+"/Season 1"]:[{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]
 };
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmTargetPath:path,listOverride:p=>listing[p]||[]});
 await h.callbacks["review-start"]({path:nasRoot,recursive:true});
 assert.equal(reviewState(h).recursive,true);
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(reviewState(h).deletionSupported,true);
 assert.equal(h.opened[0],path);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.deepEqual(h.deletedPaths,[path],"rm must receive only the nested video path");
 assert.equal(h.alerts.length,1);
 assert.equal(reviewState(h).deletedCount,1);
});
test("recursive SMB Review refuses symlinked intermediate directories before rm",async()=>{
 const path=nasRoot+"/Season 1/sample.mkv";
 const listing={
   [nasRoot]:[{filename:"Season 1",path:"/Season 1",isDir:true}],
   [nasRoot+"/Season 1"]:[{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]
 };
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmTargetPath:path,nestedParentSymlink:true,listOverride:p=>listing[p]||[]});
 await h.callbacks["review-start"]({path:nasRoot,recursive:true});
 assert.equal(reviewState(h).playbackMatched,true);
 assert.notEqual((await h.callbacks["review-delete"]({})).status,"VERIFIED_DELETED");
 assert.deepEqual(h.deletedPaths,[]);
});
test("D targets the actually playing PENDING video even if Review cursor points elsewhere",async()=>{
 const target=nasRoot+"/z-next.mkv";
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmTargetPath:target,listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.core.status.url="file://"+target;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).cursor,0);
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(reviewState(h).deletePlaybackReady,true);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.deepEqual(h.deletedPaths,[target]);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["PENDING","DELETED"]);
 assert.equal(reviewState(h).cursor,0,"the remaining PENDING cursor must stay intact");
});
test("D can delete the playing previously KEEP video without deleting pending Review cursor",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).cursor,1);
 h.core.status.url="file://"+nasRoot+"/sample.mkv";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).deletePlaybackReady,true);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["DELETED","PENDING"]);
 assert.equal(reviewState(h).cursor,1);
});
test("D never deletes a URL still loading or one outside the active Review queue",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   autoFileLoaded:false,listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).deletePlaybackReady,false);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"PLAYBACK_NOT_READY");
 assert.deepEqual(h.deletedPaths,[]);
 h.core.status.url="file://"+nasRoot+"/not-queued.mkv";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).deletePlaybackReady,false);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"PLAYBACK_NOT_READY");
 assert.deepEqual(h.deletedPaths,[]);
});
test("NAS Review recursion toggle scans nested videos in deterministic order",async()=>{
 const listing={
  [nasRoot]:[{filename:"Season 1",path:"/Season 1",isDir:true},
    {filename:"local.mp4",path:"/local.mp4",isDir:false}],
  [nasRoot+"/Season 1"]:[
    {filename:"episode10.mkv",path:"/episode10.mkv",isDir:false},
    {filename:"episode2.mkv",path:"/episode2.mkv",isDir:false}]
 };
 const visited=[];
 const h=bootstrap({mountOutput:nasMount,listOverride:path=>{
   visited.push(path);return listing[path]||[];
 }});
 await h.callbacks["review-start"]({path:nasRoot,recursive:true});
 assert.deepEqual(visited,[nasRoot,nasRoot+"/Season 1"]);
 assert.equal(reviewState(h).recursive,true);
 assert.deepEqual(reviewState(h).entries.map(e=>e.name),
   ["local.mp4","Season 1/episode2.mkv","Season 1/episode10.mkv"]);
 assert.equal(h.opened[0],nasRoot+"/local.mp4");
 assert.equal(h.store.has("nasReviewCheckpointV1"),false);
});
test("local recursive Review persists mode and resumes nested KEEP",()=>{
 const listing={
  [root]:[{filename:"Season",path:"/Season",isDir:true},
    {filename:"root.mp4",path:"/root.mp4",isDir:false}],
  [root+"/Season"]:[
    {filename:"2.mp4",path:"/2.mp4",isDir:false},
    {filename:"1.mp4",path:"/1.mp4",isDir:false}]
 };
 const storage=new Map(),listOverride=dir=>listing[dir]||[];
 const first=bootstrap({store:storage,listOverride});
 first.callbacks["review-start"]({path:root,recursive:true});
 assert.equal(reviewState(first).recursive,true);
 assert.deepEqual(reviewState(first).entries.map(e=>e.name),
   ["root.mp4","Season/1.mp4","Season/2.mp4"]);
 assert.equal(first.callbacks["review-keep"]({}),true);
 first.callbacks["review-exit"]();
 const saved=JSON.parse(storage.get("nasReviewCheckpointV1"));
 assert.equal(saved.recursive,true);
 const second=bootstrap({store:storage,listOverride});
 second.core.status.url="file://"+root+"/Season/1.mp4";
 second.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(second).recursive,true);
 assert.equal(reviewState(second).cursor,1);
 assert.equal(reviewState(second).playbackMatched,true);
});
test("Folders cancels pending NAS recursive scan before any playback or queue creation",async()=>{
 const listing=path=>path===nasRoot?
   Array.from({length:90},(_,i)=>({filename:"S"+i,path:"/S"+i,isDir:true})):
   [{filename:"episode.mp4",path:"/episode.mp4",isDir:false}];
 const h=bootstrap({mountOutput:nasMount,listOverride:listing});
 const started=h.callbacks["review-start"]({path:nasRoot,recursive:true});
 await new Promise(resolve=>setImmediate(resolve));
 h.callbacks["review-exit"]({});
 await started;
 assert.equal(h.opened.length,0);
 assert.equal(reviewState(h).active,false);
 assert.equal(h.store.size,0);
});
test("large NAS queues send only a bounded sidebar window around current cursor",async()=>{
 const h=bootstrap({mountOutput:nasMount,listOverride:()=>Array.from({length:380},(_,i)=>({
   filename:"video"+i+".mp4",path:"/video"+i+".mp4",isDir:false
 }))});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).totalCount,380);
 assert.equal(reviewState(h).entries.length,120);
 assert.equal(reviewState(h).entries[0].position,0);
 for(let i=0;i<150;i++)assert.equal(h.callbacks["review-keep"]({}),true);
 const view=reviewState(h);
 assert.equal(view.cursor,150);
 assert.equal(view.entries.length,120);
 assert.ok(view.entries.some(e=>e.position===150));
 assert.equal(view.keptCount,150);
 assert.equal(h.store.size,1,"SMB progress uses a separate checkpoint");
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries
   .filter(row=>row.status==="KEEP").length,150);
});
test("scroll window requests page through all 837 Review videos without changing the Review cursor",async()=>{
 const h=bootstrap({mountOutput:nasMount,listOverride:()=>Array.from({length:837},(_,i)=>({
   filename:"video"+String(i).padStart(4,"0")+".mp4",
   path:"/video"+String(i).padStart(4,"0")+".mp4",isDir:false
 }))});
 await h.callbacks["review-start"]({path:nasRoot});
 const initial=reviewState(h);
 assert.equal(initial.totalCount,837);
 assert.equal(initial.entries.length,120);
 const epoch=initial.sessionEpoch;
 for(const [start,requestId] of [[60,1],[360,2],[717,3],[0,4]]){
   h.callbacks["review-window"]({sessionEpoch:epoch,start,requestId});
   const reply=h.messages.filter(m=>m.name==="review-window-data").at(-1)?.data;
   assert.ok(reply,"backend must respond to a scroll window request");
   assert.equal(reply.requestId,requestId);
   assert.equal(reply.windowStart,start);
   assert.equal(reply.sessionEpoch,epoch);
   assert.equal(reply.entries.length,120);
   assert.equal(reply.entries[0].position,start);
   assert.equal(reply.entries.at(-1).position,start+119);
 }
 assert.equal(reviewState(h).cursor,0);
 assert.equal(h.store.size,1,"read-only scroll requests must not persist a new checkpoint");
 assert.equal(h.opened.length,1,"scroll does not change playback");
});
test("Review window API rejects stale session and invalid bounds, never disclosing extra media",async()=>{
 const h=bootstrap({mountOutput:nasMount,listOverride:()=>Array.from({length:837},(_,i)=>({
   filename:"video"+i+".mp4",path:"/video"+i+".mp4",isDir:false
 }))});
 await h.callbacks["review-start"]({path:nasRoot});
 const epoch=reviewState(h).sessionEpoch;
 for(const data of [{sessionEpoch:epoch+1,start:0,requestId:1},
   {sessionEpoch:epoch,start:-1,requestId:2},
   {sessionEpoch:epoch,start:0,requestId:"3"},
   {sessionEpoch:epoch,start:0,requestId:4,count:50000}]){
   h.callbacks["review-window"](data);
   assert.equal(h.messages.filter(m=>m.name==="review-window-data").length,0);
 }
 h.callbacks["review-window"]({sessionEpoch:epoch,start:999999,requestId:5});
 const reply=h.messages.filter(m=>m.name==="review-window-data").at(-1)?.data;
 assert.equal(reply.windowStart,717,"out-of-range start is clamped to last complete page");
 assert.equal(reply.entries.length,120);
 h.callbacks["review-exit"]({});
 h.callbacks["review-window"]({sessionEpoch:epoch,start:0,requestId:6});
 assert.equal(h.messages.filter(m=>m.name==="review-window-data").length,1);
});
test("all-KEEP completed NAS Review remains browsable via read-only windows",async()=>{
 const h=bootstrap({mountOutput:nasMount,listOverride:()=>Array.from({length:130},(_,i)=>({
   filename:"episode"+String(i).padStart(3,"0")+".mp4",
   path:"/episode"+String(i).padStart(3,"0")+".mp4",isDir:false
 }))});
 await h.callbacks["review-start"]({path:nasRoot});
 for(let i=0;i<130;i++)
   assert.equal(h.callbacks["review-keep"]({}),true);
 const after=reviewState(h);
 assert.equal(after.phase,"COMPLETE");
 assert.equal(after.keptCount,130);
 const checkpoint=h.store.get("nasSMBReviewCheckpointV1");
 h.callbacks["review-window"]({sessionEpoch:after.sessionEpoch,
   requestId:33,start:100});
 const response=h.messages.filter(m=>m.name==="review-window-data").at(-1)?.data;
 assert.ok(response);
 assert.equal(response.windowStart,10);
 assert.equal(response.entries.length,120);
 assert.ok(response.entries.every(row=>row.status==="KEEP"));
 assert.equal(h.store.get("nasSMBReviewCheckpointV1"),checkpoint);
});
test("sidebar window follows a loaded queued video even when Review cursor is elsewhere",async()=>{
 const h=bootstrap({mountOutput:nasMount,listOverride:()=>Array.from({length:380},(_,i)=>({
   filename:"video"+i+".mp4",path:"/video"+i+".mp4",isDir:false
 }))});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).cursor,0);
 assert.equal(reviewState(h).playingPosition,0);
 const targetName="video250.mp4";
 h.core.status.url="file://"+nasRoot+"/"+targetName;
 h.callbacks["event:iina.file-loaded"]();
 const state=reviewState(h);
 const globalIndex=250;
 assert.equal(state.playingPosition,globalIndex);
 assert.equal(state.cursor,0,"scroll target must never change the destructive Review cursor");
 assert.equal(state.playbackMatched,false,"a different queued video is not authorized for D");
 assert.equal(state.entries.some(e=>e.position===globalIndex),true);
 assert.equal(globalIndex-state.windowStart,60,
   "large queue window should center the actually loaded video");
});
test("foreign playback never claims a queued playing position",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file:///Volumes/Other/movie.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playingPosition,-1);
 assert.equal(reviewState(h).playbackMatched,false);
});
test("a fake APFS volume cannot masquerade as NAS and gets no list/open",async()=>{
 let scanned=0;
 const h=bootstrap({mountOutput:"/dev/disk1 on /Volumes/Movies (apfs, local)",
   listOverride:()=>{scanned++;return [];}});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(scanned,0);
 assert.equal(h.opened.length,0);
 assert.equal(h.store.size,0);
 assert.equal(reviewState(h).active,false);
});
test("valid macOS /tmp alias is normalized before listing and opening video",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:"/tmp/iina-nas-review-fixture-demo/"});
 assert.deepEqual(h.opened,[root+"/video2.mp4"]);
 assert.equal(reviewState(h).root,root);
});
test("new Start cannot replace active Review even when request is from another source",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-keep"]({});
 assert.equal(reviewState(h).active,true);
 const saved=h.store.get("nasReviewCheckpointV1");
 const opened=h.opened.length;
 h.callbacks["review-start"]({path:"/Volumes/NAS/Videos"});
 const rejected=reviewState(h);
 assert.equal(rejected.active,true,"a stale Start must not erase active progress");
 assert.equal(rejected.cursor,1);
 assert.deepEqual(rejected.entries.map(x=>x.status),["KEEP","PENDING"]);
 assert.equal(h.store.get("nasReviewCheckpointV1"),saved);
 assert.equal(h.opened.length,opened);
 assert.match(rejected.error,/unfinished|already|checkpoint|resume/i);
 assert.equal(h.callbacks["review-keep"]({}),true,"original matched player may complete its own Review");
});
test("uncompleted saved Review blocks new Start after relaunch until explicit discard",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const saved=store.get("nasReviewCheckpointV1");
 const fresh=bootstrap({store});
 fresh.callbacks["review-start"]({path:root});
 assert.equal(fresh.opened.length,0,"must not open first video while previous Review is pending");
 assert.equal(store.get("nasReviewCheckpointV1"),saved,"do not overwrite saved KEEP/cursor");
 assert.equal(reviewState(fresh).resumeAvailable,true);
 assert.equal(reviewState(fresh).resumeKept,1);
 assert.equal(reviewState(fresh).active,false);
 assert.match(reviewState(fresh).error,/unfinished|resume|discard/i);
 fresh.callbacks["review-discard"]({});
 assert.equal(store.get("nasReviewCheckpointV1"),"");
 fresh.callbacks["review-start"]({path:root});
 assert.equal(fresh.opened.length,1,"explicit discard unlocks a new Review");
 assert.deepEqual(reviewState(fresh).entries.map(x=>x.status),["PENDING","PENDING"]);
});
test("unfinished saved Review blocks even different allowed fixture and never scans it",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const saved=store.get("nasReviewCheckpointV1");
 let scanned=0;
 const fresh=bootstrap({store,listOverride:()=>{scanned++;return [];}});
 fresh.callbacks["review-start"]({path:"/private/tmp/iina-nas-review-fixture-another"});
 assert.equal(scanned,0,"blocking occurs before opening/scanning a new source");
 assert.equal(fresh.opened.length,0);
 assert.equal(store.get("nasReviewCheckpointV1"),saved);
});
test("completed Review is not a pending checkpoint and can start a new Review",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-keep"]({});
 h.callbacks["review-keep"]({});
 const prior=h.store.get("nasReviewCheckpointV1");
 assert.equal(reviewState(h).phase,"COMPLETE");
 h.callbacks["review-start"]({path:root});
 assert.notEqual(h.store.get("nasReviewCheckpointV1"),prior);
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).cursor,0);
});
test("explicit Discard cannot clear the durable checkpoint while Review is active",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-keep"]({});
 const saved=h.store.get("nasReviewCheckpointV1");
 h.callbacks["review-discard"]({});
 assert.equal(h.store.get("nasReviewCheckpointV1"),saved);
 assert.equal(reviewState(h).resumeKept,1);
 assert.equal(reviewState(h).active,true);
});
test("failed rescan cannot keep advancing an old queue",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-exit"]({});
 h.callbacks["review-keep"]({});
 assert.equal(h.opened.length,1);
 assert.equal(reviewState(h).active,false);
});
test("Non-review direct viewer handlers remain unchanged in separate plugin identity",()=>{
 const meta=JSON.parse(fs.readFileSync(Path.join(__dirname,"../Info.json"),"utf8"));
 assert.equal(meta.identifier,"org.iina.nas-review-file-viewer");
 assert.notEqual(meta.identifier,"com.qkong.iina-plugin-file-viewer");
 assert.notEqual(meta.identifier,"org.iina.nas-video-review");
});
test("K is consumed only for the managed current video, once per press",()=>{
 const h=bootstrap();
 assert.equal(typeof h.keyHandlers.K,"function","K listener must be available");
 assert.equal(h.keyPriorities.K,10,"Review K must run before IINA default input handlers");
 assert.equal(h.keyHandlers.K({isRepeat:false}),false,"not reviewing: pass through");
 h.callbacks["review-start"]({path:root});
 assert.equal(h.keyHandlers.K({isRepeat:true}),false,"repeat must not advance");
 assert.equal(h.opened.length,1);
 assert.equal(h.keyHandlers.K({isRepeat:false}),true,"managed K consumes once");
 assert.deepEqual(h.opened,[root+"/video2.mp4",root+"/video10.mp4"]);
 assert.equal(h.keyHandlers.K({isRepeat:false}),true,"final K completes");
 assert.equal(h.keyHandlers.K({isRepeat:false}),false,"completed queue: pass through");
 assert.equal(h.opened.length,2,"never loops");
});
test("K refuses mismatched playback and text input focus, without mutating queue",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-input-focus"]({focused:true});
 assert.equal(h.keyHandlers.K({isRepeat:false}),false);
 assert.equal(h.opened.length,1);
 h.callbacks["review-input-focus"]({focused:false});
 h.core.status.url="file:///private/tmp/unrelated.mp4";
 assert.equal(h.keyHandlers.K({isRepeat:false}),false,"other video must be untouched");
 assert.equal(h.opened.length,1);
 h.core.status.url="file://"+root+"/video2.mp4";
 h.callbacks["review-exit"]({});
 assert.equal(h.keyHandlers.K({isRepeat:false}),false,"exit disables K");
});
test("second IINA file-loaded with equivalent /tmp URL cannot strand a valid local Review",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file:///tmp/iina-nas-review-fixture-demo/video2.mp4";
 h.callbacks["event:iina.file-loaded"]();
 const identity=h.messages.filter(x=>x.name==="debug-event").map(x=>x.data)
   .filter(e=>e.event==="player.file_loaded").at(-1);
 assert.equal(identity.data.matched,true);
 assert.equal(identity.data.reason,"tmp_alias");
 assert.equal(Object.hasOwn(identity.data,"path"),false,
   "debug output must not include video path or filename");
 assert.equal(h.keyHandlers.K({isRepeat:false}),true,
   "equivalent local fixture URL must not reject Keep as playback_mismatch");
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(h.opened.at(-1),root+"/video10.mp4");
});
test("repeated IINA file-loaded for another pending item never auto-KEEPS without explicit K",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 const identity=h.messages.filter(x=>x.name==="debug-event").map(x=>x.data)
   .filter(e=>e.event==="player.file_loaded").at(-1);
 assert.equal(identity.data.matched,false);
 assert.equal(identity.data.reason,"different_review_item");
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).entries[1].status,"PENDING");
 assert.equal(h.opened.length,1,"file-loaded alone must never advance the queue");
});
test("plain K resumes an out-of-order loaded pending Review video without marking skipped item KEEP",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackStatus,"different_review_item");
 assert.equal(h.physicalKeyDown("k"),true);
 const state=reviewState(h);
 assert.equal(state.keptCount,1);
 assert.equal(state.entries.find(x=>x.name==="video10.mp4").status,"KEEP");
 assert.equal(state.entries.find(x=>x.name==="video2.mp4").status,"PENDING");
 assert.equal(h.opened.at(-1),root+"/video2.mp4");
});
test("plain K refuses a different file without a file-loaded event",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file://"+root+"/video10.mp4";
 assert.equal(h.physicalKeyDown("k"),false);
 assert.equal(reviewState(h).keptCount,0);
});
test("explicit Reopen can recover an unexpectedly switched player without accepting wrong-video Keep",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(reviewState(h).playbackStatus,"different_review_item");
 assert.equal(h.callbacks["review-keep"]({}),false);
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(typeof h.callbacks["review-reopen"],"function");
 h.callbacks["review-reopen"]({});
 assert.equal(h.opened.at(-1),root+"/video2.mp4");
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
});
test("Reopen refuses inactive sessions without opening any file",()=>{
 const h=bootstrap();
 h.callbacks["review-reopen"]({});
 assert.equal(h.opened.length,0);
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-exit"]({});
 h.callbacks["review-reopen"]({});
 assert.equal(h.opened.length,1);
});
test("native menu K is active only for correct Review player and never consumes K outside Review",()=>{
 const h=bootstrap({withMenu:true,autoFileLoaded:false});
 assert.equal(h.menuItems.filter(i=>i.title.includes("Keep & Next")).length,1,
   "native click-only K menu action must be registered exactly once");
 const menuK=h.menuItems.find(i=>i.title.includes("Keep & Next"));
 assert.equal(menuK.keyBinding,undefined,
   "native menu must not intercept bare K before player input");
 assert.equal(menuK.enabled,false,"idle plugin must not capture K");
 h.callbacks["review-start"]({path:root});
 assert.equal(menuK.enabled,false,"wait for IINA file-loaded before enabling K menu");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(menuK.enabled,true);
 // The native menu item is click-only; it does not consume plain K.
 menuK.action();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(menuK.enabled,false,"no extra K until the new video file-load");
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(menuK.enabled,true);
 h.callbacks["review-input-focus"]({focused:true});
 assert.equal(menuK.enabled,false,"K menu must not hijack text input");
 h.callbacks["review-input-focus"]({focused:false});
 assert.equal(menuK.enabled,true);
 h.core.status.url="file://"+root+"/video2.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(menuK.enabled,false,"wrong video cannot enable K");
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(menuK.enabled,true);
 menuK.action();
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(menuK.enabled,false);
 const before=h.opened.length;
 menuK.action();
 assert.equal(h.opened.length,before,"stale disabled-menu callback must not KEEP");
 h.callbacks["review-exit"]({});
 assert.equal(menuK.enabled,false);
 assert.ok(h.menuCalls.includes("update"));
});
test("click-only K menu then player K cannot skip pending next video",()=>{
 const h=bootstrap({withMenu:true,autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 const menuK=h.menuItems[0];
 assert.equal(menuK.enabled,true);
 // A menu click is a distinct action from the physical key; a fresh K
 // before the next file-loaded event must not skip that new video.
 menuK.action();
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.keyHandlers.K({isRepeat:false}),false,
   "input must refuse an unloaded next video");
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(h.opened.length,2);
 const events=h.messages.filter(m=>m.name==="debug-event").map(m=>m.data);
 assert.equal(events.filter(e=>e.event==="review.keep.accepted").length,1,
   "a menu click and early player K must not KEEP two queue items");
 // A subsequent real key after file-loaded should advance.
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.keyHandlers.K({isRepeat:false}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(h.opened.length,2);
});
test("SMB player plain K uses input fallback even if native menu shortcut is registered",async()=>{
 const h=bootstrap({withMenu:true,mountOutput:nasMount,autoFileLoaded:false,
  listOverride:()=>[
    {filename:"a.mp4",path:"/a.mp4",isDir:false},
    {filename:"b.mp4",path:"/b.mp4",isDir:false}
  ]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["event:iina.file-loaded"]();
 assert.ok(h.menuItems.find(x=>x.title.includes("Keep & Next"))?.enabled);
 assert.equal(typeof h.keyHandlers.K,"function");
 assert.equal(h.keyHandlers.K({isRepeat:false}),true,
   "plain K delivered to player input must work when native menu accelerator does not fire");
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.opened.length,2);
});
test("SMB player plain D requests confirmation even with native menu installed",async()=>{
 const h=bootstrap({withMenu:true,mountOutput:nasMount,listOverride:()=>[
   {filename:"movie.mp4",path:"/movie.mp4",isDir:false}
 ]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.ok(h.menuItems.find(x=>x.title.includes("Delete"))?.enabled);
 assert.equal(typeof h.keyHandlers.D,"function",
   "plain D must have a player input listener and not rely on macOS menu accelerator");
 assert.equal(h.keyHandlers.D({isRepeat:false}),true);
 await new Promise(resolve=>setImmediate(resolve));
 const events=h.messages.filter(x=>x.name==="debug-event").map(x=>x.data);
 assert.ok(events.some(x=>x.event==="input.d.received"&&x.data.source==="player"));
 assert.ok(events.some(x=>x.event==="review.delete.rejected" &&
   x.data.reason==="SOURCE_UNAVAILABLE"));
 assert.equal(h.opened.length,1);
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(h.store.has("nasDeleteJournalV1"),false);
});
test("D native menu stays inactive for local test fixtures without deleting media",async()=>{
 const h=bootstrap({withMenu:true});
 const menuD=h.menuItems.find(i=>i.title.includes("Delete"));
 assert.ok(menuD,"D request must have a native IINA menu shortcut");
 assert.equal(menuD.enabled,false);
 const before=h.store.size;
 h.callbacks["review-start"]({path:root});
 assert.equal(menuD.enabled,false);
 menuD.action();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.store.size,before+1,
   "only the normal local Review queue checkpoint may be saved");
 assert.equal(h.opened.length,1,"delete request must never advance playback");
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(h.deletedPaths.length,0);
 assert.equal(h.store.has("nasExperimentalDeleteJournalV1"),false);
 h.callbacks["review-exit"]({});
 assert.equal(menuD.enabled,false);
});
test("configured D binding is never shadowed by plugin",()=>{
 const h=bootstrap({withMenu:true,keyBindings:{d:{key:"d",action:"custom"}}});
 assert.equal(h.menuItems.filter(i=>i.title.includes("Delete")).length,0);
 assert.equal(h.keyHandlers.D,undefined);
});
test("existing K key mapping prevents native menu shortcut registration",()=>{
 const h=bootstrap({withMenu:true,keyBindings:{k:{key:"k",action:"custom"}}});
 assert.equal(h.menuItems.filter(i=>i.title.includes("Keep & Next")).length,0);
 assert.equal(h.keyHandlers.K,undefined);
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.menuItems.filter(i=>i.title.includes("Keep & Next")).length,0);
});
test("default K dispatch is preserved outside Review but intercepted before default while reviewing",()=>{
 const h=bootstrap();
 let defaultInvocations=0;
 function dispatchK(){
   const registered=h.keyHandlers.K;
   if(h.keyPriorities.K===10 && registered({isRepeat:false}))return "plugin";
   defaultInvocations++;
   return "default";
 }
 assert.equal(dispatchK(),"default","outside Review the default handler gets the key");
 h.callbacks["review-start"]({path:root});
 assert.equal(dispatchK(),"plugin","inside Review K must be processed before the default");
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(defaultInvocations,1);
 assert.equal(dispatchK(),"plugin");
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(dispatchK(),"default");
 assert.equal(defaultInvocations,2);
 const inactive=h.messages.filter(m=>m.name==="debug-event").map(m=>m.data)
   .filter(e=>e.event==="input.k.ignored"&&e.data.reason==="session_inactive");
 assert.equal(inactive.length,2,"log K received but passed through");
});
test("existing K binding is never shadowed; button Keep still works",()=>{
 const h=bootstrap({keyBindings:{k:{key:"k",action:"custom-binding",isIINACommand:"false"}}});
 assert.equal(h.keyHandlers.K,undefined,"must not install conflicting shortcut");
 h.callbacks["review-start"]({path:root});
 assert.equal(reviewState(h).kShortcutEnabled,false);
 assert.match(reviewState(h).kRegistration,/already assigned/);
 h.callbacks["review-keep"]({});
 assert.deepEqual(h.opened,[root+"/video2.mp4",root+"/video10.mp4"]);
});
test("runtime diagnostic proves player key handler was reached even when current media mismatches",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 const key=h.keyHandlers.K;
 assert.equal(reviewState(h).kInputEvents,0);
 h.core.status.url="file:///private/tmp/not-managed.mp4";
 assert.equal(key({isRepeat:false}),false);
 const report=reviewState(h);
 assert.equal(report.kInputEvents,1);
 assert.match(report.lastKResult,/does not match/);
 assert.equal(report.entries[0].status,"PENDING");
 assert.equal(h.opened.length,1);
});
test("runtime diagnostic marks the K event as processed on the managed player",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 assert.equal(h.keyHandlers.K({isRepeat:false}),true);
 assert.equal(reviewState(h).kInputEvents,1);
 assert.match(reviewState(h).lastKResult,/Player K received/);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
});
test("backend startup and active Review actions are exposed through bounded debug messages",()=>{
 const h=bootstrap();
 assert.equal(typeof h.callbacks["debug-ready"],"function");
 h.callbacks["debug-ready"]({});
 const replay=h.messages.at(-1);
 assert.equal(replay.name,"debug-snapshot");
 assert.ok(replay.data.some(e=>e.event==="plugin.entry"));
 assert.ok(replay.data.some(e=>e.event==="plugin.window_loaded"));
 h.callbacks["review-start"]({path:root});
 h.keyHandlers.K({isRepeat:false});
 const events=h.messages.filter(x=>x.name==="debug-event").map(x=>x.data);
 assert.ok(events.some(e=>e.event==="review.queue.created"&&e.data.total===2));
 assert.ok(events.some(e=>e.event==="input.k.received"&&e.data.source==="player"));
 assert.ok(events.some(e=>e.event==="review.keep.accepted"&&e.data.kept===1));
 const exported=JSON.stringify(events);
 assert.equal(exported.includes(root),false,"do not persist full local paths");
 assert.equal(exported.includes("video2.mp4"),false,"do not persist media filenames");
});
test("debug clear removes backend replay history without stopping normal playback",()=>{
 const h=bootstrap();
 h.callbacks["debug-clear"]({});
 h.callbacks["debug-ready"]({});
 assert.equal(h.messages.at(-1).name,"debug-snapshot");
 assert.equal(h.messages.at(-1).data.length,0);
 h.callbacks["review-start"]({path:root});
 assert.equal(h.opened[0],root+"/video2.mp4");
});
+test("checkpoint persists active queue and KEEP before opening the next video",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 let saved=JSON.parse(h.store.get("nasReviewCheckpointV1"));
 assert.equal(saved.cursor,0);
 assert.equal(saved.entries.length,2);
 h.core.status.position=14;
 h.callbacks["review-keep"]({});
 saved=JSON.parse(h.store.get("nasReviewCheckpointV1"));
 assert.deepEqual(saved.entries.map(x=>x.status),["KEEP","PENDING"]);
 assert.equal(saved.cursor,1);
 assert.deepEqual(h.opened,[root+"/video2.mp4",root+"/video10.mp4"]);
});
test("relaunch auto-attaches to IINA history without playback commands",async()=>{
  const store=new Map();
  const first=bootstrap({store});
  first.callbacks["review-start"]({path:root});
  first.callbacks["review-keep"]({});
  const fresh=bootstrap({store});
  assert.equal(fresh.opened.length,0);
  fresh.core.status.url="file://"+root+"/video10.mp4";
  fresh.core.status.position=22.5;
  fresh.core.status.paused=true;
  await fresh.callbacks["review-ready"]({});
  assert.equal(reviewState(fresh).resumeAvailable,true);
  assert.equal(reviewState(fresh).resumeKept,1);
  assert.equal(reviewState(fresh).resumeSource,root);
  assert.equal(reviewState(fresh).active,true);
  assert.equal(fresh.opened.length,0,"Review attaches without reopening the history video");
  assert.deepEqual(reviewState(fresh).entries.map(x=>x.status),["KEEP","PENDING"]);
  assert.equal(fresh.core.status.position,22.5);
  assert.equal(fresh.core.status.paused,true);
  assert.equal(fresh.timers.filter(t=>t.kind==="timeout").length,0);
  assert.equal("restoreState" in reviewState(fresh),false);
  const event=fresh.messages.filter(x=>x.name==="debug-event").map(x=>x.data)
    .find(x=>x.event==="review.resume.attached");
  assert.equal(event.data.matched,true);
  assert.equal(JSON.parse(store.get("nasReviewCheckpointV1")).version,4);
});
test("window close and review exit leave native playback and queue-only checkpoint untouched",()=>{
 const store=new Map();
 const h=bootstrap({store});
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-keep"]({});
 const before=store.get("nasReviewCheckpointV1");
 h.core.status.position=23.5;h.core.status.paused=true;
 h.core.audio.id=2;h.core.subtitle.id=3;
 h.callbacks["event:iina.window-will-close"]();
 assert.equal(store.get("nasReviewCheckpointV1"),before);
 h.callbacks["review-exit"]({});
 assert.equal(store.get("nasReviewCheckpointV1"),before);
 assert.equal(h.core.status.position,23.5);
 assert.equal(h.core.status.paused,true);
 assert.equal(h.timers.filter(t=>t.kind==="interval").length,0);
 const saved=JSON.parse(before);
 assert.equal("playback" in saved,false);
});
test("Resume never seeks a different already-open video and KEEP stays blocked until matching history item",()=>{
 const store=new Map();
 const previous=bootstrap({store});
 previous.callbacks["review-start"]({path:root});
 previous.callbacks["review-keep"]({});
 const h=bootstrap({store});
 h.core.status.url="file:///private/tmp/unrelated.mp4";
 h.core.status.position=22;h.core.status.paused=true;
 h.callbacks["review-resume"]({path:root});
 assert.equal(h.opened.length,0);
 assert.equal(h.core.status.position,22);
 assert.equal(h.core.status.paused,true);
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(h.callbacks["review-keep"]({}),false);
 assert.equal(JSON.parse(store.get("nasReviewCheckpointV1")).cursor,1);
});
test("resume refuses different source or changed filenames without autoplay",()=>{
 const store=new Map();
 const prior=bootstrap({store});prior.callbacks["review-start"]({path:root});
 const other=bootstrap({store});
 other.callbacks["review-resume"]({path:"/Volumes/NAS"});
 assert.equal(other.opened.length,0);
 assert.match(reviewState(other).error,/resume|source|folder/i);
 assert.equal(reviewState(other).resumeSource,root,
   "rejected wrong-source resume must preserve saved fixture for correction");
 const changed=bootstrap({store,listOverride:()=>[
  {filename:"new.mp4",path:"/new.mp4",isDir:false}
 ]});
 changed.callbacks["review-resume"]({path:root});
 assert.equal(changed.opened.length,0);
 assert.match(reviewState(changed).error,/changed|snapshot|match/i);
});
test("pre-advance durable write failure refuses KEEP and leaves current playback intact",()=>{
 const h=bootstrap({persistFail:true});
 h.callbacks["review-start"]({path:root});
 assert.equal(h.opened.length,0,"cannot begin persisted review without storage");
 assert.match(reviewState(h).error,/checkpoint|save|storage/i);
});
test("KEEP cannot advance when preferences.sync fails during an active Review",()=>{
 const h=bootstrap({failSyncOn:2});
 h.callbacks["review-start"]({path:root});
 assert.equal(h.opened.length,1);
 h.callbacks["review-keep"]({});
 assert.equal(h.opened.length,1,"failed commit cannot play the next file");
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).cursor,0);
 assert.match(reviewState(h).error,/could not save keep/i);
 const stored=JSON.parse(h.store.get("nasReviewCheckpointV1"));
 assert.equal(stored.entries[0].status,"PENDING","rollback staged in-memory value");
});
test("explicit discard removes recoverable checkpoint without deleting media",()=>{
 const store=new Map();
 bootstrap({store}).callbacks["review-start"]({path:root});
 const fresh=bootstrap({store});
 fresh.callbacks["review-discard"]({});
 assert.equal(fresh.opened.length,0);
 assert.equal(reviewState(fresh).resumeAvailable,false);
 assert.equal(store.get("nasReviewCheckpointV1"),"");
});
test("stale Resume command cannot tear down an already-active Review queue",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 h.callbacks["review-keep"]({});
 const checkpointBefore=h.store.get("nasReviewCheckpointV1");
 const openedBefore=h.opened.length;
 // A delayed/stale sidebar command from a previous UI generation must
 // never reset the live queue or replace its saved KEEP state.
 h.callbacks["review-resume"]({path:"/Volumes/OtherNAS"});
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).cursor,1);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(h.store.get("nasReviewCheckpointV1"),checkpointBefore);
 assert.equal(h.opened.length,openedBefore);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("repeated Resume on an active Review is idempotent and never rewrites a checkpoint",()=>{
 const h=bootstrap();
 h.callbacks["review-start"]({path:root});
 const checkpointBefore=h.store.get("nasReviewCheckpointV1");
 h.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).cursor,0);
 assert.equal(h.opened.length,1);
 assert.equal(h.store.get("nasReviewCheckpointV1"),checkpointBefore);
 assert.deepEqual(h.playerWrites,[]);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).cursor,1);
});
test("Resume with no IINA video leaves queue pending until explicit user Reopen",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const h=bootstrap({store});
 h.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).playbackStatus,"missing_url");
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(h.opened.length,0,"Resume must never autoplay");
 assert.deepEqual(h.playerWrites,[]);
 assert.equal(h.callbacks["review-keep"]({}),false);
 const saved=store.get("nasReviewCheckpointV1");
 assert.equal(h.callbacks["review-reopen"]({}),true);
 assert.equal(h.opened.length,1,"explicit Reopen is the only allowed media open");
 assert.equal(h.opened[0],root+"/video10.mp4");
 assert.equal(store.get("nasReviewCheckpointV1"),saved,"Reopen must not change KEEP state");
 assert.equal(reviewState(h).playbackMatched,true);
 assert.deepEqual(h.playerWrites,[]);
});
test("Resume attaches to already-open IINA history item without opening, seeking, pausing or changing tracks",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const next=root+"/video10.mp4";
 const h=bootstrap({store});
 h.core.status.url="file://"+next;
 h.core.status.position=32.75;
 h.core.status.paused=true;
 h.core.audio.id=3;
 h.core.subtitle.id=6;
 h.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.opened.length,0,"IINA already has the history file open");
 assert.deepEqual(h.playerWrites,[],"Resume never issues Seek, Pause or Resume to IINA");
 assert.equal(h.core.status.position,32.75);
 assert.equal(h.core.status.paused,true);
 assert.equal(h.core.audio.id,3);
 assert.equal(h.core.subtitle.id,6);
 assert.equal(h.timers.filter(t=>t.kind==="timeout").length,0);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(JSON.parse(store.get("nasReviewCheckpointV1")).version,4);
 assert.equal("playback" in JSON.parse(store.get("nasReviewCheckpointV1")),false);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("Resume with IINA history on another item stays fail-closed without auto-opening or modifying queue",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const h=bootstrap({store});
 h.core.status.url="file://"+root+"/video2.mp4";
 h.core.status.position=39.5;
 h.callbacks["review-resume"]({path:root});
 assert.equal(h.opened.length,0);
 assert.deepEqual(h.playerWrites,[]);
 assert.equal(reviewState(h).active,true);
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(h.callbacks["review-keep"]({}),false);
 assert.deepEqual(reviewState(h).entries.map(x=>x.status),["KEEP","PENDING"]);
 assert.equal(h.core.status.position,39.5);
 // Opening the correct video through IINA history afterwards attaches
 // without any explicit seek/pause command by this plugin.
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.callbacks["review-keep"]({}),true);
});
test("actual Resume migrates pre-upgrade v1 checkpoint without restoring its media playback",()=>{
 const store=new Map();
 const original=bootstrap({store});
 original.callbacks["review-start"]({path:root});
 original.callbacks["review-keep"]({});
 const saved=JSON.parse(store.get("nasReviewCheckpointV1"));
 store.set("nasReviewCheckpointV1",JSON.stringify({
  ...saved,version:1,
  playback:{positionSec:48.5,paused:true,audioTrack:2,subtitleTrack:1}
 }));
 const fresh=bootstrap({store});
 fresh.core.status.url="file://"+root+"/video10.mp4";
 fresh.core.status.position=12.25;
 fresh.core.status.paused=false;
 fresh.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(fresh).playbackMatched,true);
 assert.equal(reviewState(fresh).resumeKept,1);
 assert.equal(fresh.opened.length,0);
 assert.deepEqual(fresh.playerWrites,[]);
 assert.equal(fresh.core.status.position,12.25,"legacy 48.5 seconds must never overwrite IINA history");
 assert.equal(fresh.core.status.paused,false,"legacy pause state must not be applied");
 const updated=JSON.parse(store.get("nasReviewCheckpointV1"));
 assert.equal(updated.version,4);
 assert.equal("playback" in updated,false);
 assert.deepEqual(updated.entries.map(x=>x.status),["KEEP","PENDING"]);
});
