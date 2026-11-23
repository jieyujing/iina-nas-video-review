"use strict";
const assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
const {project}=require("../src/review-projection.cjs");
const n=Number(process.env.PROJECTION_ENTRIES||20000),j=Number(process.env.PROJECTION_JOBS||256),
 iterations=Number(process.env.PROJECTION_ITERATIONS||40),rounds=Number(process.env.PROJECTION_ROUNDS||7);
assert.ok(Number.isInteger(n)&&n>0&&n<=20000&&Number.isInteger(j)&&j>=0&&j<=256);
assert.ok(Number.isInteger(iterations)&&iterations>0&&Number.isInteger(rounds)&&rounds>=5);
const root="/Volumes/Projection/Review";
const queue={root,entries:Array.from({length:n},(_,i)=>({
 name:`video-${String(i).padStart(6,"0")}.mkv`,path:`${root}/video-${String(i).padStart(6,"0")}.mkv`,
 status:i%17===0?"KEEP":i%31===0?"DELETED":i%43===0?"MISSING":"PENDING"
}))};
const jobs=Array.from({length:j},(_,i)=>({root,index:(i*73)%n,path:queue.entries[(i*73)%n].path,
 status:["QUEUED","RUNNING","PAUSED","UNKNOWN","FAILED"][i%5],id:i===j-1?"legacy":"job-"+i}));
const options={playingPath:queue.entries[n-12].path,cursor:0,windowSize:120,legacyQueueId:"legacy"};
function legacy(){
 const entries=queue.entries,counts=Object.create(null);
 for(const status of ["RUNNING","QUEUED","PAUSED","UNKNOWN","DELETED","FAILED","RECONCILED","CANCELLED"])
  counts[status]=jobs.filter(job=>job.status===status).length;
 const hasUnknown=jobs.some(job=>job.status==="UNKNOWN");
 const legacyQueueRunning=jobs.some(job=>job.status==="RUNNING"&&job.id===options.legacyQueueId);
 const keptCount=entries.filter(e=>e.status==="KEEP").length;
 const deletedCount=entries.filter(e=>e.status==="DELETED").length;
 const missingCount=entries.filter(e=>e.status==="MISSING").length;
 const playingPosition=entries.findIndex(e=>e.path===options.playingPath);
 const anchor=playingPosition>=0?playingPosition:Math.max(0,options.cursor);
 const windowStart=entries.length>options.windowSize?
  Math.max(0,Math.min(anchor-Math.floor(options.windowSize/2),entries.length-options.windowSize)):0;
 const projected=entries.slice(windowStart,windowStart+options.windowSize).map(({name,status,path},i)=>{
  const index=windowStart+i;
  const job=jobs.find(task=>task.root===root&&task.index===index&&task.path===path&&
   ["QUEUED","RUNNING","PAUSED","UNKNOWN"].includes(task.status));
  return {name,status:job?job.status:status,position:index};
 });
 return {playingPosition,keptCount,deletedCount,missingCount,counts,hasUnknown,legacyQueueRunning,
  windowStart,entries:projected};
}
function candidate(){return project(queue,jobs,options);}
const expected=legacy();assert.deepEqual(candidate(),expected);
let errors=0,checks=0,checksum=0;
function run(fn){
 let actual,consumed=0;const started=performance.now();
 for(let i=0;i<iterations;i++){
  try{actual=fn();consumed+=actual.entries.length+actual.keptCount+actual.deletedCount+
    actual.missingCount+(actual.counts.RUNNING||0)+actual.playingPosition;checks++;}
  catch(_){errors++;}
 }
 const elapsed=performance.now()-started;
 try{assert.deepEqual(actual,expected);}catch(_){errors++;}
 checksum+=consumed;return elapsed;
}
run(legacy);run(candidate);
const results={legacy:[],candidate:[]};
for(let k=0;k<rounds;k++)for(const name of k%2?["candidate","legacy"]:["legacy","candidate"])
 results[name].push(run(name==="legacy"?legacy:candidate));
function summary(values){const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],rangeMs:[sorted[0],sorted.at(-1)],runsMs:values};}
console.log(JSON.stringify({node:process.version,entries:n,jobs:j,window:options.windowSize,iterationsPerRun:iterations,
 rounds,legacy:summary(results.legacy),candidate:summary(results.candidate),checkedResults:checks,errors,checksum,
 scope:"synthetic projection CPU only; excludes IINA, IPC, storage, NAS, UI rendering"},null,2));
if(errors)process.exitCode=1;
