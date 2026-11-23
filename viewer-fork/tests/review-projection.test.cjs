"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {project}=require("../src/review-projection.cjs");
const root="/Volumes/Media/Review";
function legacy(queue,jobs,options){
 const {playingPath=null,windowSize=0,legacyQueueId=null}=options;
 const entries=queue?.entries||[], counts=Object.create(null);
 for(const status of ["RUNNING","QUEUED","PAUSED","UNKNOWN","DELETED","FAILED","RECONCILED","CANCELLED"])
  counts[status]=(jobs||[]).filter(job=>job.status===status).length;
 const legacyQueueRunning=(jobs||[]).some(job=>job.status==="RUNNING"&&job.id===legacyQueueId);
 const keptCount=entries.filter(e=>e.status==="KEEP").length;
 const deletedCount=entries.filter(e=>e.status==="DELETED").length;
 const missingCount=entries.filter(e=>e.status==="MISSING").length;
 const playingPosition=playingPath!==null?entries.findIndex(e=>e.path===playingPath):-1;
 const anchor=playingPosition>=0?playingPosition:Math.max(0,options.cursor??-1);
 const windowStart=entries.length>windowSize?
  Math.max(0,Math.min(anchor-Math.floor(windowSize/2),entries.length-windowSize)):0;
 const projected=entries.slice(windowStart,windowStart+windowSize).map(({name,status,path},i)=>{
  const index=windowStart+i;
  const job=(jobs||[]).find(task=>task.root===queue.root&&task.index===index&&task.path===path&&
   ["QUEUED","RUNNING","PAUSED","UNKNOWN"].includes(task.status));
  return {name,status:job?job.status:status,position:index};
 });
 return {playingPosition,keptCount,deletedCount,missingCount,counts,hasUnknown:counts.UNKNOWN>0,
   legacyQueueRunning,windowStart,entries:projected};
}
const queue={root,entries:[
 {name:"dup.mkv",path:root+"/dup.mkv",status:"PENDING"},
 {name:"dup.mkv",path:root+"/dup.mkv",status:"KEEP"},
 {name:"deleted.mkv",path:root+"/deleted.mkv",status:"DELETED"},
 {name:"missing.mkv",path:root+"/missing.mkv",status:"MISSING"},
 {name:"queued.mkv",path:root+"/queued.mkv",status:"PENDING"}
]};
const jobs=[
 {root,index:1,path:queue.entries[1].path,status:"FAILED"},
 {root,index:1,path:queue.entries[1].path,status:"RUNNING"},
 {root,index:1,path:queue.entries[1].path,status:"UNKNOWN"},
 {root,index:4,path:queue.entries[4].path,status:"QUEUED"},
 {root:"/other",index:2,path:queue.entries[2].path,status:"PAUSED"},
 {root,index:2,path:queue.entries[2].path,status:"DELETED"},
 {root,index:7,path:"/else",status:"RUNNING",id:"legacy"},
 {root,index:3,path:queue.entries[3].path,status:"NEW_STATE"}
];
test("projection matches legacy counts, first matching active job and stable positions",()=>{
 const options={playingPath:root+"/dup.mkv",cursor:0,windowSize:4,legacyQueueId:"legacy"};
 assert.deepEqual(project(queue,jobs,options),legacy(queue,jobs,options));
});
test("projection preserves empty queues and truncated window boundaries",()=>{
 for(const [input,playingPath,cursor,windowSize] of [
  [null,null,-1,0],[{root,entries:[]},null,-1,120],[queue,null,4,4],[queue,null,0,3]
 ]){
  const options={playingPath,cursor,windowSize,legacyQueueId:"legacy"};
  assert.deepEqual(project(input,jobs,options),legacy(input,jobs,options));
 }
});
test("projection keeps global job counts and first duplicate active match",()=>{
 const options={playingPath:null,cursor:1,windowSize:1,legacyQueueId:"legacy"};
 const first={root,index:1,path:queue.entries[1].path,status:"PAUSED"};
 assert.deepEqual(project(queue,[first,{...first,status:"RUNNING"}],options),
  legacy(queue,[first,{...first,status:"RUNNING"}],options));
});
test("projection matches legacy behavior across deterministic randomized fixtures",()=>{
 let seed=0x5eed1234;
 const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 const statuses=["PENDING","KEEP","DELETED","MISSING"];
 const jobStatuses=["QUEUED","RUNNING","PAUSED","UNKNOWN","DELETED","FAILED","RECONCILED","CANCELLED","OTHER"];
 for(let sample=0;sample<250;sample++){
  const count=rand()%241,localRoot=sample%5===0?"/other":root;
  const entries=Array.from({length:count},(_,i)=>{
   const path=localRoot+"/v"+(rand()%Math.max(1,count/2|0))+".mkv";
   return {name:"item-"+i,path,status:statuses[rand()%statuses.length]};
  });
  const fixture={root:localRoot,entries};
  const tasks=Array.from({length:rand()%257},(_,i)=>{
   const index=rand()%Math.max(1,count+8),entry=entries[index];
   return {root:rand()%7===0?"/other":localRoot,index,
    path:entry&&rand()%8!==0?entry.path:localRoot+"/stale.mkv",
    status:jobStatuses[rand()%jobStatuses.length],id:i===0?"legacy":String(i)};
  });
  const selectedPath=entries.length&&rand()%3!==0?entries[rand()%entries.length].path:
    localRoot+"/not-playing.mkv";
  const options={playingPath:selectedPath,cursor:(rand()%257)-8,
   windowSize:[0,1,16,120,260][rand()%5],legacyQueueId:"legacy"};
  assert.deepEqual(project(fixture,tasks,options),legacy(fixture,tasks,options),"fixture "+sample);
 }
});
