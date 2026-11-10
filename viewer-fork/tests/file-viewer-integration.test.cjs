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
function bootstrap({keyBindings={},mpvPathFallback=false,iinaListLeadingSlash=false,store=new Map(),persistFail=false,failSyncOn=null,listOverride=null,mountOutput="",seekDoesNothing=false,pauseDoesNothing=false,withThumbnailOverlay=false,withMenu=false,autoFileLoaded=true,clock=null,experimentalDeleteMock=false,confirmAll=false,rmDeferred=null,multiDeleteFiles=null,directoryDeleteMock=false,unloadPlayerOnDelete=false,failNextPlaybackOnDelete=false,rmFailureStatus=null,rmFailureStderr="",rmFailureButTargetMissing=false,staleExistsAfterDelete=false,stalePostcheckAll=false,failQueuePersistAfterRm=false,initialMediaExists=true,rmTargetPath=nasRoot+"/sample.mkv",nestedParentSymlink=false,simulateTimelineCache=false,cacheCleanupFails=false,mountDevice=18,mountRootInode=23,nasSidecarFiles=null,nasSidecarWriteFails=false}={}){
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
 const playerWrites=[],menuItems=[],menuCalls=[],sidebarVisibility=[],mpvFlags={},mpvNumbers={};
 const deletedPaths=[],alerts=[];let simulatedMediaExists=initialMediaExists,simulatedCanaryExists=false;
 const multiFiles=Array.isArray(multiDeleteFiles)?new Set(multiDeleteFiles):null;
 let simulatedDirectoryExists=true;
 const directoryTarget=nasRoot+"/Season 1";
 const cachedFiles=new Map(),cacheRemoved=[];
 const nasMeta=nasSidecarFiles instanceof Map?nasSidecarFiles:null;
 const nasMetaDir=nasRoot+"/.iina-nas-review";
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
  mpv:{getFlag(name){return mpvFlags[name]===true;},
    getString(name){return mpvPathFallback && name==="path" ? iina.core.status.playbackPath : undefined;},
    getNumber(name){return mpvNumbers[name];}},
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
    exists(p){if(multiFiles && p.startsWith(nasRoot+"/"))return multiFiles.has(p);
      return nasMeta&&p.startsWith(nasMetaDir)?
      nasMeta.has(p):cachedFiles.has(p)?true:p.startsWith(mockCacheRoot+"/")?false:
      p===simulatedCanary?simulatedCanaryExists:
      (staleExistsAfterDelete||stalePostcheckAll)&&!simulatedMediaExists?
        true:simulatedMediaExists;},
    delete(p){
      throw Error("DeleteAPIUnavailable"); // IINA API absence must not break test mode.
    },
    read:nasMeta?function(p){
      if(!p.startsWith(nasMetaDir))throw Error("MediaReadUnavailable");
      return nasMeta.get(p)?.content;
    }:undefined,
    write:nasMeta?function(p,value){
      if(!p.startsWith(nasMetaDir+"/.state-"))throw Error("MediaWriteUnavailable");
      if(nasSidecarWriteFails)throw Error("SMBWriteUnavailable");
      nasMeta.set(p,{mode:"100644",content:value});
    }:undefined,
    list(p){
      if(simulateTimelineCache&&p===mockCacheRoot)return [...cachedFiles.keys()]
        .map(path=>({filename:path.slice(mockCacheRoot.length+1),
          path:"/"+path.slice(mockCacheRoot.length+1),isDir:false}));
      if(directoryDeleteMock && p===nasRoot)return simulatedDirectoryExists?
        [{filename:"Season 1",path:"/Season 1",isDir:true}]:[];
      if(directoryDeleteMock && p===directoryTarget)return simulatedDirectoryExists?
        [{filename:"ep.mkv",path:"/ep.mkv",isDir:false}]:[];
      const rows=listOverride?listOverride(p):p===root?[
        {filename:"video10.mp4",path:iinaListLeadingSlash?"/video10.mp4":"video10.mp4",isDir:false},
        {filename:"video2.mp4",path:iinaListLeadingSlash?"/video2.mp4":"video2.mp4",isDir:false}
      ]:[];
      if(multiFiles && p===nasRoot)return rows.filter(x=>multiFiles.has(nasRoot+"/"+x.filename));
      return experimentalDeleteMock && (rmFailureButTargetMissing||staleExistsAfterDelete) &&
        !simulatedMediaExists && p===nasRoot?
        rows.filter(x=>x.filename!=="sample.mkv"):rows;
    }},
  utils:{chooseFile(){return Promise.resolve(null);},ask(message){alerts.push(String(message));return experimentalDeleteMock===true || directoryDeleteMock===true || confirmAll===true;},
    resolvePath(path){
      if(!simulateTimelineCache||path!=="~/Library/Caches/com.colliderli.iina/nas-review-generated")
        throw Error("MockCacheUnavailable");
      return mockCacheRoot;
    },
    exec(command,args){
      if(nasMeta && command==="/usr/bin/stat"&&args[1]==="%p"&&
         String(args[2]).startsWith(nasMetaDir)){
        const data=nasMeta.get(String(args[2]));
        return Promise.resolve(data?{status:0,stdout:data.mode}:{status:1});
      }
      if(nasMeta && command==="/usr/bin/stat"&&args[1]==="%p"&&
         String(args[2])===nasRoot){
        return Promise.resolve({status:0,stdout:"40755"});
      }
      if(nasMeta && command==="/bin/mkdir"&&
         String(args[3]).startsWith(nasMetaDir)){
        const target=String(args[3]);
        if(nasMeta.has(target))return Promise.resolve({status:1});
        nasMeta.set(target,{mode:"40700"});
        return Promise.resolve({status:0});
      }
      if(nasMeta && command==="/bin/mv" &&
         String(args[2]).startsWith(nasMetaDir+"/")){
        const src=String(args[2]),dst=String(args[3]);
        if(!nasMeta.has(src))return Promise.resolve({status:1});
        nasMeta.set(dst,nasMeta.get(src));nasMeta.delete(src);
        return Promise.resolve({status:0});
      }
      if(nasMeta && command==="/bin/rmdir"&&
         String(args[1]).startsWith(nasMetaDir+"/")){
        nasMeta.delete(String(args[1]));return Promise.resolve({status:0});
      }
      if(nasMeta && command==="/bin/rm"&&
         String(args[1]).startsWith(nasMetaDir+"/.state-")){
        nasMeta.delete(String(args[1]));return Promise.resolve({status:0});
      }
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
      if(directoryDeleteMock && command==="/bin/rm" && args[0]==="-r"){
        assert.deepEqual(Array.from(args),["-r","--",directoryTarget]);
        simulatedDirectoryExists=false;
        deletedPaths.push(directoryTarget);
        return Promise.resolve({status:0,stdout:"",stderr:""});
      }
      if(experimentalDeleteMock && rmDeferred && command==="/bin/rm" && String(args[1])===rmTargetPath){
        assert.deepEqual(Array.from(args),["--",rmTargetPath]);
        rmDeferred.started=true;
        return rmDeferred.promise.then(result=>{
          if(result.status===0){
            deletedPaths.push(String(args[1]));
            if(multiFiles)multiFiles.delete(String(args[1]));
            simulatedMediaExists=false;
            rmSucceeded=true;
          }
          return result;
        });
      }
      if(multiFiles && experimentalDeleteMock && command==="/bin/rm" && args[0]==="--"){
        assert.equal(multiFiles.has(String(args[1])),true);
        deletedPaths.push(String(args[1]));multiFiles.delete(String(args[1]));
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
      if(directoryDeleteMock && command==="/usr/bin/stat" &&
         String(args[2])===directoryTarget)return Promise.resolve({
           status:simulatedDirectoryExists?0:1,
           stdout:"40755|18|23|12|1000",stderr:""
         });
      if(command==="/usr/bin/stat" &&
         ["/Volumes/Movies",nasRoot].includes(String(args[2]))){
        return Promise.resolve({status:0,stdout:"40755|"+mountDevice+"|"+mountRootInode+"|12|1000\n",stderr:""});
      }
      if(multiFiles && experimentalDeleteMock && command==="/usr/bin/stat" &&
         String(args[2]).startsWith(nasRoot+"/")){
        const path=String(args[2]);
        return Promise.resolve(multiFiles.has(path)?
          {status:0,stdout:"100644|18|23|12|1000"}:
          {status:1,stderr:"not found"});
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
      return Promise.resolve({status:0,stdout:
        typeof mountOutput==="string"?mountOutput:mountOutput?.value||"",
        stderr:""});
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
    name==="./nas-review-sidecar.cjs"?require("../src/nas-review-sidecar.cjs"):
    name==="./nas-sidecar-file.cjs"?require("../src/nas-sidecar-file.cjs"):
    name==="./nas-source.cjs"?require("../src/nas-source.cjs"):
    name==="./review-scan.cjs"?require("../src/review-scan.cjs"):
    name==="./delete-coordinator.cjs"?require("../src/delete-coordinator.cjs"):
    name==="./experimental-delete.cjs"?require("../src/experimental-delete.cjs"):
    name==="./video-delete-queue.cjs"?require("../src/video-delete-queue.cjs"):
    name==="./directory-delete.cjs"?require("../src/directory-delete.cjs"):
    name==="./delete-canary.cjs"?require("../src/delete-canary.cjs"):
   name==="./thumbnail-overlay.cjs"?require("../src/thumbnail-overlay.cjs"):
   name==="./cache-cleanup-queue.cjs"?require("../src/cache-cleanup-queue.cjs"):
   name==="./thumbnail-generator.cjs"?require("../src/thumbnail-generator.cjs"):require(name),
   setInterval(fn,ms){timers.push({fn,ms,kind:"interval"});return timers.length;},
   clearInterval(){},setTimeout(fn,ms){timers.push({fn,ms,kind:"timeout"});return timers.length;},
   clearTimeout(){}});
 callbacks["event:iina.window-loaded"]();
 return {callbacks,messages,opened,keyHandlers,keyPriorities,core:iina.core,store,timers,overlayCalls,overlayEvents,playerWrites,menuItems,menuCalls,sidebarVisibility,mpvFlags,mpvNumbers,deletedPaths,alerts,cachedFiles,cacheRemoved,nasMeta,
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
test("successful SMB video deletion updates visible remaining count but keeps snapshot positions stable",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const before=reviewState(h);
 assert.equal(before.totalCount,2);
 assert.equal(before.remainingCount,2);
 assert.equal((await h.callbacks["review-delete"]({})).status,"VERIFIED_DELETED");
 const after=reviewState(h);
 assert.equal(after.totalCount,2,"original positions must remain stable for checkpoint/window");
 assert.equal(after.remainingCount,1,"deleted video no longer contributes to displayed total");
 assert.equal(after.deletedCount,1);
 assert.equal(after.entries[0].status,"DELETED");
});
test("natural EOF of another loaded pending Review video also records KEEP without touching skipped media",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).cursor,0);
 h.core.status.position=95;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=96;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 const result=reviewState(h);
 assert.equal(result.keptCount,1);
 assert.equal(result.entries[0].status,"PENDING");
 assert.equal(result.entries[1].status,"KEEP");
 assert.equal(result.cursor,0,"previously skipped queue item is still pending");
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,1);
});
test("drag-to-100% when mpv clears the URL before a final time tick still saves KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 // At the native seek event mpv still reports the old position.
 h.callbacks["event:mpv.seek"]?.();
 // Seeking exactly to 100% may unload the stream without a last time-pos
 // change. end-file eof can arrive after URL, duration and position reset.
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).cursor,1);
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,1);
});
test("drag-to-100% with first time-pos delivered after seek still saves KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 // No time-pos tick has arrived yet; the file is definitely loaded.
 h.core.status.position=25;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.position=100;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("mpv seek callback after exact-100% position change uses file-loaded baseline to KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 // IINA reports the true start position when file-loaded fires.
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 // Some builds deliver seek after updating current position.
 h.core.status.position=100;
 h.callbacks["event:mpv.seek"]?.();
 h.callbacks["event:mpv.playback-restart"]?.();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("paused exact-tail seek can KEEP via mpv.seeking.changed even without restart or EOF",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.paused=true;
 h.core.status.position=25;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.position=100;
 h.mpvFlags.seeking=false;
 h.callbacks["event:mpv.seeking.changed"]?.();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("NAS exact-tail seek marks KEEP durably without issuing a delete",async()=>{
 const rows=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const h=bootstrap({mountOutput:nasMount,autoFileLoaded:false,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries[0].status,"KEEP");
 assert.deepEqual(h.deletedPaths,[]);
});
test("seek-to-end with only a native eof-reached flag still marks KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.mpvFlags["eof-reached"]=true;
 h.callbacks["event:mpv.eof-reached.changed"]?.();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("seek then stop and stale eof must not KEEP an incomplete video",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"stop"});
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).entries[0].status,"PENDING",
   "stop must invalidate stale seek intent, even if a late EOF arrives");
});
test("seek to middle with playback-restart but no time-pos evidence cannot later count as tail KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.position=60;
 h.callbacks["event:mpv.playback-restart"]?.();
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).entries[0].status,"PENDING");
});
test("seek only to middle, foreign media, or stop/error events never auto-KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.position=60;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.({reason:"stop"});
 assert.equal(reviewState(h).keptCount,0);
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.url="file://"+root+"/foreign.mp4";
 h.callbacks["event:iina.file-loaded"]();
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,0);
});
test("dragging loaded Review media straight to the tail explicitly marks KEEP without an EOF event",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=100;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).keptCount,1,
   "explicit long seek to the tail should behave like Keep & Next");
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).cursor,1);
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 assert.equal(reviewState(h).keptCount,1,"a following stale EOF cannot KEEP the next file");
});
test("dragging a paused Review video to its tail also marks KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.paused=true;
 h.core.status.position=10;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99.5;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).keptCount,1);
});
test("scrubbing another loaded pending queue video to the tail KEEP's that item, not the skipped cursor",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).cursor,0);
 h.core.status.position=30;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 const state=reviewState(h);
 assert.equal(state.entries[0].status,"PENDING");
 assert.equal(state.entries[1].status,"KEEP");
 assert.equal(state.cursor,0);
 assert.equal(state.keptCount,1);
});
test("small natural time progression near tail does not KEEP before native EOF",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=96;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=97;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).keptCount,0);
});
test("scrubbing to the middle or in a foreign video never records KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=80;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).keptCount,0);
 h.core.status.url="file://"+root+"/foreign.mp4";
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=100;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).keptCount,0);
});
test("EOF on matching loaded video auto KEEP; duplicate EOF and stop cannot skip",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 // Continuous near-end playback is still independently recognized as EOF.
 h.core.status.position=96;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=98;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 assert.equal(reviewState(h).cursor,0,"normal near-end progress awaits native EOF");
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
test("automatic IINA next-file transition after verified near-end playback retains KEEP without an EOF callback",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 assert.equal(reviewState(h).keptCount,0,"near-end progress alone must not KEEP");
 // Real IINA can auto-load the playlist's next file without forwarding mpv EOF.
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 // Delayed EOF or duplicate load notifications must not KEEP the next entry.
 assert.equal(h.opened.length,1,"already-loaded next item must not reopen or restart");
 assert.equal(reviewState(h).playbackMatched,true);
 h.callbacks["event:mpv.end-file"]?.(); // Public IINA API supplies no payload.
 h.callbacks["event:mpv.end-file"]?.({reason:"eof"});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).keptCount,1);
});
test("next-file transition without terminal playback evidence never marks KEEP",()=>{
 for(const samples of [[20,21,22],[86,90,92]]){
   const h=bootstrap({autoFileLoaded:false});
   h.callbacks["review-start"]({path:root});
   h.callbacks["event:iina.file-loaded"]();
   for(const position of samples){
     h.core.status.position=position;
     h.callbacks["event:mpv.time-pos.changed"]?.();
   }
   h.core.status.url="file://"+root+"/video10.mp4";
   h.core.status.position=0;
   h.callbacks["event:iina.file-loaded"]();
   assert.equal(reviewState(h).keptCount,0);
 }
});
test("next-file fallback persists an SMB checkpoint and never deletes or reopens media",async()=>{
 const h=bootstrap({mountOutput:nasMount,autoFileLoaded:false,
   listOverride:p=>p===nasRoot?[
     {filename:"a.mp4",path:"/a.mp4",isDir:false},
     {filename:"b.mp4",path:"/b.mp4",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.core.status.url="file://"+nasRoot+"/b.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.opened.length,1);
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries[0].status,"KEEP");
 assert.deepEqual(h.deletedPaths,[]);
});
test("automatic next-file fallback refuses skipped or nonadjacent playlist media",async()=>{
 const h=bootstrap({mountOutput:nasMount,autoFileLoaded:false,
   listOverride:p=>p===nasRoot?["a.mp4","b.mp4","c.mp4"].map(filename=>({
     filename,path:"/"+filename,isDir:false
   })):[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,99.6]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.core.status.url="file://"+nasRoot+"/c.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).keptCount,0);
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries[0].status,"PENDING");
});
test("payload-free native end-file with true eof-reached flag keeps last Review item",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.mpvFlags["eof-reached"]=true;
 h.core.status.url="";
 h.core.status.position=0;
 h.core.status.duration=0;
 h.callbacks["event:mpv.end-file"]?.();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 h.callbacks["event:mpv.end-file"]?.();
 assert.equal(reviewState(h).keptCount,1);
});
test("IINA event-shape regression: seek-only terminal trace with synthetic positions keeps once",async()=>{
 const h=bootstrap({autoFileLoaded:false,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?["a.mp4","b.mp4"].map(filename=>({
     filename,path:"/"+filename,isDir:false
   })):[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,35,50,65,80,95,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.seek"]?.();
 }
 assert.equal(reviewState(h).entries[0].status,"KEEP",
   "repeated seek must preserve the original starting position");
 assert.equal(h.opened.at(-1),nasRoot+"/b.mp4");
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+nasRoot+"/b.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries[0].status,"KEEP");
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.opened.length,2,"one initial open plus exactly one KEEP-next open");
 assert.deepEqual(h.deletedPaths,[]);
});
test("a seek-only trace that never advances to the next item does not KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,35,50,65,80]){
   h.core.status.position=position;
   h.callbacks["event:mpv.seek"]?.();
 }
 h.callbacks["event:mpv.end-file"]?.();
 // No next queue item loaded: nothing proves this item reached its end.
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).keptCount,0);
});
test("zero-position seek during a video switch never auto-KEEPS an unwatched file",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 // An mpv end-file may describe a deleted/stopped video while the seek
 // probe for the current Review item is still at its first frame.
 h.core.status.position=0;
 h.callbacks["event:mpv.seek"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).keptCount,0);
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).entries[1].status,"PENDING");
});
test("a forward seek that ends the file and advances to the next item KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,35,50,65,80]){
   h.core.status.position=position;
   h.callbacks["event:mpv.seek"]?.();
 }
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("a backward drag followed by the automatic advance never KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,40,80,95]){
   h.core.status.position=position;
   h.callbacks["event:mpv.seek"]?.();
 }
 h.core.status.position=40;
 h.callbacks["event:mpv.seek"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).keptCount,0);
});
test("natural completion keeps once when IINA pauses on the terminal sample before advancing",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 // IINA may publish the final time-pos sample with pause already set.
 h.core.status.paused=true;
 h.core.status.position=99.9;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.paused=false;
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(h.opened.length,1,"the already loaded next item must not be reopened");
});
test("terminal observation survives an unpaused unload before payload-free end-file and next load",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 assert.equal(reviewState(h).keptCount,0);
 // Hypothesis: an unload reset arrives while IINA still reports unpaused.
 h.core.status.position=0;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 // Public end-file has no reason and mpv position/duration are unavailable.
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(h.opened.length,1,"the already loaded next item must not reopen");
});
test("an explicit seek to zero after terminal observation never KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.core.status.position=0;
 h.callbacks["event:mpv.seek"]?.();
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).keptCount,0);
});
test("natural completion keeps once when the unloaded player reports zero position",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.core.status.paused=true;
 h.core.status.position=0;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.paused=false;
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("an explicit seek into the terminal tail followed by the EV advance KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=90;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=99.5;
 h.callbacks["event:mpv.seek"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("retreating from the terminal tail before the advance never KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [96,97,98,99]){
   h.core.status.position=position;
   h.callbacks["event:mpv.time-pos.changed"]?.();
 }
 h.core.status.position=40;
 h.callbacks["event:mpv.seek"]?.();
 h.core.status.position=40.5;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).keptCount,0);
});
test("payload-free end-file position probe supplies terminal evidence for the advance",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.mpvNumbers["time-pos"]=99.7;
 h.mpvNumbers["duration"]=100;
 h.callbacks["event:mpv.end-file"]?.();
 h.mpvNumbers["time-pos"]=undefined;
 h.mpvNumbers["duration"]=undefined;
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("payload-free end-file probe of a mid-video position never KEEPs",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.mpvNumbers["time-pos"]=40;
 h.mpvNumbers["duration"]=100;
 h.callbacks["event:mpv.end-file"]?.();
 h.mpvNumbers["time-pos"]=undefined;
 h.mpvNumbers["duration"]=undefined;
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).keptCount,0);
});
test("drag to the end while the cached position lags still KEEPs through the mpv destination",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,40,60,80,95,99]){
   // core.status lags one drag step behind; mpv already reports the target.
   h.mpvNumbers["time-pos"]=position;
   h.core.status.position=position===99?95:position;
   h.callbacks["event:mpv.seek"]?.();
 }
 h.mpvNumbers["time-pos"]=undefined;
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("drag to the end with a stale position is rescued by the end-file mpv probe",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,40,60,80,95,99]){
   h.core.status.position=position===99?95:position;
   h.callbacks["event:mpv.seek"]?.();
 }
 // The probe and the final seek share one millisecond; ordering must not
 // depend on the wall clock.
 h.mpvNumbers["time-pos"]=99.9;
 h.mpvNumbers["duration"]=100;
 h.callbacks["event:mpv.end-file"]?.();
 h.mpvNumbers["time-pos"]=undefined;
 h.mpvNumbers["duration"]=undefined;
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
});
test("drag whose terminal destination is never published still KEEPs on the advance",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 for(const position of [5,20,40,60,80,95,99]){
   // IINA never publishes the drag destination: every seek reports the
   // previous position, so no source knows the true target.
   h.core.status.position=position===99?95:position;
   h.callbacks["event:mpv.seek"]?.();
 }
 h.callbacks["event:mpv.end-file"]?.();
 h.core.status.url="file://"+root+"/video10.mp4";
 h.core.status.position=0;
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).entries[0].status,"KEEP");
 assert.equal(reviewState(h).keptCount,1);
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
test("stale EOF after foreign media and mid-video seek do not mark a Review item KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 h.core.status.position=20;
 h.callbacks["event:mpv.time-pos.changed"]?.();
 h.core.status.position=80;
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
 assert.equal(h.alerts.length,1,"plain D must request consent");
 assert.equal(h.deletedPaths.length,0,"declined D must not issue /bin/rm");
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
 const h=bootstrap({mountOutput:nasMount,confirmAll:true,listOverride:(path)=>{
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
 assert.equal(h.store.has("nasSMBVideoDeleteQueueV1"),true,
   "refused D must still have a durable non-destructive failure entry");
 assert.equal(h.store.has("nasExperimentalDeleteJournalV1"),false,
   "unverified metadata must fail before any rm intent");
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
test("NAS backup defaults ON for newly verified SMB Review, even when legacy toggle was false for another root",async()=>{
 const store=new Map([
   ["nasReviewDirectoryBackupEnabledV1",false],
   ["nasReviewDirectoryBackupRootV1","/Volumes/Another/Review"],
   ["nasReviewDirectoryBackupWriterV1","writer-existing"],
   ["nasReviewDirectoryBackupPausedRootsV1",'["/Volumes/Another/Review"]']
 ]);
 const files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 const saved=files.get(nasRoot+"/.iina-nas-review/review-state.v1.json");
 assert.ok(saved?.content,"a verified new SMB Review should mirror by default");
 assert.equal(JSON.parse(saved.content).entries[0].status,"KEEP");
 assert.equal(reviewState(h).nasBackupEnabled,true);
});
test("corrupt per-folder pause preferences fail closed rather than overwriting NAS",async()=>{
 const store=new Map([["nasReviewDirectoryBackupPausedRootsV1","not-json"]]);
 const files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reviewState(h).nasBackupEnabled,false);
 assert.equal(files.size,0,"invalid settings must never trigger automatic NAS writes");
 assert.equal(reviewState(h).keptCount,1,"local KEEP still works");
});
test("NAS backup defaults ON and mirrors KEEP into its verified hidden folder",async()=>{
 const store=new Map(),files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).nasBackupEnabled,true);
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 const saved=files.get(nasRoot+"/.iina-nas-review/review-state.v1.json");
 assert.ok(saved?.content);
 assert.equal(JSON.parse(saved.content).entries[0].status,"KEEP");
 assert.equal(JSON.parse(saved.content).cursor,1);
 assert.equal(saved.content.includes("/Volumes/Movies"),false);
 assert.equal(h.messages.filter(x=>x.name==="nas-backup-status").at(-1)?.data?.status,
   "synced");
 assert.deepEqual(h.deletedPaths,[]);
});
test("manually pausing NAS backup persists across restarts; explicitly re-enable resumes synchronization",async()=>{
 const store=new Map(),files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["review-nas-backup-enable"]({enabled:false});
 assert.equal(reviewState(h).nasBackupEnabled,false);
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(files.has(nasRoot+"/.iina-nas-review/review-state.v1.json"),false);
 const restarted=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await restarted.callbacks["review-ready"]();
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reviewState(restarted).nasBackupEnabled,false);
 assert.equal(files.has(nasRoot+"/.iina-nas-review/review-state.v1.json"),false);
 restarted.callbacks["review-nas-backup-enable"]({enabled:true});
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reviewState(restarted).nasBackupEnabled,true);
 assert.equal(JSON.parse(files.get(nasRoot+"/.iina-nas-review/review-state.v1.json").content)
   .entries[0].status,"KEEP");
});
test("NAS-side write failure leaves local KEEP intact; next startup retries the backup",async()=>{
 const store=new Map(),files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   nasSidecarWriteFails:true,listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(files.has(nasRoot+"/.iina-nas-review/review-state.v1.json"),false);
 const restarted=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await restarted.callbacks["review-ready"]();
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 const saved=files.get(nasRoot+"/.iina-nas-review/review-state.v1.json");
 assert.ok(saved?.content);
 assert.equal(JSON.parse(saved.content).entries[0].status,"KEEP");
 assert.deepEqual(restarted.deletedPaths,[]);
});
test("manual NAS import recovers lost local KEEP without opening or deleting any media",async()=>{
 const store=new Map(),files=new Map();
 const rows=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const h=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.callbacks["review-keep"]({}),true);
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(files.has(nasRoot+"/.iina-nas-review/review-state.v1.json"));
 store.delete("nasSMBReviewCheckpointV1");
 const restarted=bootstrap({store,mountOutput:nasMount,nasSidecarFiles:files,
   listOverride:p=>p===nasRoot?rows:[]});
 await restarted.callbacks["review-nas-backup-import"]({path:nasRoot});
 assert.equal(reviewState(restarted).active,true);
 assert.equal(reviewState(restarted).keptCount,1);
 assert.equal(reviewState(restarted).cursor,1);
 assert.deepEqual(restarted.deletedPaths,[]);
 assert.deepEqual(restarted.opened,[]);
});
test("Mac reboot and SMB remount restore pending KEEP when stat device id changes",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const initial=bootstrap({store,mountOutput:nasMount,mountDevice:18,
   listOverride:p=>p===nasRoot?listed:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 assert.equal(initial.callbacks["review-keep"]({}),true);
 const old=store.get("nasSMBReviewCheckpointV1");
 assert.equal(JSON.parse(old).rootIdentity,"40755|18|23");
 const rebooted=bootstrap({store,mountOutput:nasMount,mountDevice:66,
   listOverride:p=>p===nasRoot?listed:[]});
 await rebooted.callbacks["review-ready"]();
 const state=reviewState(rebooted);
 assert.equal(state.active,true,"resume must not be blocked by volatile SMB device id");
 assert.equal(state.keptCount,1);
 assert.equal(state.cursor,1);
 assert.equal(state.resumeAvailable,true);
 assert.equal(JSON.parse(store.get("nasSMBReviewCheckpointV1")).rootIdentity,
   "40755|66|23","new checkpoint should capture current mount identity");
 assert.deepEqual(rebooted.opened,[],"startup recovery must not auto-open videos");
 assert.deepEqual(rebooted.deletedPaths,[],"never delete media during recovery");
});
test("Mac reboot still refuses different SMB share or root inode even if mount path is unchanged",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const first=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await first.callbacks["review-start"]({path:nasRoot});
 assert.equal(first.callbacks["review-keep"]({}),true);
 const original=store.get("nasSMBReviewCheckpointV1");
 const rebooted=bootstrap({store,mountOutput:nasMount,mountDevice:66,
   mountRootInode:88,listOverride:p=>p===nasRoot?listed:[]});
 await rebooted.callbacks["review-ready"]();
 assert.equal(reviewState(rebooted).active,false);
 assert.equal(reviewState(rebooted).resumeAvailable,true);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),original);
});
test("reopening sidebar after mounting SMB retries a failed startup recovery without losing KEEP",async()=>{
 const store=new Map();
 const listed=[{filename:"a.mp4",path:"/a.mp4",isDir:false},
   {filename:"b.mp4",path:"/b.mp4",isDir:false}];
 const initial=bootstrap({store,mountOutput:nasMount,
   listOverride:p=>p===nasRoot?listed:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 assert.equal(initial.callbacks["review-keep"]({}),true);
 const original=store.get("nasSMBReviewCheckpointV1");
 const network={value:""};
 const rebooted=bootstrap({store,mountOutput:network,mountDevice:55,
   listOverride:p=>p===nasRoot?listed:[]});
 await rebooted.callbacks["review-ready"]();
 assert.equal(reviewState(rebooted).active,false);
 assert.equal(reviewState(rebooted).resumeAvailable,true);
 assert.equal(store.get("nasSMBReviewCheckpointV1"),original);
 network.value=nasMount;
 await rebooted.callbacks["review-ready"]();
 assert.equal(reviewState(rebooted).active,true,
   "sidebar reopen after remount must retry the same saved queue");
 assert.equal(reviewState(rebooted).keptCount,1);
 assert.equal(reviewState(rebooted).cursor,1);
 assert.deepEqual(rebooted.opened,[]);
 assert.deepEqual(rebooted.deletedPaths,[]);
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

test("resume skips reserved UNKNOWN and PAUSED entries to reattach to already loaded next video",async()=>{
 const store=new Map();
 const rows=["sample.mkv","second.mkv","third.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const initial=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,listOverride:p=>p===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const checkpoint=JSON.parse(store.get("nasSMBReviewCheckpointV1"));
 // An earlier buggy restore overwrote the cursor with the oldest UNKNOWN.
 checkpoint.cursor=0;
 checkpoint.revision++;
 store.set("nasSMBReviewCheckpointV1",JSON.stringify(checkpoint));
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({version:1,jobs:[
   {id:"running-first",status:"RUNNING",root:nasRoot,
    path:nasRoot+"/sample.mkv",name:"sample.mkv",index:0,
    binding:checkpoint.mountBinding,queueKey:"old"},
   {id:"queued-second",status:"QUEUED",root:nasRoot,
    path:nasRoot+"/second.mkv",name:"second.mkv",index:1,
    binding:checkpoint.mountBinding,queueKey:"old"}
 ]}));
 const restored=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?rows:[]});
 restored.core.status.url="file://"+nasRoot+"/third.mkv";
 restored.callbacks["event:iina.file-loaded"]();
 await restored.callbacks["review-ready"]();
 const state=reviewState(restored);
 assert.equal(state.cursor,2,"resume can reattach to the next unreserved media");
 assert.equal(state.playbackMatched,true);
 assert.equal(state.entries[0].status,"UNKNOWN");
 assert.equal(state.entries[1].status,"PAUSED");
 assert.equal(state.entries[2].status,"PENDING");
 assert.deepEqual(restored.opened,[],"restore must not change IINA native playback");
 assert.deepEqual(restored.deletedPaths,[]);
});
test("confirmed cancellation of paused jobs exits without deletion or clearing checkpoint",async()=>{
 const store=new Map();
 const rows=["sample.mkv","second.mkv"].map(filename=>({filename,path:"/"+filename,isDir:false}));
 const initial=bootstrap({store,mountOutput:nasMount,listOverride:p=>p===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const checkpoint=store.get("nasSMBReviewCheckpointV1");
 const binding=JSON.parse(checkpoint).mountBinding;
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({version:1,jobs:[{
   id:"unissued",status:"QUEUED",root:nasRoot,path:nasRoot+"/sample.mkv",
   name:"sample.mkv",index:0,binding,queueKey:"old"}]}));
 const h=bootstrap({store,mountOutput:nasMount,confirmAll:true,listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-ready"]();
 const resumedCheckpoint=store.get("nasSMBReviewCheckpointV1");
 h.callbacks["review-cancel-unissued-and-exit"]();
 assert.equal(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs[0].status,"CANCELLED");
 assert.equal(store.get("nasSMBReviewCheckpointV1"),resumedCheckpoint);
 assert.equal(reviewState(h).active,false);
 assert.deepEqual(h.deletedPaths,[]);
 assert.ok(h.messages.some(m=>m.name==="review-cancel-exit-complete"));
});
test("cancellation preserves UNKNOWN and refuses to exit",async()=>{
 const store=new Map();
 const rows=["sample.mkv","second.mkv"].map(filename=>({filename,path:"/"+filename,isDir:false}));
 const initial=bootstrap({store,mountOutput:nasMount,listOverride:p=>p===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const binding=JSON.parse(store.get("nasSMBReviewCheckpointV1")).mountBinding;
 const job=(id,index,status)=>({id,status,root:nasRoot,path:nasRoot+"/"+rows[index].filename,
   name:rows[index].filename,index,binding,queueKey:"old"});
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({version:1,jobs:[job("running",0,"RUNNING"),job("waiting",1,"QUEUED")]}));
 const h=bootstrap({store,mountOutput:nasMount,confirmAll:true,listOverride:p=>p===nasRoot?rows:[]});
 await h.callbacks["review-ready"]();
 h.callbacks["review-cancel-unissued-and-exit"]();
 assert.deepEqual(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs.map(j=>j.status),["UNKNOWN","CANCELLED"]);
 assert.equal(reviewState(h).active,true);
 assert.ok(!h.messages.some(m=>m.name==="review-cancel-exit-complete"));
 assert.deepEqual(h.deletedPaths,[]);
});
test("restart with queue UNKNOWN retains last Review cursor and reconciles without legacy UNKNOWN journal",async()=>{
 const store=new Map();
 const rows=["sample.mkv","second.mkv","third.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const initial=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:path=>path===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const checkpoint=JSON.parse(store.get("nasSMBReviewCheckpointV1"));
 // Frontend accepted D and moved to B, but A was RUNNING at process exit.
 checkpoint.cursor=1;
 checkpoint.revision++;
 store.set("nasSMBReviewCheckpointV1",JSON.stringify(checkpoint));
 const first={root:nasRoot,path:nasRoot+"/sample.mkv",name:"sample.mkv",
   index:0,binding:checkpoint.mountBinding,queueKey:"session-original",
   id:"previous-running-A",status:"RUNNING"};
 const next={root:nasRoot,path:nasRoot+"/third.mkv",name:"third.mkv",
   index:2,binding:checkpoint.mountBinding,queueKey:"session-original",
   id:"previous-queued-C",status:"QUEUED"};
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({
   version:1,jobs:[first,next]
 }));
 // The one-slot legacy journal was already overwritten by a later task,
 // so its state is not UNKNOWN and its queue ID does not refer to A.
 store.set("nasExperimentalDeleteJournalV1",JSON.stringify({
   id:"recent-journal",state:"RM_EXIT_ZERO",queueId:"other-task",
   cursor:2,mountIdentity:checkpoint.mountBinding
 }));
 const restarted=bootstrap({store,mountOutput:nasMount,
   experimentalDeleteMock:true,listOverride:path=>path===nasRoot?rows:[]});
 await restarted.callbacks["review-ready"]();
 const before=reviewState(restarted);
 assert.equal(before.cursor,1,
   "an UNKNOWN job must not silently rewind the saved active Review cursor");
 assert.equal(before.deleteQueuePending,2);
 assert.equal(before.deleteQueueBlocked,true);
 assert.equal(before.entries[0].status,"UNKNOWN");
 assert.equal(before.entries[2].status,"PAUSED");
 assert.equal(before.deleteQueueStatus,"BLOCKED");
 assert.equal(before.deleteQueueCanClose,false);
 assert.equal(before.deleteQueueUnknown,1);
 assert.equal(before.deleteQueuePaused,1);
 const oldRmCalls=restarted.deletedPaths.length;
 const acknowledged=await restarted.callbacks[
   "review-delete-test-acknowledge-unknown"]({});
 assert.equal(acknowledged.status,"ACKNOWLEDGED",
   "the recovery control must reconcile the durable queue job, not just legacy journal");
 assert.equal(acknowledged.missingSkipped,false);
 const after=reviewState(restarted);
 assert.equal(after.deleteQueueBlocked,false);
 assert.equal(after.deleteQueuePaused,1,
   "unissued jobs remain PAUSED, never automatically retried");
 assert.equal(after.deleteQueueStatus,"PAUSED");
 assert.equal(after.deleteQueueCanClose,false);
 assert.equal(after.cursor,1);
 assert.equal(after.entries[0].status,"PENDING");
 assert.equal(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs[0].status,
   "RECONCILED");
 assert.equal(restarted.deletedPaths.length,oldRmCalls);
 assert.deepEqual(restarted.opened,[],"reconciliation must not alter native IINA playback");
});
test("UNKNOWN queue job with missing target can reconcile without legacy journal or rm retry",async()=>{
 const store=new Map();
 const rows=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const initial=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:path=>path===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const checkpoint=JSON.parse(store.get("nasSMBReviewCheckpointV1"));
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({
   version:1,jobs:[{root:nasRoot,path:nasRoot+"/sample.mkv",name:"sample.mkv",
     index:0,binding:checkpoint.mountBinding,queueKey:"older",
     id:"unknown-missing-A",status:"RUNNING"}]
 }));
 store.set("nasExperimentalDeleteJournalV1",JSON.stringify({
   state:"RM_EXIT_ZERO",id:"unrelated",queueId:"other-task",cursor:1,
   mountIdentity:checkpoint.mountBinding
 }));
 const reloaded=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   multiDeleteFiles:[nasRoot+"/z-next.mkv"],
   listOverride:path=>path===nasRoot?rows:[]});
 await reloaded.callbacks["review-ready"]();
 const before=reviewState(reloaded);
 assert.equal(before.entries[0].status,"UNKNOWN");
 assert.equal(before.deleteQueueBlocked,true);
 const result=await reloaded.callbacks[
   "review-delete-test-acknowledge-unknown"]({});
 assert.equal(result.status,"ACKNOWLEDGED");
 assert.equal(result.missingSkipped,true);
 const after=reviewState(reloaded);
 assert.equal(after.entries[0].status,"DELETED");
 assert.equal(after.entries[1].status,"PENDING");
 assert.equal(after.cursor,1);
 assert.equal(after.deleteQueueBlocked,false);
 assert.equal(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs[0].status,
   "RECONCILED");
 assert.deepEqual(reloaded.deletedPaths,[]);
 assert.deepEqual(reloaded.opened,[]);
});
test("matching legacy UNKNOWN journal and durable task both clear on explicit confirmation",async()=>{
 const store=new Map();
 const rows=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const first=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:path=>path===nasRoot?rows:[]});
 await first.callbacks["review-start"]({path:nasRoot});
 const saved=JSON.parse(store.get("nasSMBReviewCheckpointV1"));
 const job={root:nasRoot,path:nasRoot+"/sample.mkv",name:"sample.mkv",
   index:0,binding:saved.mountBinding,queueKey:"prior",
   id:"same-unknown-job",status:"RUNNING"};
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({version:1,jobs:[job]}));
 store.set("nasExperimentalDeleteJournalV1",JSON.stringify({
   state:"UNKNOWN",id:"legacy-same",queueId:job.id,cursor:0,
   mountIdentity:saved.mountBinding,rootIdentity:saved.rootIdentity
 }));
 const restarted=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:path=>path===nasRoot?rows:[]});
 await restarted.callbacks["review-ready"]();
 const result=await restarted.callbacks[
   "review-delete-test-acknowledge-unknown"]({});
 assert.equal(result.status,"ACKNOWLEDGED");
 assert.equal(reviewState(restarted).deleteRecoveryPending,false);
 assert.equal(JSON.parse(store.get("nasExperimentalDeleteJournalV1")).state,
   "MANUALLY_RECONCILED");
 assert.equal(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs[0].status,
   "RECONCILED");
 assert.deepEqual(restarted.deletedPaths,[]);
});
test("crash after rm exit zero reconciles a RUNNING queue task without reissuing delete",async()=>{
 const store=new Map(),rows=["sample.mkv","z-next.mkv"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 }));
 const initial=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?rows:[]});
 await initial.callbacks["review-start"]({path:nasRoot});
 const checkpoint=JSON.parse(store.get("nasSMBReviewCheckpointV1"));
 const task={root:nasRoot,path:nasRoot+"/sample.mkv",index:0,
   binding:checkpoint.mountBinding,queueKey:"previous-review",name:"sample.mkv",
   id:"crash-after-zero",status:"RUNNING"};
 store.set("nasSMBVideoDeleteQueueV1",JSON.stringify({version:1,jobs:[task]}));
 store.set("nasExperimentalDeleteJournalV1",JSON.stringify({
   state:"RM_EXIT_ZERO",id:"old-rm",queueId:task.id,cursor:0,
   mountIdentity:checkpoint.mountBinding,rootIdentity:checkpoint.rootIdentity,
   fileIdentity:"100644|18|23|12|1000"
 }));
 const reloaded=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureButTargetMissing:true,initialMediaExists:false,
   listOverride:p=>p===nasRoot?rows:[]});
 await reloaded.callbacks["review-ready"]();
 assert.equal(reviewState(reloaded).entries[0].status,"DELETED");
 assert.equal(reviewState(reloaded).deletedCount,1);
 assert.equal(reviewState(reloaded).deleteQueueBlocked,false);
 assert.equal(JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs[0].status,
   "RECONCILED");
 assert.deepEqual(reloaded.deletedPaths,[],"restart recovery must not issue rm");
 assert.deepEqual(reloaded.opened,[],"restart recovery must not autoplay media");
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
 assert.equal(reviewState(restarted).cursor,1,
   "UNKNOWN must not rewind the foreground Review cursor after D advanced");
 assert.equal(reviewState(restarted).entries[0].status,"UNKNOWN",
   "the queue overlays the unresolved state without relabeling Review progress");
 assert.equal(JSON.parse(store.get("nasSMBReviewCheckpointV1")).entries[0].status,"PENDING");
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
test("Directory mode bridges two native confirmations and recursive rm only on the selected SMB child",async()=>{
 const store=new Map([["nasReviewSkipDeleteConfirmationV1","true"]]);
 const h=bootstrap({store,directoryDeleteMock:true,mountOutput:nasMount});
 const enable=await h.callbacks["directory-mode"]({enabled:true,root:nasRoot});
 assert.equal(enable.enabled,true);
 assert.equal(h.messages.filter(x=>x.name==="directory-mode-state").at(-1).data.enabled,true);
 const rejected=await h.callbacks["directory-delete"]({
   root:nasRoot,parent:nasRoot,name:".."
 });
 assert.equal(rejected.status,"REFUSED");
 assert.deepEqual(h.deletedPaths,[]);
 const result=await h.callbacks["directory-delete"]({
   root:nasRoot,parent:nasRoot,name:"Season 1"
 });
 assert.equal(result.status,"DELETED",result.reason);
 assert.equal(result.observedAbsent,true);
 assert.equal(h.alerts.length,2,
   "the video skip-confirmation preference cannot bypass either folder prompt");
 assert.match(h.alerts[0],/\/Volumes\/Movies\/Review\/Season 1/);
 assert.match(h.alerts[1],/\/Volumes\/Movies\/Review\/Season 1/);
 assert.deepEqual(h.deletedPaths,[nasRoot+"/Season 1"]);
 assert.equal(JSON.parse(store.get("nasDirectoryDeleteJournalV1")).state,"DELETED_OBSERVED");
 assert.equal(h.messages.filter(x=>x.name==="directory-delete-result").at(-1).data.status,"DELETED");
});
test("D D D followed by K keeps playback moving and serializes durable deletion results",async()=>{
 let finishFirst;
 const rmDeferred={started:false,promise:new Promise(resolve=>{finishFirst=resolve;})};
 const names=["sample.mkv","z-next.mkv","zz-third.mkv","zzz-keep.mkv"];
 const store=new Map();
 const h=bootstrap({store,mountOutput:nasMount,experimentalDeleteMock:true,rmDeferred,
   multiDeleteFiles:names.map(name=>nasRoot+"/"+name),
   listOverride:p=>p===nasRoot?names.map(filename=>({
     filename,path:"/"+filename,isDir:false})):[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.opened.at(-1),nasRoot+"/sample.mkv");
 const first=h.callbacks["review-delete"]({});
 assert.equal(h.opened.at(-1),nasRoot+"/z-next.mkv");
 for(let i=0;i<10&&!rmDeferred.started;i++)
   await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rmDeferred.started,true,
   "second D must remain available after the first rm enters RUNNING");
 const second=h.callbacks["review-delete"]({});
 assert.equal(h.opened.at(-1),nasRoot+"/zz-third.mkv");
 const third=h.callbacks["review-delete"]({});
 assert.equal(h.opened.at(-1),nasRoot+"/zzz-keep.mkv");
 assert.equal(h.callbacks["review-keep"]({}),true,
   "KEEP must work while the oldest /bin/rm is pending");
 assert.deepEqual(reviewState(h).entries.map(x=>x.status),
   ["RUNNING","QUEUED","QUEUED","KEEP"]);
 for(let i=0;i<10&&!rmDeferred.started;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rmDeferred.started,true);
 assert.deepEqual(h.deletedPaths,[],"single worker must not send later rm early");
 assert.equal(reviewState(h).deletedCount,0);
 finishFirst({status:0,stderr:""});
 assert.equal(reviewState(h).deleteQueueStatus,"WORKING",
   "an in-flight command must never be displayed as queue complete");
 assert.equal(reviewState(h).deleteQueueCanClose,false);
 assert.equal(reviewState(h).deleteQueueRunning,1);
 assert.equal(reviewState(h).deleteQueueWaiting,2);
 const results=await Promise.all([first,second,third]);
 assert.ok(results.every(x=>x.status==="VERIFIED_DELETED"),JSON.stringify(results));
 assert.deepEqual(h.deletedPaths,names.slice(0,3).map(name=>nasRoot+"/"+name));
 assert.equal(reviewState(h).deletedCount,3);
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).remainingCount,1);
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.equal(h.opened.length,4,"background commits must not reopen videos");
 const tasks=JSON.parse(store.get("nasSMBVideoDeleteQueueV1")).jobs;
 assert.deepEqual(tasks.map(x=>x.status),["DELETED","DELETED","DELETED"]);
 assert.equal(reviewState(h).deleteQueueStatus,"COMPLETE");
 assert.equal(reviewState(h).deleteQueueCanClose,true,
   "complete means all delete outcomes were durably committed");
 assert.equal(reviewState(h).deleteQueueWaiting,0);
 assert.equal(reviewState(h).deleteQueueRunning,0);
 assert.equal(reviewState(h).deleteQueueDeleted,3);
});
test("SMB rm dispatch starts next playback before command completion or postchecks",async()=>{
 let resolveRm;
 const rmDeferred={started:false,promise:new Promise(resolve=>{resolveRm=resolve;})};
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,rmDeferred,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.opened.length,1);
 const request=h.callbacks["review-delete"]({});
 for(let i=0;i<10 && !rmDeferred.started;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rmDeferred.started,true,"simulated SMB rm must be dispatched");
 assert.deepEqual(h.opened,[nasRoot+"/sample.mkv",nasRoot+"/z-next.mkv"],
   "next video must be requested while rm promise is unresolved");
 assert.equal(reviewState(h).entries[0].status,"RUNNING",
   "in-flight deletion is displayed separately from the checkpoint");
 assert.equal(JSON.parse(h.store.get("nasSMBReviewCheckpointV1")).entries[0].status,"PENDING");
 assert.equal(reviewState(h).deletedCount,0);
 assert.equal(h.callbacks["review-keep"]({}),true,
   "KEEP must remain operational during an in-flight delete");
 assert.equal(reviewState(h).keptCount,1);
 h.callbacks["review-exit"]({});
 assert.equal(reviewState(h).active,true,"cannot exit and invalidate a pending delete");
 assert.equal(reviewState(h).deleteQueuePending,1,
   "the original rm remains running and has not yet changed its review status");
 resolveRm({status:0,stderr:"",stdout:""});
 const result=await request;
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(reviewState(h).entries[0].status,"DELETED");
 assert.equal(reviewState(h).phase,"COMPLETE");
 assert.deepEqual(h.opened,[nasRoot+"/sample.mkv",nasRoot+"/z-next.mkv"],
   "confirmed delete must not reopen a video already started");
});
test("SMB command failure after early playback preserves the original pending Review item",async()=>{
 let resolveRm;
 const rmDeferred={started:false,promise:new Promise(resolve=>{resolveRm=resolve;})};
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,rmDeferred,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false},
     {filename:"z-next.mkv",path:"/z-next.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const request=h.callbacks["review-delete"]({});
 for(let i=0;i<10&&!rmDeferred.started;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rmDeferred.started,true);
 assert.equal(h.opened.at(-1),nasRoot+"/z-next.mkv");
 resolveRm({status:1,stderr:"rm: Permission denied",stdout:""});
 const result=await request;
 assert.equal(result.status,"COMMAND_FAILED");
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(reviewState(h).cursor,1,
   "the foreground Review cursor stays on the next video after failed rm");
 assert.equal(reviewState(h).deletedCount,0);
 assert.deepEqual(h.deletedPaths,[],"failed rm never claims a removal");
 assert.equal(reviewState(h).deleteQueueStatus,"COMPLETE_WITH_WARNINGS");
 assert.equal(reviewState(h).deleteQueueCanClose,true,
   "a settled failure needs no running IINA but is not a deletion success");
 assert.equal(reviewState(h).deleteQueueFailed,1);
});
test("SMB Review D directly requests an individual confirmation, without mode toggle or canary",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(reviewState(h).deletionSupported,true);
 assert.equal(h.callbacks["review-delete-test-mode"],undefined);
 assert.equal(reviewState(h).deleteQueueStatus,"IDLE",
   "no deletion tasks yet is not a completed deletion queue");
 assert.equal(reviewState(h).deleteQueueCanClose,false);
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
test("optional skip-confirmation setting persists and deletes via guarded D without modal",async()=>{
 const store=new Map();
 const options={store,mountOutput:nasMount,experimentalDeleteMock:true,
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]};
 const h=bootstrap(options);
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(reviewState(h).skipDeleteConfirmation,false);
 assert.equal(h.callbacks["review-delete-confirmation-setting"](true),true);
 assert.equal(store.get("nasReviewSkipDeleteConfirmationV1"),"true");
 assert.equal(reviewState(h).skipDeleteConfirmation,true);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(h.alerts.length,0,"skip mode does not issue routine confirmation");
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
 assert.equal(JSON.parse(store.get("nasExperimentalDeleteJournalV1")).state,"RM_EXIT_ZERO");
 const restarted=bootstrap(options);
 restarted.callbacks["review-ready"]({});
 assert.equal(reviewState(restarted).skipDeleteConfirmation,true,
   "the setting survives a plugin restart");
 assert.equal(restarted.callbacks["review-delete-confirmation-setting"](false),true);
 assert.equal(store.get("nasReviewSkipDeleteConfirmationV1"),"false");
 assert.equal(reviewState(restarted).skipDeleteConfirmation,false);
});
test("skip-confirmation still reports background deletion failure without blocking playback",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureStatus:1,rmFailureStderr:"rm: Permission denied",
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 h.callbacks["review-delete-confirmation-setting"](true);
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"COMMAND_FAILED");
 assert.equal(h.alerts.length,0,"background failure must not interrupt the player with a modal");
 assert.match(reviewState(h).deleteQueueNotice,/Permission denied/);
 assert.deepEqual(h.deletedPaths,[]);
});
test("nonzero rm with unchanged file reports a visible queue failure, not UNKNOWN",async()=>{
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,
   rmFailureStatus:1,rmFailureStderr:"rm: /Volumes/Movies/Review/sample.mkv: Permission denied\n",
   listOverride:p=>p===nasRoot?
     [{filename:"sample.mkv",path:"/sample.mkv",isDir:false}]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 const result=await h.callbacks["review-delete"]({});
 assert.equal(result.status,"COMMAND_FAILED");
 assert.equal(result.exitCode,1);
 assert.equal(h.alerts.length,1,"only the initial confirmation should be modal");
 assert.match(reviewState(h).deleteQueueNotice,/Permission denied/);
 assert.match(reviewState(h).deleteQueueNotice,/code 1/i);
 assert.doesNotMatch(reviewState(h).deleteQueueNotice,/\/Volumes\/Movies\/Review/);
 assert.equal(reviewState(h).deletedCount,0);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,"CONFIRMED_FAILED");
 assert.deepEqual(h.deletedPaths,[]);
});
test("nonzero rm with uncertain target pauses queue as UNKNOWN without extra modal",async()=>{
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
 assert.equal(h.alerts.length,1,"no modal interrupts continued playback");
 assert.match(reviewState(h).deleteQueueNotice,/UNKNOWN/);
 assert.equal(reviewState(h).deleteQueueBlocked,true);
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
 assert.equal(result.status,"UNKNOWN",
   "rm exit 0 does not imply a durably committed Review decision");
 assert.equal(result.nextPlayback,"PROGRESS_SAVE_FAILED");
 assert.match(reviewState(h).deleteQueueNotice,/rm succeeded.*checkpoint.*could NOT be saved/i);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).deletedCount,0);
 assert.equal(JSON.parse(h.store.get("nasExperimentalDeleteJournalV1")).state,
   "RM_EXIT_ZERO");
 assert.equal(h.deletedPaths.length,1);
 assert.equal((await h.callbacks["review-delete"]({})).reason,"UNRESOLVED_OPERATION");
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
 const beforeReconcilePlayback=h.opened.length;
 const resolution=await h.callbacks["review-delete-test-acknowledge-unknown"]({});
 assert.equal(resolution.status,"ACKNOWLEDGED");
 assert.equal(resolution.missingSkipped,true);
 assert.equal(reviewState(h).entries[0].status,"DELETED");
 assert.equal(reviewState(h).entries[1].status,"PENDING");
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).keptCount,originalKeeps);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(beforeReconcilePlayback,2,"delete dispatch already started the next video");
 assert.equal(h.opened.length,beforeReconcilePlayback,
   "reconciliation must not open a third video");
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
 assert.equal(result.nextPlayback,"NOT_ISSUED",
   "the next player open already occurred before /bin/rm finished");
 assert.equal(reviewState(h).deletedCount,1);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).deleteRecoveryPending,false);
 assert.equal(reviewState(h).deleteQueueBlocked,false,
   "playback errors cannot turn a completed rm into UNKNOWN");
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
 assert.match(reviewState(h).error,/previous deletion is unresolved/i);
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
 assert.equal(h.alerts.length,1,"D is delivered and asks for confirmation");
 assert.equal(h.deletedPaths.length,0,"a declined D never issues /bin/rm");
 assert.equal(h.opened.length,1);
 assert.equal(reviewState(h).entries[0].status,"PENDING");
 assert.equal(h.store.has("nasDeleteJournalV1"),false);
});
test("repeat physical D while the same SMB video is already queued reports pending, not Review ERROR",async()=>{
 let finishRm;
 const rmDeferred={started:false,promise:new Promise(resolve=>{finishRm=resolve;})};
 const h=bootstrap({mountOutput:nasMount,experimentalDeleteMock:true,rmDeferred,
   listOverride:p=>p===nasRoot?[
     {filename:"sample.mkv",path:"/sample.mkv",isDir:false}
   ]:[]});
 await h.callbacks["review-start"]({path:nasRoot});
 assert.equal(h.physicalKeyDown("d"),true);
 for(let i=0;i<10&&!rmDeferred.started;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rmDeferred.started,true);
 assert.equal(h.physicalKeyDown("d"),true);
 const state=reviewState(h);
 assert.equal(state.phase,"ACTIVE","an already queued delete is not a Review failure");
 assert.match(state.deleteQueueNotice,/already queued/i);
 assert.equal(state.deleteQueuePending,1);
 finishRm({status:0,stdout:"",stderr:""});
 for(let i=0;i<15&&reviewState(h).deleteQueueStatus!=="COMPLETE";i++)
   await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(h.deletedPaths,[nasRoot+"/sample.mkv"]);
 assert.equal(reviewState(h).deletedCount,1);
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
test("unexpected IINA playlist transition can explicitly attach loaded pending item without KEEP",()=>{
 const h=bootstrap({autoFileLoaded:false,listOverride:p=>p===root?[
  {filename:"video1.mp4",path:"video1.mp4",isDir:false},
  {filename:"video2.mp4",path:"video2.mp4",isDir:false},
  {filename:"video3.mp4",path:"video3.mp4",isDir:false}]:[]});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 h.callbacks["event:iina.file-loaded"]();
 // IINA advances its own playlist unexpectedly to another pending file.
 h.core.status.url="file://"+root+"/video3.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).cursor,1);
 assert.equal(reviewState(h).playbackMatched,false);
 assert.equal(reviewState(h).playbackCanAttach,true);
 assert.equal(h.callbacks["review-attach-playing"]({}),true);
 assert.equal(reviewState(h).cursor,2);
 assert.equal(reviewState(h).playbackMatched,true);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING","PENDING"]);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.deepEqual(reviewState(h).entries.map(e=>e.status),["KEEP","PENDING","KEEP"]);
 assert.equal(reviewState(h).cursor,1);
});
test("failed middle file moves to next pending without changing its status",()=>{
 const h=bootstrap({autoFileLoaded:false,listOverride:p=>p===root?[
  {filename:"video1.mp4",path:"video1.mp4",isDir:false},
  {filename:"video2.mp4",path:"video2.mp4",isDir:false},
  {filename:"video3.mp4",path:"video3.mp4",isDir:false}]:[]});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 h.core.status.url="";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-skip-failed"]({}),true);
 assert.equal(reviewState(h).cursor,2);
 assert.equal(h.opened.at(-1),root+"/video3.mp4");
 assert.deepEqual(reviewState(h).entries.map(x=>x.status),["KEEP","PENDING","PENDING"]);
 assert.equal(h.callbacks["review-keep"]({}),false);
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.deepEqual(reviewState(h).entries.map(x=>x.status),["KEEP","PENDING","KEEP"]);
 assert.equal(reviewState(h).cursor,1,"failed item remains available for later Review");
});
test("confirmed missing-url load can explicitly skip pending item without KEEP or deletion",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 h.core.status.url="";
 h.callbacks["event:iina.file-loaded"]();
 const before=reviewState(h);
 assert.equal(before.playbackLoadFailed,true);
 assert.equal(h.callbacks["review-skip-failed"]({}),false,"only one pending item remains");
 assert.equal(reviewState(h).keptCount,1);
 assert.equal(reviewState(h).cursor,1);
 assert.equal(h.callbacks["review-keep"]({}),false);
});
test("a failed next-file load cannot deadlock explicit pending selection",()=>{
 const h=bootstrap({autoFileLoaded:false});
 h.callbacks["review-start"]({path:root});
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 const saved=h.store.get("nasReviewCheckpointV1");
 h.core.status.url="";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackStatus,"missing_url");
 assert.equal(h.callbacks["review-keep"]({}),false);
 assert.equal(h.callbacks["review-play"]({position:1}),true,"explicit selection must recover a stalled file load");
 assert.equal(h.opened.at(-1),root+"/video10.mp4");
 assert.deepEqual(JSON.parse(h.store.get("nasReviewCheckpointV1")).entries,
   JSON.parse(saved).entries,"selection must preserve KEEP/PENDING");
 assert.equal(h.callbacks["review-keep"]({}),false,"still wait for loaded event"); h.callbacks["event:iina.file-loaded"]();
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
});
test("Resume and Reopen use verified mpv path when IINA status.url is missing",()=>{
 const store=new Map();
 const first=bootstrap({store});
 first.callbacks["review-start"]({path:root});
 first.callbacks["review-keep"]({});
 const h=bootstrap({store,mpvPathFallback:true,autoFileLoaded:false});
 h.callbacks["review-resume"]({path:root});
 assert.equal(reviewState(h).playbackStatus,"missing_url");
 assert.equal(h.callbacks["review-reopen"]({}),true);
 h.core.status.url="";
 h.core.status.playbackPath=root+"/video10.mp4";
 h.callbacks["event:iina.file-loaded"]();
 assert.equal(reviewState(h).playbackMatched,true);
 assert.equal(h.callbacks["review-keep"]({}),true);
 assert.equal(reviewState(h).phase,"COMPLETE");
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
