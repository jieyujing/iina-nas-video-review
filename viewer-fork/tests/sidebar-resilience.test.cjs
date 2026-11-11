"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

function mount({savedTabs="[]",savedDebug=null,bridge=true}={}){
 const vue=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 const source=vue.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(source);
 const handlers={},sent=[],timers=new Map(),domListeners={},clipboard=[];
 let next=0;
 const stored=new Map([["tabs",savedTabs]]);
 if(savedDebug!==null)stored.set("nas-review-debug-v1",savedDebug);
 const storage={
   getItem(key){return stored.get(key)||null;},
   setItem(key,value){stored.set(key,String(value));},
   removeItem(key){stored.delete(key);}
 };
 const iina=bridge?{onMessage(name,handler){handlers[name]=handler;},
   postMessage(name,data){sent.push({name,data});}}:undefined;
 const sandbox={
   module:{exports:{}},window:{iina,
      navigator:{clipboard:{writeText(value){clipboard.push(value);return Promise.resolve();}}},
      addEventListener(name,handler){domListeners[name]=handler;},
      removeEventListener(name,handler){if(domListeners[name]===handler)delete domListeners[name];}},
   localStorage:storage,
   setTimeout(cb){const id=++next;timers.set(id,cb);return id;},
   clearTimeout(id){timers.delete(id);}
 };
 vm.runInNewContext(source[1].replace(/export default/,"module.exports ="),sandbox);
 const definition=sandbox.module.exports;
 const state={...definition.data(),...definition.methods};
 Object.defineProperty(state,"activeTab",{
   get(){return state.tabs.find(t=>t.id===state.activeTabId);}
 });
 for(const key of ["savedSourceTab","canResumeSelected","resumeSourceLabel"]){
   if(definition.computed?.[key]){
     Object.defineProperty(state,key,{get(){return definition.computed[key].call(state);}});
   }
 }
 return {state,definition,handlers,sent,timers,domListeners,stored,clipboard};
}
test("delete queue completion display is explicit and does not confuse idle or blocked with done",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 assert.match(source,/deleteQueueStatus/);
 assert.match(source,/Delete queue complete/);
 assert.match(source,/Safe to close IINA/);
 assert.match(source,/Delete queue idle/);
 assert.match(source,/Deletion blocked/);
 const h=mount();h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",nasReadOnly:true,active:true,
   deleteQueueStatus:"WORKING",deleteQueueCanClose:false,
   deleteQueueRunning:1,deleteQueueWaiting:2,deleteQueueDeleted:0,
   deleteQueueFailed:0,deleteQueueUnknown:0});
 assert.equal(h.state.reviewState.deleteQueueStatus,"WORKING");
 assert.equal(h.state.reviewState.deleteQueueCanClose,false);
 assert.equal(h.state.reviewState.deleteQueueRunning,1);
 h.handlers["review-state"]({phase:"ACTIVE",nasReadOnly:true,active:true,
   deleteQueueStatus:"COMPLETE",deleteQueueCanClose:true,
   deleteQueueRunning:0,deleteQueueWaiting:0,deleteQueueDeleted:3,
   deleteQueueFailed:0,deleteQueueUnknown:0});
 assert.equal(h.state.reviewState.deleteQueueStatus,"COMPLETE");
 assert.equal(h.state.reviewState.deleteQueueCanClose,true);
});
test("compact Review UI puts primary actions, queue status and media list before progressive disclosure",()=>{
 const vue=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 const start=vue.indexOf('<div v-else-if="reviewMode" class="review-panel">');
 const end=vue.indexOf('<div v-else-if="activeTab" class="file-list">',start);
 const markup=vue.slice(start,end);
 assert.ok(start>=0&&end>start);
 const details=markup.indexOf('<details class="review-more"');
 const list=markup.indexOf('ref="reviewList"');
 const primary=markup.indexOf('class="review-primary-actions"');
 const status=markup.indexOf('class="delete-queue-status"');
 const stats=markup.indexOf('class="review-metrics"');
 assert.ok(stats>=0&&primary>stats&&status>primary&&list>status,
   "compact overview must display summary, actions, status and list in order");
 assert.ok(details>list,"help/settings must not push the video list below the fold");
 assert.ok(markup.indexOf('Keep &amp; Next')<details);
 assert.ok(markup.indexOf('Queue Delete (D)')<details);
 assert.ok(markup.indexOf('Reconcile queued UNKNOWN')<details,
   "safety-critical recovery is never hidden");
 assert.ok(markup.indexOf('Skip delete confirmation')<details);
 for(const copy of ["K listener:","Last K:","Automatic for verified SMB Review folders",
                    "D permanently deletes only"]){
   assert.ok(markup.indexOf(copy)>details,copy+" belongs in advanced details");
 }
 assert.ok(markup.indexOf('Pause NAS backup')>details,
   "NAS backup controls stay available but do not occupy the main screen");
 assert.match(markup,/<summary>.*高级/,"more information must be discoverable");
 assert.match(markup,/<button[^>]*@click="openThumbnails"/,
   "Timeline remains available as a secondary control");
});
test("broken saved folder bookmarks do not blank the sidebar",()=>{
 const h=mount({savedTabs:"{invalid json"});
 assert.doesNotThrow(()=>h.definition.mounted.call(h.state));
 assert.equal(h.state.tabs.length,0);
});
test("double-click other tab closes it without first exiting active Review",()=>{
 const h=mount({savedTabs:JSON.stringify([
   {id:10,name:"Active",path:"/Volumes/Media/A",currentPath:"/Volumes/Media/A"},
   {id:20,name:"Other",path:"/Volumes/Media/B",currentPath:"/Volumes/Media/B"}
 ])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=10;
 h.state.reviewMode=true;
 const other=h.state.tabs.find(x=>x.id===20);
 h.state.onTabClick(other);
 h.state.onTabDoubleClick(other);
 assert.equal(h.state.reviewMode,true,
   "a double-click elsewhere must not select that tab and exit Review");
 assert.equal(h.state.activeTabId,10);
 assert.deepEqual(Array.from(h.state.tabs.map(x=>x.id)),[10]);
 assert.equal(h.sent.some(x=>x.name==="review-exit"),false);
});
test("single click selects after gesture delay, double-click active/final tab closes",()=>{
 const h=mount({savedTabs:JSON.stringify([
  {id:10,name:"A",path:"/Volumes/Media/A",currentPath:"/Volumes/Media/A"},
  {id:20,name:"B",path:"/Volumes/Media/B",currentPath:"/Volumes/Media/B"}
 ])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=10;
 h.state.onTabClick(h.state.tabs[1]);
 assert.equal(h.state.activeTabId,10);
 for(const callback of [...h.timers.values()])callback();
 assert.equal(h.state.activeTabId,20);
 h.state.onTabClick(h.state.tabs[1]);
 h.state.onTabDoubleClick(h.state.tabs[1]);
 assert.equal(h.state.activeTabId,10);
 assert.equal(h.state.tabs.length,1);
 h.state.onTabClick(h.state.tabs[0]);
 h.state.onTabDoubleClick(h.state.tabs[0]);
 assert.equal(h.state.tabs.length,0);
 assert.equal(h.state.activeTabId,null);
});
test("double clicking the active Review folder closes it through existing Exit guard",()=>{
 const h=mount({savedTabs:JSON.stringify([
  {id:10,name:"Review",path:"/Volumes/Media/Review",currentPath:"/Volumes/Media/Review"},
  {id:20,name:"Other",path:"/Volumes/Media/Other",currentPath:"/Volumes/Media/Other"}
 ])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=10;
 h.state.reviewMode=true;
 h.state.onTabClick(h.state.tabs[0]);
 h.state.onTabDoubleClick(h.state.tabs[0]);
 assert.equal(h.state.reviewMode,false);
 assert.ok(h.sent.some(x=>x.name==="review-exit"));
 assert.equal(h.state.activeTabId,20);
 assert.deepEqual(Array.from(h.state.tabs.map(x=>x.id)),[20]);
});
test("recursion mode does not disable D for the actually playing Review video",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.tabs=[{id:1,currentPath:"/private/tmp/iina-nas-review-fixture-demo"}];
 h.state.activeTabId=1;
 h.state.reviewRecursive=true;
 h.state.startReview();
 const start=h.sent.find(x=>x.name==="review-start");
 assert.equal(start.data.recursive,true);
 h.state.reviewMode=true;
 h.state.reviewState.active=true;
 h.state.reviewState.playbackMatched=false;
 const prev=h.sent.length;
 h.state.requestDelete();
 assert.equal(h.sent.length,prev,"D must be disabled on wrong player video");
 h.state.reviewState.deletePlaybackReady=true;
 const disabledCount=h.sent.length;
 h.state.requestDelete();
 assert.equal(h.sent.length,disabledCount,
   "unverified non-SMB sources may not send a D request");
 h.state.reviewState.deletionSupported=true;
 h.state.requestDelete();
 assert.equal(h.sent.at(-1).name,"review-delete");
 assert.equal(h.state.reviewState.playbackMatched,false,
   "D targets the actual playing Review video even if KEEP's cursor differs");
});
test("Review sidebar posts the skip-confirmation preference to the backend",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.setSkipDeleteConfirmation(true);
 assert.equal(h.sent.at(-1).name,"review-delete-confirmation-setting");
 assert.equal(h.sent.at(-1).data,true);
 h.state.setSkipDeleteConfirmation(false);
 assert.equal(h.sent.at(-1).data,false);
});
test("End & Exit Review uses explicit backend handshake and shows the control near safety actions",()=>{
 const h=mount();h.definition.mounted.call(h.state);
 h.state.reviewMode=true;h.state.reviewState.active=true;
 h.state.reviewState.deleteQueueUnknown=1;
 h.state.endAndExitReview();
 assert.equal(h.sent.at(-1).name,"review-end-and-exit");
 assert.equal(h.state.reviewMode,true,"UI must not exit until backend confirms");
 h.handlers["review-end-exit-complete"]({});
 assert.equal(h.state.reviewMode,false);
 const vue=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 assert.match(vue,/@click="endAndExitReview"/);
 assert.match(vue,/结束并退出 Review/);
});
test("sidebar keeps Review open and prevents source switches during in-flight SMB deletion",()=>{
 const h=mount({savedTabs:JSON.stringify([{
   id:1,name:"NAS",path:"/Volumes/Movies/Review",currentPath:"/Volumes/Movies/Review"
 }])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=1;
 h.state.reviewMode=true;
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Movies/Review",
   sessionEpoch:1,totalCount:2,deleteInFlight:true,deleteQueuePending:1,
   entries:[{name:"sample.mkv",status:"PENDING",position:0}]
 });
 assert.equal(h.state.reviewState.deleteInFlight,true);
 const before=h.sent.length;
 assert.equal(h.state.exitReview(),false);
 assert.equal(h.state.reviewMode,true);
 assert.equal(h.sent.length,before,"no review-exit or source-change command is sent");
 h.state.removeTab(0);
 assert.equal(h.state.tabs.length,1,"the active Review source is preserved");
});
test("Directory mode selects a folder, D targets it, then refreshes on success",()=>{
 const h=mount({savedTabs:JSON.stringify([{
   id:1,name:"NAS",path:"/Volumes/Movies/Review",
   currentPath:"/Volumes/Movies/Review"
 }])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=1;
 h.state.toggleDirectoryMode();
 assert.equal(h.sent.at(-1).name,"directory-mode");
 assert.equal(h.sent.at(-1).data.root,"/Volumes/Movies/Review");
 h.handlers["directory-mode-state"]({enabled:true,root:"/Volumes/Movies/Review"});
 assert.equal(h.state.directoryMode,true);
 const item={filename:"Season 1",path:"/Volumes/Movies/Review/Season 1",isDir:true};
 h.state.handleItemClick(item);
 assert.equal(h.state.directorySelected.name,"Season 1");
 assert.equal(h.state.activeTab.currentPath,"/Volumes/Movies/Review");
 let prevented=0;
 h.state.handleSidebarKeydown({key:"d",target:{tagName:"DIV"},
   preventDefault(){prevented++;},stopPropagation(){}});
 assert.equal(prevented,1);
 assert.equal(h.sent.at(-1).name,"directory-delete");
 assert.equal(h.sent.at(-1).data.name,"Season 1");
 assert.equal(h.sent.at(-1).data.parent,"/Volumes/Movies/Review");
 assert.equal(h.state.directoryDeleting,true);
 h.handlers["directory-delete-result"]({status:"DELETED"});
 assert.equal(h.state.directorySelected,null);
 assert.equal(h.sent.at(-1).name,"get-files");
 assert.equal(h.state.directoryDeleting,false);
});
test("Directory-mode delete never fires on a video, text input or without selection",()=>{
 const h=mount({savedTabs:JSON.stringify([{
   id:1,name:"NAS",path:"/Volumes/Movies/Review",
   currentPath:"/Volumes/Movies/Review"
 }])});
 h.definition.mounted.call(h.state);
 h.state.activeTabId=1;
 h.handlers["directory-mode-state"]({enabled:true,root:"/Volumes/Movies/Review"});
 const before=h.sent.length;
 h.state.handleSidebarKeydown({key:"d",target:{tagName:"DIV"}});
 h.state.handleItemClick({filename:"ep.mkv",isDir:false,path:"/Volumes/Movies/Review/ep.mkv"});
 assert.equal(h.sent.length,before);
 assert.equal(h.state.directorySelected,null);
 h.state.handleItemClick({filename:"Series",path:"/Volumes/Movies/Review/Series",isDir:true});
 h.state.handleSidebarKeydown({key:"d",target:{tagName:"INPUT"}});
 assert.equal(h.sent.length,before);
 h.state.toggleDirectoryMode();
 assert.equal(h.state.directorySelected,null);
 assert.equal(h.sent.at(-1).data.enabled,false);
});
test("Review visible total decreases after deletion while page positions remain stable",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:4,totalCount:722,remainingCount:721,
   keptCount:41,deletedCount:1,missingCount:0,
   cursor:41,windowStart:0,
   entries:[{name:"a.mkv",status:"DELETED",position:0},
            {name:"b.mkv",status:"KEEP",position:1}]
 });
 assert.equal(h.state.reviewState.remainingCount,721);
 assert.equal(h.state.reviewState.totalCount,722);
 assert.equal(h.state.reviewState.deletedCount,1);
 const template=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 assert.ok(template.includes("<strong>{{ reviewState.remainingCount ?? reviewState.entries.length }}</strong>"),
   "the compact summary must use live inventory instead of snapshot row count");
});
test("failed media load exposes explicit recovery without enabling KEEP",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({phase:"ACTIVE",active:true,cursor:7,
   totalCount:10,playbackMatched:false,playbackStatus:"missing_url",
   playbackLoadFailed:true,entries:[{name:"broken.mkv",status:"PENDING",position:7}]});
 assert.equal(h.state.reviewState.playbackLoadFailed,true);
 h.state.keepAndNext();
 assert.equal(h.sent.filter(x=>x.name==="review-keep").length,0);
 h.state.skipFailedReviewVideo();
 assert.equal(h.sent.at(-1).name,"review-skip-failed");
 const template=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 assert.match(template,/reviewState\.playbackLoadFailed[^]*skipFailedReviewVideo/);
});
test("Review queue item click passes only bounded global index; loading blocks selection",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.state.reviewState.active=true;
 h.state.reviewState.totalCount=1000;
 h.state.reviewState.playbackStatus="exact";
 h.state.playReviewItem({name:"Episode 2",position:212,status:"PENDING"},0);
 assert.equal(h.sent.at(-1).name,"review-play");
 assert.equal(h.sent.at(-1).data.position,212);
 h.state.reviewState.playbackStatus="awaiting_file_loaded";
 const sent=h.sent.length;
 h.state.playReviewItem({name:"Episode 3",position:213,status:"PENDING"},1);
 assert.equal(h.sent.length,sent);
 h.state.reviewState.playbackStatus="exact";
 h.state.playReviewItem({name:"Bad",position:1000},1);
 assert.equal(h.sent.length,sent,"out-of-range item never sent");
 h.state.reviewState.active=false;
 h.state.reviewState.phase="COMPLETE";
 h.state.playReviewItem({name:"Old",position:5,status:"KEEP"},5);
 assert.equal(h.sent.at(-1).name,"review-play");
 assert.equal(h.sent.at(-1).data.position,5);
});
test("Review state recenters the actual playing item, not pending cursor, on file changes",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const calls=[];
 const nodes=[
   {dataset:{reviewPosition:"10"},scrollIntoView:o=>calls.push({position:10,...o})},
   {dataset:{reviewPosition:"11"},scrollIntoView:o=>calls.push({position:11,...o})}
 ];
 h.state.$refs={reviewList:{children:nodes}};
 h.state.$nextTick=callback=>callback();
 const update=(playing,cursor=10)=>h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   entries:[{position:10,name:"a.mkv",status:"PENDING"},
     {position:11,name:"b.mkv",status:"KEEP"}],
   cursor,playingPosition:playing,windowStart:0,totalCount:100,
   playbackMatched:playing===cursor
 });
 update(11);
 assert.equal(h.state.reviewState.playingPosition,11);
 assert.deepEqual(calls,[{position:11,block:"center",inline:"nearest",behavior:"auto"}]);
 update(11);
 assert.equal(calls.length,1,"status refresh should not fight intentional manual scrolling");
 update(10);
 assert.equal(calls.at(-1).position,10);
 assert.equal(h.state.reviewState.cursor,10);
});
test("real playback change overrides manual browsing and centers the highlighted playing row",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 const centered=[];
 h.state.$nextTick=callback=>callback();
 h.state.$refs={reviewList:{children:[
   {dataset:{reviewPosition:"520"},scrollIntoView:options=>centered.push({position:520,...options})}
 ]}};
 const oldRows=Array.from({length:120},(_,i)=>({
   name:"old"+i,position:600+i,status:"PENDING"
 }));
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:22,
   cursor:10,playingPosition:10,windowStart:0,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({name:"v"+i,position:i,status:"PENDING"}))
 });
 h.state.markReviewManualBrowse();
 h.state.reviewState.entries=oldRows;
 h.state.reviewState.windowStart=600;
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:22,
   cursor:10,playingPosition:520,windowStart:460,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({
     name:"v"+(460+i),position:460+i,status:"PENDING"
   }))
 });
 assert.equal(h.state.reviewManualBrowsing,false,"media change exits manual browsing mode");
 assert.equal(h.state.reviewState.windowStart,460);
 assert.ok(h.state.reviewState.entries.some(x=>x.position===520));
 assert.deepEqual(centered.at(-1),{
   position:520,block:"center",inline:"nearest",behavior:"auto"
 });
});
test("routine KEEP/status refresh does not yank manual browsing until actual video changes",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 const centered=[];
 h.state.$nextTick=callback=>callback();
 h.state.$refs={reviewList:{children:[{
   dataset:{reviewPosition:"520"},scrollIntoView:()=>centered.push(520)
 }]}};
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:25,
   cursor:10,playingPosition:10,windowStart:0,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({name:"v"+i,position:i,status:"PENDING"}))
 });
 h.state.markReviewManualBrowse();
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:25,
   cursor:11,playingPosition:10,windowStart:0,totalCount:837,keptCount:1,
   entries:Array.from({length:120},(_,i)=>({name:"v"+i,position:i,status:i===10?"KEEP":"PENDING"}))
 });
 assert.equal(h.state.reviewManualBrowsing,true);
 assert.equal(centered.length,0);
});
test("scrolling Review beyond item 119 requests the next bounded window without playing or keeping videos",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:4,entries:Array.from({length:120},(_,i)=>({
     name:"v"+i+".mp4",status:"PENDING",position:i
   })),
   cursor:0,playingPosition:0,windowStart:0,totalCount:837
 });
 h.state.markReviewManualBrowse();
 h.state.handleReviewListScroll({target:{
   scrollTop:760,scrollHeight:1000,clientHeight:200
 }});
 const requests=h.sent.filter(m=>m.name==="review-window");
 assert.equal(requests.length,1);
 assert.equal(requests[0].data.start,60);
 assert.equal(requests[0].data.sessionEpoch,4);
 assert.equal(requests[0].data.requestId,1);
 h.state.handleReviewListScroll({target:{
   scrollTop:780,scrollHeight:1000,clientHeight:200
 }});
 assert.equal(h.sent.filter(m=>m.name==="review-window").length,1,
   "in-flight pages must be deduplicated");
 h.handlers["review-window-data"]({
   sessionEpoch:4,requestId:1,windowStart:60,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({
     name:"v"+(i+60)+".mp4",status:i%2?"KEEP":"PENDING",position:i+60
   }))
 });
 assert.equal(h.state.reviewState.windowStart,60);
 assert.equal(h.state.reviewState.entries[0].position,60);
 assert.equal(h.state.reviewState.entries[1].status,"KEEP");
 assert.equal(h.state.reviewState.cursor,0,"scrolling must not alter Review progression");
 assert.equal(h.sent.some(x=>x.name==="review-play"||x.name==="review-keep"),false);
});
test("Review manual browse permits reverse pages and does not re-center on unrelated status refresh",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const calls=[];
 h.state.$nextTick=fn=>fn();
 h.state.$refs={reviewList:{children:[{
   dataset:{reviewPosition:"360"},scrollIntoView:()=>calls.push("center")
 }]}};
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:11,entries:[{name:"v360",position:360,status:"PENDING"}],
   cursor:360,playingPosition:360,windowStart:360,totalCount:837
 });
 h.state.markReviewManualBrowse();
 const before=calls.length;
 h.state.handleReviewListScroll({target:{
   scrollTop:20,scrollHeight:1000,clientHeight:200
 }});
 const ask=h.sent.filter(x=>x.name==="review-window").at(-1);
 assert.equal(ask.data.start,300);
 h.handlers["review-window-data"]({
   sessionEpoch:11,requestId:ask.data.requestId,windowStart:300,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({position:i+300,
     name:"v"+(i+300),status:"PENDING"}))
 });
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:11,entries:[{name:"v400",position:400,status:"KEEP"}],
   cursor:400,playingPosition:360,windowStart:340,totalCount:837,keptCount:1
 });
 assert.equal(h.state.reviewState.windowStart,300);
 assert.equal(h.state.reviewState.cursor,400);
 assert.equal(h.state.reviewState.keptCount,1);
 assert.equal(calls.length,before,
   "incoming progress must not force the user away from browsing");
 const refresh=h.sent.filter(x=>x.name==="review-window").at(-1);
 assert.equal(refresh.data.start,300,"refresh must update status within the visible window");
});
test("Review ignores stale window replies after source/session switch",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",active:true,root:"/Volumes/A",
   sessionEpoch:1,entries:Array.from({length:120},(_,i)=>({position:i,name:"A"+i})),
   cursor:0,playingPosition:0,totalCount:837,windowStart:0});
 h.state.markReviewManualBrowse();
 h.state.handleReviewListScroll({target:{
   scrollTop:770,scrollHeight:1000,clientHeight:200
 }});
 h.handlers["review-state"]({phase:"ACTIVE",active:true,root:"/Volumes/B",
   sessionEpoch:2,entries:[{position:0,name:"B0"}],
   cursor:0,playingPosition:0,totalCount:1,windowStart:0});
 h.handlers["review-window-data"]({sessionEpoch:1,requestId:1,
   windowStart:60,totalCount:837,entries:[{position:60,name:"A60"}]});
 assert.equal(h.state.reviewState.root,"/Volumes/B");
 assert.equal(h.state.reviewState.entries[0].name,"B0");
 assert.equal(h.state.reviewManualBrowsing,false);
});
test("837 Review items can be traversed in bounded windows from first to last and back",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const pages=(start)=>Array.from({length:120},(_,i)=>({
   position:start+i,name:"v"+(start+i),status:i%7===0?"KEEP":"PENDING"
 }));
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:19,entries:pages(0),cursor:0,playingPosition:0,
   windowStart:0,totalCount:837
 });
 h.state.markReviewManualBrowse();
 const bottom={target:{scrollTop:790,scrollHeight:1000,clientHeight:200}};
 const top={target:{scrollTop:20,scrollHeight:1000,clientHeight:200}};
 let steps=0;
 while(h.state.reviewState.windowStart<717){
   h.state.handleReviewListScroll(bottom);
   const ask=h.sent.filter(x=>x.name==="review-window").at(-1).data;
   const start=ask.start;
   h.handlers["review-window-data"]({requestId:ask.requestId,
     sessionEpoch:19,windowStart:start,totalCount:837,
     entries:pages(start)});
   assert.equal(h.state.reviewState.entries.length,120);
   assert.ok(++steps<=13);
 }
 assert.equal(h.state.reviewState.entries.at(-1).position,836);
 steps=0;
 while(h.state.reviewState.windowStart>0){
   h.state.handleReviewListScroll(top);
   const ask=h.sent.filter(x=>x.name==="review-window").at(-1).data;
   h.handlers["review-window-data"]({requestId:ask.requestId,
     sessionEpoch:19,windowStart:ask.start,totalCount:837,
     entries:pages(ask.start)});
   assert.equal(h.state.reviewState.entries.length,120);
   assert.ok(++steps<=13);
 }
 assert.equal(h.state.reviewState.entries[0].position,0);
 assert.equal(h.state.reviewState.cursor,0);
 assert.equal(h.sent.some(x=>x.name==="review-keep"||x.name==="review-play"),false);
});
test("window rotation preserves the exact first visible row across different filename heights",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const row=(position,top)=>({dataset:{reviewPosition:String(position)},
   offsetTop:top,offsetHeight:50});
 const list={scrollTop:480,children:[row(110,500)]};
 h.state.$refs={reviewList:list};
 h.state.$nextTick=fn=>{
   list.children=[row(110,220)];
   fn();
 };
 h.handlers["review-state"]({
   phase:"ACTIVE",active:true,root:"/Volumes/Media/Review",
   sessionEpoch:21,entries:Array.from({length:120},(_,i)=>({
     position:i,name:"v"+i,status:"PENDING"
   })),cursor:0,playingPosition:0,totalCount:837,windowStart:0
 });
 list.children=[row(110,500)];
 list.scrollTop=480;
 h.state.markReviewManualBrowse();
 h.state.handleReviewListScroll({target:{
   scrollTop:770,scrollHeight:1000,clientHeight:200
 }});
 h.handlers["review-window-data"]({
   sessionEpoch:21,requestId:1,windowStart:60,totalCount:837,
   entries:Array.from({length:120},(_,i)=>({
     position:60+i,name:"v"+(60+i),status:"PENDING"
   }))
 });
 assert.equal(list.scrollTop,200,
   "scrollTop must change by the rendered position delta, not guessed row heights");
});
test("stale progress page triggers a bounded refresh instead of reverting KEEP statuses",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:2,viewRevision:5,
   entries:Array.from({length:120},(_,i)=>({
     position:i,name:"v"+i,status:"PENDING"
   })),cursor:0,playingPosition:0,totalCount:837,windowStart:0
 });
 h.state.markReviewManualBrowse();
 h.state.handleReviewListScroll({target:{
   scrollTop:770,scrollHeight:1000,clientHeight:200
 }});
 const before=h.sent.filter(x=>x.name==="review-window").at(-1).data;
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:2,viewRevision:6,
   entries:[{position:0,name:"v0",status:"KEEP"}],
   cursor:1,playingPosition:0,totalCount:837,windowStart:0,keptCount:1
 });
 h.handlers["review-window-data"]({sessionEpoch:2,
   requestId:before.requestId,windowStart:60,totalCount:837,
   viewRevision:5,entries:Array.from({length:120},(_,i)=>({
     position:i+60,name:"v"+(i+60),status:"PENDING"
   }))
 });
 const after=h.sent.filter(x=>x.name==="review-window").at(-1).data;
 assert.ok(after.requestId>before.requestId);
 assert.equal(h.state.reviewState.viewRevision,6);
 assert.equal(h.state.reviewState.windowStart,0);
 assert.equal(h.state.reviewState.keptCount,1);
});
test("unanswered scroll request visibly times out and allows a retry",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:5,
   entries:Array.from({length:120},(_,i)=>({
     name:"v"+i,position:i,status:"PENDING"
   })),cursor:0,playingPosition:0,totalCount:837,windowStart:0});
 h.state.markReviewManualBrowse();
 const atBottom={target:{scrollTop:780,scrollHeight:1000,clientHeight:200}};
 h.state.handleReviewListScroll(atBottom);
 assert.equal(h.sent.filter(x=>x.name==="review-window").length,1);
 const timeout=h.timers.get(h.state.reviewWindowTimerId);
 assert.equal(typeof timeout,"function");
 timeout();
 assert.equal(h.state.reviewWindowPending,null);
 assert.match(h.state.reviewWindowError,/timed out/i);
 h.state.handleReviewListScroll(atBottom);
 assert.equal(h.sent.filter(x=>x.name==="review-window").length,2);
});
test("clicking a scrolled Review video resumes automatic follow and ignores obsolete page replies",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   root:"/Volumes/Media/Review",sessionEpoch:6,
   entries:Array.from({length:120},(_,i)=>({
     name:"v"+i,position:i,status:"PENDING"
   })),cursor:0,playingPosition:0,totalCount:837,windowStart:0});
 h.state.markReviewManualBrowse();
 h.state.handleReviewListScroll({target:{
   scrollTop:770,scrollHeight:1000,clientHeight:200
 }});
 assert.ok(h.state.reviewWindowPending);
 h.state.playReviewItem({name:"v100",position:100,status:"PENDING"},100);
 assert.equal(h.state.reviewManualBrowsing,false);
 assert.equal(h.state.reviewWindowPending,null);
 assert.equal(h.sent.at(-1).name,"review-play");
 h.handlers["review-window-data"]({sessionEpoch:6,requestId:1,
   windowStart:60,totalCount:837,
   entries:[{name:"v60",position:60,status:"PENDING"}]});
 assert.equal(h.state.reviewState.windowStart,0);
});
test("returning from Logs to Review restores the playing row center",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 let count=0;
 h.state.reviewMode=true;
 h.state.reviewState={entries:[{position:12}],cursor:12,playingPosition:12};
 h.state.$nextTick=callback=>callback();
 h.state.$refs={reviewList:{children:[{
   dataset:{reviewPosition:"12"},
   scrollIntoView:()=>count++
 }]}};
 h.definition.watch.showDebugLog.call(h.state,true);
 assert.equal(count,0);
 h.definition.watch.showDebugLog.call(h.state,false);
 assert.equal(count,1);
});
test("Review list layout provides its own scrollable centered viewport",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const source=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 assert.match(source,/<ul[^>]*ref="reviewList"/);
 assert.match(source,/data-review-position/);
 assert.match(source,/\.review-files\s*\{[^}]*overflow-y:\s*auto/s);
 assert.match(source,/\.review-files::before/s);
});
test("Review button reports missing IINA bridge instead of endless loading",()=>{
 const h=mount({bridge:false});
 h.state.tabs=[{id:1,currentPath:"/private/tmp/iina-nas-review-fixture-demo"}];
 h.state.activeTabId=1;
 h.state.startReview();
 assert.match(h.state.reviewError,/unavailable|cannot connect|not ready/i);
});
test("Review request without backend response shows timeout diagnostic",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.tabs=[{id:1,currentPath:"/private/tmp/iina-nas-review-fixture-demo"}];
 h.state.activeTabId=1;
 h.state.startReview();
 assert.equal(h.sent.at(-1).name,"review-start");
 assert.equal(h.timers.size,1);
 [...h.timers.values()][0]();
 assert.match(h.state.reviewError,/no response|timed out|not running/i);
});
test("Review response clears pending timeout and renders queue status",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.tabs=[{id:1,currentPath:"/private/tmp/iina-nas-review-fixture-demo"}];
 h.state.activeTabId=1;
 h.state.startReview();
 h.handlers["review-state"]({entries:[{name:"video2.mp4",status:"PENDING"}],cursor:0,active:true,error:""});
 assert.equal(h.state.reviewState.entries.length,1);
 assert.equal(h.state.reviewError,"");
 assert.equal(h.timers.size,0);
});
test("saved SMB Review displays actual source even without bookmark and resumes directly",()=>{
 const h=mount({savedTabs:"[]"});
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"IDLE",active:false,resumeAvailable:true,
   resumeKind:"smb",resumeSource:"/Volumes/Movies/Review",
   resumeKept:5,resumeTotal:73,entries:[],error:""});
 assert.equal(h.state.reviewState.resumeSource,"/Volumes/Movies/Review");
 assert.equal(h.state.resumeSourceLabel,"SMB · Review");
 assert.equal(h.state.canResumeSelected,true);
 h.state.resumeReview();
 assert.equal(h.sent.at(-1).name,"review-resume");
 assert.equal(h.sent.at(-1).data.path,"/Volumes/Movies/Review");
});
test("automatically resumed backend Review opens queue UI without selecting directory",()=>{
 const h=mount({savedTabs:"[]"});
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({phase:"ACTIVE",active:true,
   nasReadOnly:true,root:"/Volumes/Movies/Review",cursor:1,
   resumeAvailable:true,resumeKind:"smb",resumeSource:"/Volumes/Movies/Review",
   entries:[{name:"b.mp4",status:"PENDING",position:1}],error:""});
 assert.equal(h.state.reviewMode,true);
 assert.equal(h.state.reviewState.cursor,1);
 assert.equal(h.sent.filter(x=>x.name==="open-file"||x.name==="review-start").length,0);
});
test("switching from rejected NAS tab to local fixture must clear stale Review error",()=>{
 const h=mount();
 h.state.tabs=[
   {id:1,name:"NAS",path:"/Volumes/NAS/Movies",currentPath:"/Volumes/NAS/Movies",files:[]},
   {id:2,name:"fixture",path:"/private/tmp/iina-nas-review-fixture-mbkl7evt",
    currentPath:"/private/tmp/iina-nas-review-fixture-mbkl7evt",files:[]}
 ];
 h.state.activeTabId=1;
 h.state.reviewMode=true;
 h.state.reviewError="Review mode only accepts disposable local test folders.";
 h.state.reviewState={entries:[],cursor:-1,active:false};
 h.state.tabClick(h.state.tabs[1]);
 assert.equal(h.state.activeTabId,2);
 assert.equal(h.state.reviewMode,false,"must leave the old source review session");
 assert.equal(h.state.reviewError,"","old source error must not appear under selected fixture");
 assert.ok(h.sent.some(msg=>msg.name==="review-exit"),"backend queue must be invalidated");
});
test("adding a local fixture bookmark while Review is visible must leave old NAS Review",()=>{
 const h=mount();
 h.state.tabs=[{id:1,name:"NAS",path:"/Volumes/NAS/Movies",currentPath:"/Volumes/NAS/Movies",files:[]}];
 h.state.activeTabId=1;
 h.state.reviewMode=true;
 h.state.reviewError="Review mode only accepts disposable local test folders.";
 h.state.newFolderPath="/private/tmp/iina-nas-review-fixture-mbkl7evt";
 h.state.newFolderName="fixture";
 h.state.addTab();
 assert.equal(h.state.reviewMode,false);
 assert.equal(h.state.reviewError,"");
 assert.equal(h.state.activeTab.path,"/private/tmp/iina-nas-review-fixture-mbkl7evt");
 assert.ok(h.sent.some(x=>x.name==="review-exit"));
});
test("re-entering Review after selecting the real local fixture sends its current path",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const local="/private/tmp/iina-nas-review-fixture-mbkl7evt";
 h.state.tabs=[{id:2,name:"fixture",path:local,currentPath:local,files:[]}];
 h.state.activeTabId=2;
 h.state.startReview();
 assert.equal(h.sent.at(-1).name,"review-start");
 assert.equal(h.sent.at(-1).data.path,local);
 h.handlers["review-state"]({root:local,cursor:0,active:true,
   entries:[{name:"video2.mp4",status:"PENDING"},{name:"video10.mp4",status:"PENDING"}],
   error:""});
 assert.equal(h.state.reviewState.entries.length,2);
 assert.equal(h.state.reviewError,"");
});
test("focus messages prevent K while editing and release only after leaving inputs",()=>{
 const h=mount();
 const input={tagName:"INPUT"};
 const textarea={tagName:"TEXTAREA"};
 h.state.handleReviewFocusIn({target:input});
 assert.equal(h.sent.at(-1).name,"review-input-focus");
 assert.equal(h.sent.at(-1).data.focused,true);
 const before=h.sent.length;
 h.state.handleReviewFocusOut({target:input,relatedTarget:textarea});
 assert.equal(h.sent.length,before,"switching between text editors must remain guarded");
 h.state.handleReviewFocusOut({target:textarea,relatedTarget:{tagName:"BUTTON"}});
 assert.equal(h.sent.at(-1).data.focused,false);
});
test("Review UI records whether K shortcut has been registered",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({entries:[],active:false,cursor:-1,error:"",kShortcutEnabled:true});
 assert.equal(h.state.reviewState.kShortcutEnabled,true);
 h.handlers["review-state"]({entries:[],active:false,cursor:-1,error:"",kShortcutEnabled:false});
 assert.equal(h.state.reviewState.kShortcutEnabled,false);
});
test("K while Review sidebar has focus must send one Keep message, not rely on player input",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.state.reviewState={entries:[{name:"video2.mp4",status:"PENDING"}],cursor:0,active:true,playbackMatched:true,kShortcutEnabled:true};
 assert.equal(typeof h.domListeners.keydown,"function","sidebar needs a keyboard fallback");
 let preventCount=0;
 h.domListeners.keydown({key:"k",repeat:false,target:{tagName:"DIV"},preventDefault(){preventCount++}});
 assert.equal(h.sent.at(-1).name,"review-keep");
 assert.equal(preventCount,1);
});
test("sidebar K must pass through when editing, repeating, or not reviewing",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 assert.equal(typeof h.domListeners.keydown,"function");
 let blocked=0;
 const event=(target,repeat=false)=>({key:"k",repeat,target,preventDefault(){blocked++;}});
 h.domListeners.keydown(event({tagName:"DIV"}));
 h.state.reviewMode=true;
 h.state.reviewState={entries:[{name:"video2.mp4",status:"PENDING"}],cursor:0,active:true,kShortcutEnabled:true};
 h.domListeners.keydown(event({tagName:"INPUT"}));
 h.domListeners.keydown(event({tagName:"TEXTAREA"}));
 h.domListeners.keydown(event({tagName:"DIV"},true));
 assert.equal(blocked,0);
 assert.equal(h.sent.filter(msg=>msg.name==="review-keep").length,0);
});
test("backend debug events survive sidebar remount and are not duplicated by replay",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 assert.equal(typeof h.handlers["debug-event"],"function");
 assert.equal(typeof h.handlers["debug-snapshot"],"function");
 const e={id:"backend-session-1",at:"2026-11-03T05:00:00.000Z",source:"backend",level:"info",event:"input.k.registered",data:{enabled:true}};
 h.handlers["debug-event"](e);
 h.handlers["debug-snapshot"]([e]);
 assert.equal(h.state.debugEntries.filter(x=>x.id===e.id).length,1);
 const persisted=h.stored.get("nas-review-debug-v1");
 assert.ok(persisted.includes("input.k.registered"));
 const restored=mount({savedDebug:persisted});
 restored.definition.mounted.call(restored.state);
 assert.ok(restored.state.debugEntries.some(x=>x.id===e.id));
});
test("debug UI can copy an export and clear persisted logs",async()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.logDebug("ui.review.start",{accepted:true});
 await h.state.copyDebugLog();
 assert.equal(h.clipboard.length,1);
 assert.match(h.clipboard[0],/ui.review.start/);
 h.state.clearDebugLog();
 assert.equal(h.state.debugEntries.length,0);
 assert.deepEqual(JSON.parse(h.stored.get("nas-review-debug-v1")),[]);
 assert.ok(h.sent.some(e=>e.name==="debug-clear"));
});
test("debug UI enforces ring limit and refuses full paths in event metadata",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 for(let i=0;i<260;i++)h.state.logDebug("ui.test.event",{count:i,path:"/Volumes/secret/media.mkv"});
 assert.ok(h.state.debugEntries.length<=200);
 const exported=h.state.formatDebugLog();
 assert.equal(exported.includes("/Volumes"),false);
 assert.equal(exported.includes("media.mkv"),false);
 assert.match(exported,/ui.test.event/);
});
test("Logs pane never triggers sidebar K while viewing diagnostic output",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.state.showDebugLog=true;
 h.state.reviewState={entries:[{name:"video2.mp4",status:"PENDING"}],cursor:0,active:true,kShortcutEnabled:true};
 h.domListeners.keydown({key:"k",repeat:false,target:{tagName:"DIV"},preventDefault(){throw new Error("K intercepted in log pane");}});
 assert.equal(h.sent.filter(entry=>entry.name==="review-keep").length,0);
});
test("corrupt persisted debug logs cannot blank Vue sidebar",()=>{
 const h=mount({savedDebug:"{invalid JSON"});
 assert.doesNotThrow(()=>h.definition.mounted.call(h.state));
 assert.ok(h.state.debugEntries.some(entry=>entry.event==="ui.mounted"));
});
test("asynchronous NAS backup status does not clear an earlier Resume safety error",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({
   phase:"ERROR",active:false,root:"/Volumes/Movies/Review",
   sessionEpoch:3,cursor:-1,playingPosition:-1,entries:[],totalCount:0,
   error:"Resume blocked: SMB source changed.",nasReadOnly:true,
   nasBackupEnabled:true,nasBackupStatus:"pending"
 });
 assert.match(h.state.reviewError,/Resume blocked/);
 h.handlers["nas-backup-status"]({
   root:"/Volumes/Movies/Review",enabled:true,status:"synced"
 });
 assert.match(h.state.reviewError,/Resume blocked/);
 assert.equal(h.state.reviewState.nasBackupStatus,"synced");
 h.handlers["nas-backup-status"]({
   root:"/Volumes/Other/Review",enabled:false,status:"disabled"
 });
 assert.equal(h.state.reviewState.nasBackupStatus,"synced");
});
test("sidebar requests pending Review state at mount, never auto-plays it",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 assert.ok(h.sent.some(x=>x.name==="review-ready"));
 assert.equal(h.sent.some(x=>x.name==="review-resume"),false);
});
test("pending Review disables Start and requires a two-step confirmed discard",()=>{
 const vue=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 const startButton=vue.match(/<button[^>]*@click="startReview"[^>]*>Review<\/button>/);
 assert.ok(startButton);
 assert.match(startButton[0],/resumeAvailable/,"pending checkpoint must disable header Start");
 const h=mount();
 h.definition.mounted.call(h.state);
 const fixture="/private/tmp/iina-nas-review-fixture-mbkl7evt";
 h.state.tabs=[{id:1,currentPath:fixture,path:fixture,name:"fixture",files:[]}];
 h.state.activeTabId=1;
 h.handlers["review-state"]({root:fixture,entries:[],cursor:-1,active:false,
   resumeAvailable:true,resumeTotal:2,resumeKept:1,resumeSource:fixture,error:""});
 assert.equal(h.state.reviewState.resumeAvailable,true);
 assert.equal(h.state.reviewMode,false);
 h.state.resumeReview();
 assert.equal(h.sent.at(-1).name,"review-resume");
 assert.equal(h.sent.at(-1).data.path,fixture);
 assert.equal(h.state.reviewMode,false,
   "a pending restore must not show an active Review until backend verifies source");
 h.handlers["review-state"]({root:fixture,entries:[],cursor:1,active:true,
   resumeAvailable:true,resumeTotal:2,resumeKept:1,resumeSource:fixture,error:""});
 assert.equal(h.state.reviewMode,true);
 h.state.reviewMode=false;
 h.handlers["review-state"]({root:fixture,entries:[],cursor:-1,active:false,
   resumeAvailable:true,resumeTotal:2,resumeKept:1,resumeSource:fixture,error:""});
 const countBefore=h.sent.length;
 h.state.startReview();
 assert.equal(h.sent.length,countBefore,"UI cannot Start over an unfinished queue");
 assert.equal(h.state.reviewMode,false);
 h.state.discardReview();
 assert.equal(h.state.discardConfirming,true);
 assert.equal(h.sent.length,countBefore,"first click must only open confirmation");
 h.state.cancelDiscardReview();
 assert.equal(h.state.discardConfirming,false);
 assert.equal(h.sent.length,countBefore,"cancel must not discard");
 h.state.discardReview();
 h.state.confirmDiscardReview();
 assert.equal(h.sent.at(-1).name,"review-discard");
 assert.equal(h.state.discardConfirming,false);
});
test("after confirmed discard and backend acknowledgement, a new local Review may start",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const folder="/private/tmp/iina-nas-review-fixture-demo";
 h.state.tabs=[{id:1,currentPath:folder,path:folder,name:"demo",files:[]}];
 h.state.activeTabId=1;
 h.handlers["review-state"]({resumeAvailable:true,resumeSource:folder,resumeKept:1,
   resumeTotal:2,entries:[],cursor:-1,active:false,error:""});
 h.state.discardReview();h.state.confirmDiscardReview();
 assert.equal(h.sent.at(-1).name,"review-discard");
 h.handlers["review-state"]({resumeAvailable:false,entries:[],cursor:-1,active:false,error:""});
 h.state.startReview();
 assert.equal(h.sent.at(-1).name,"review-start");
 assert.equal(h.sent.at(-1).data.path,folder);
});
test("restart selects NAS first: Resume targets the saved local source without changing tabs",()=>{
 const fixture="/private/tmp/iina-nas-review-fixture-kverify-q_lttabf";
 const nas="/Volumes/ExampleNAS";
 const tabs=[
   {id:1,name:"NAS",path:nas,currentPath:nas,files:[]},
   {id:2,name:"Test fixture",path:fixture,currentPath:fixture,files:[]}
 ];
 const h=mount({savedTabs:JSON.stringify(tabs)});
 h.definition.mounted.call(h.state);
 assert.equal(h.state.activeTabId,1,"regression: persisted bookmarks default to first NAS");
 h.handlers["review-state"]({
   entries:[],cursor:-1,active:false,resumeAvailable:true,
   resumeTotal:2,resumeKept:1,resumeSource:fixture,error:""
 });
 assert.equal(h.state.resumeSourceLabel,"iina-nas-review-fixture-kverify-q_lttabf");
 assert.equal(h.state.savedSourceTab?.id,2);
 assert.equal(h.state.canResumeSelected,true);
 h.state.resumeReview();
 assert.equal(h.sent.at(-1).name,"review-resume");
 assert.equal(h.sent.at(-1).data.path,fixture,
   "resume must use saved checkpoint path rather than current NAS tab");
 assert.equal(h.state.reviewMode,false);
 assert.equal(h.state.activeTabId,1,"folder navigation remains untouched");
});
test("missing original bookmark still allows Resume using the saved checkpoint path",()=>{
 const fixture="/private/tmp/iina-nas-review-fixture-kverify-q_lttabf";
 const h=mount({savedTabs:JSON.stringify([{id:1,name:"NAS",path:"/Volumes/NAS",currentPath:"/Volumes/NAS",files:[]}])});
 h.definition.mounted.call(h.state);
 h.handlers["review-state"]({
   entries:[],cursor:-1,active:false,resumeAvailable:true,
   resumeSource:fixture,resumeTotal:2,resumeKept:1,error:""
 });
 assert.equal(h.state.savedSourceTab,undefined);
 assert.equal(h.state.canResumeSelected,true);
 h.state.resumeReview();
 assert.equal(h.sent.at(-1).name,"review-resume");
 assert.equal(h.sent.at(-1).data.path,fixture);
});
test("thumbnail sidebar command only sends during an active Review",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 const n=h.sent.length;
 h.state.openThumbnails();
 assert.equal(h.sent.length,n);
 h.state.reviewMode=true;
 h.state.reviewState.active=true;
 h.state.reviewState.playbackMatched=true;
 h.state.openThumbnails();
 assert.equal(h.sent.at(-1).name,"review-thumbnails-toggle");
});
test("unexpected playback switch is visible and offers explicit Reopen rather than unsafe Keep",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
  phase:"ACTIVE",active:true,cursor:0,
  entries:[{name:"video2.mp4",status:"PENDING"}],error:"",
  playbackMatched:false,playbackStatus:"different_review_item"
 });
 assert.equal(h.state.reviewState.playbackMatched,false);
 assert.equal(h.state.reviewState.playbackStatus,"different_review_item");
 assert.match(h.state.reviewNotice,/another|different|reopen|switch/i);
 h.state.reopenReviewVideo();
 assert.equal(h.sent.at(-1).name,"review-reopen");
 h.state.reviewState.active=false;
 const count=h.sent.length;
 h.state.reopenReviewVideo();
 assert.equal(h.sent.length,count,"inactive Review must never request a new playback");
});
test("missing IINA history video exposes explicit Reopen without enabling KEEP or autoplay",()=>{
 const vue=fs.readFileSync(path.join(__dirname,"../ui/sidebar/app.vue"),"utf8");
 const button=vue.match(/<button[^>]*@click="reopenReviewVideo"[^>]*>Reopen current Review item<\/button>/);
 assert.ok(button,"Reopen must be accessible in Review UI");
 assert.equal(button[0].includes("missing_url"),false,
   "missing player URL is a valid reason to offer explicit Reopen, not to hide it");
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
  phase:"ACTIVE",cursor:1,active:true,error:"",
  entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"PENDING"}],
  playbackMatched:false,playbackStatus:"missing_url"
 });
 assert.equal(h.state.reviewState.playbackMatched,false);
 assert.match(h.state.reviewNotice,/IINA History/i);
 const count=h.sent.length;
 h.state.keepAndNext();
 h.state.openThumbnails();
 assert.equal(h.sent.length,count,"no implicit playback action while waiting for IINA History");
 h.state.reopenReviewVideo();
 assert.equal(h.sent.at(-1).name,"review-reopen","only explicit Reopen may open the queued video");
 h.state.reviewState.active=false;
 const after=h.sent.length;
 h.state.reopenReviewVideo();
 assert.equal(h.sent.length,after,"inactive session must refuse reopen");
});
test("sidebar shows loading status and never enables KEEP before file-loaded confirmation",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
   phase:"ACTIVE",cursor:1,active:true,error:"",
   entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"PENDING"}],
   playbackMatched:false,playbackStatus:"awaiting_file_loaded"
 });
 assert.match(h.state.reviewNotice,/loading|loaded|wait/i);
 const sent=h.sent.length;
 h.state.keepAndNext();h.state.openThumbnails();
 assert.equal(h.sent.length,sent);
});
test("sidebar KEEP, K and thumbnails all remain inactive when IINA history item mismatches",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
  phase:"ACTIVE",cursor:1,active:true,error:"",
  entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"PENDING"}],
  playbackMatched:false,playbackStatus:"different_review_item"
 });
 const count=h.sent.length;
 h.state.keepAndNext();
 h.state.openThumbnails();
 h.domListeners.keydown({key:"k",repeat:false,target:{tagName:"DIV"},
  preventDefault(){throw new Error("K must pass through on wrong video");}});
 assert.equal(h.sent.length,count);
 h.handlers["review-state"]({
  phase:"ACTIVE",cursor:1,active:true,error:"",
  entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"PENDING"}],
  playbackMatched:true,playbackStatus:"exact"
 });
 h.state.keepAndNext();
 assert.equal(h.sent.at(-1).name,"review-keep");
});
test("completed Review is a normal success, not an error after final KEEP",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
  root:"/private/tmp/iina-nas-review-fixture-demo",phase:"COMPLETE",
  entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"KEEP"}],
  cursor:-1,active:false,error:"",restoreState:"idle",
  resumeAvailable:false,resumeTotal:2,resumeKept:2
 });
 assert.equal(h.state.reviewState.phase,"COMPLETE");
 assert.equal(h.state.reviewError,"");
 assert.equal(h.state.reviewNotice,"Review complete. All 2 videos kept.");
 const event=h.state.debugEntries.filter(x=>x.event==="ui.review.state_received").at(-1);
 assert.equal(event.level,"info");
 assert.equal(event.data.status,"COMPLETE");
});
test("Review queue attachment guides IINA History without claiming playback restore",()=>{
 const h=mount();
 h.definition.mounted.call(h.state);
 h.state.reviewMode=true;
 h.handlers["review-state"]({
  phase:"ACTIVE",entries:[{name:"video2.mp4",status:"PENDING"}],
  cursor:0,active:true,error:"",playbackMatched:false,playbackStatus:"missing_url"
 });
 assert.equal("restoreState" in h.state.reviewState,false);
 assert.equal(h.state.reviewError,"");
 assert.match(h.state.reviewNotice,/iina history/i);
 h.handlers["review-state"]({
  phase:"ACTIVE",entries:[{name:"video2.mp4",status:"PENDING"}],
  cursor:0,active:true,error:"",playbackMatched:true,playbackStatus:"exact"
 });
 assert.match(h.state.reviewNotice,/IINA manages playback/i);
});
