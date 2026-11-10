"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDurableVideoDeleteQueue}=require("../src/video-delete-queue.cjs");
const root="/Volumes/NAS/Review";
function fixture(existing=null){
 const store=new Map(existing?[["jobs",JSON.stringify(existing)]]:[]);
 const calls=[],decisions=[];
 let releaseFirst;
 const first=new Promise(resolve=>{releaseFirst=resolve});
 const q=createDurableVideoDeleteQueue({
   read:()=>store.get("jobs")||"",
   write:value=>{store.set("jobs",value)},
   onQueued:job=>{decisions.push("next:"+job.index);return true},
   run:async job=>{calls.push(job.index);if(job.index===0)return first;
     return {status:"VERIFIED_DELETED"}},
   onSettled:(job,result)=>{decisions.push("done:"+job.index+":"+result.status)},
 });
 return {q,store,calls,decisions,releaseFirst};
}
const task=i=>({root,path:root+"/video"+i+".mkv",
 index:i,binding:"smb",queueKey:"queue-A",name:"video"+i+".mkv"});
test("D-D-D enqueues immediately, single worker serializes actual SMB deletion",async()=>{
 const h=fixture();
 const a=h.q.enqueue(task(0)),b=h.q.enqueue(task(1)),c=h.q.enqueue(task(2));
 assert.equal(a.accepted,true);
 assert.equal(b.accepted,true);
 assert.equal(c.accepted,true);
 assert.deepEqual(h.decisions,["next:0","next:1","next:2"]);
 await Promise.resolve();
 assert.deepEqual(h.calls,[0],"only one backend task runs");
 assert.equal(h.q.snapshot().jobs.filter(j=>j.status==="QUEUED").length,2);
 h.releaseFirst({status:"VERIFIED_DELETED"});
 assert.equal((await a.completion).status,"VERIFIED_DELETED");
 assert.equal((await b.completion).status,"VERIFIED_DELETED");
 assert.equal((await c.completion).status,"VERIFIED_DELETED");
 assert.deepEqual(h.calls,[0,1,2]);
});
test("repeated D targeting an outstanding file is rejected, but different files enqueue",()=>{
 const h=fixture();
 assert.equal(h.q.enqueue(task(0)).accepted,true);
 assert.equal(h.q.enqueue(task(0)).reason,"DUPLICATE_TARGET");
 assert.equal(h.q.enqueue(task(1)).accepted,true);
 h.releaseFirst({status:"VERIFIED_DELETED"});
});
test("UNKNOWN stops later tasks and never retries issued files",async()=>{
 const h=fixture();
 const a=h.q.enqueue(task(0)),b=h.q.enqueue(task(1));
 await Promise.resolve();
 h.releaseFirst({status:"UNKNOWN"});
 assert.equal((await a.completion).status,"UNKNOWN");
 await Promise.resolve();
 assert.deepEqual(h.calls,[0]);
 assert.equal(h.q.enqueue(task(2)).reason,"UNRESOLVED_OPERATION");
 assert.equal(h.q.snapshot().jobs.find(j=>j.index===1).status,"QUEUED");
 assert.equal(b.completion instanceof Promise,true);
});
test("worker nonzero-but-confirmed failure preserves queue and progresses subsequent items",async()=>{
 const h=fixture();
 const a=h.q.enqueue(task(0)),b=h.q.enqueue(task(1));
 await Promise.resolve();
 h.releaseFirst({status:"COMMAND_FAILED"});
 assert.equal((await a.completion).status,"COMMAND_FAILED");
 assert.equal((await b.completion).status,"VERIFIED_DELETED");
 assert.deepEqual(h.calls,[0,1]);
});
test("restart never automatically replays QUEUED or RUNNING jobs",async()=>{
 const old={version:1,jobs:[{...task(0),id:"job-0",status:"RUNNING"},
  {...task(1),id:"job-1",status:"QUEUED"}]};
 const h=fixture(old);
 assert.deepEqual(h.calls,[]);
 const jobs=h.q.snapshot().jobs;
 assert.equal(jobs[0].status,"UNKNOWN");
 assert.equal(jobs[1].status,"PAUSED");
 assert.equal(h.q.enqueue(task(2)).reason,"UNRESOLVED_OPERATION");
});
test("cancel unissued tasks durably without touching running or unknown",async()=>{
 const h=fixture();
 const a=h.q.enqueue(task(0)),b=h.q.enqueue(task(1));
 await Promise.resolve();
 assert.deepEqual(h.q.cancelUnissued(),{accepted:true,count:1});
 assert.equal((await b.completion).status,"CANCELLED");
 assert.deepEqual(h.q.snapshot().jobs.map(j=>j.status),["RUNNING","CANCELLED"]);
 h.releaseFirst({status:"UNKNOWN"});
 await a.completion;
 assert.deepEqual(h.calls,[0]);
 assert.equal(h.q.snapshot().jobs[0].status,"UNKNOWN");
 assert.equal(JSON.parse(h.store.get("jobs")).jobs[1].status,"CANCELLED");
});
test("cancellation journal failure fails closed without issuing queued work",async()=>{
 let raw="",fail=false,calls=0;
 const q=createDurableVideoDeleteQueue({read:()=>raw,write:v=>{if(fail)throw Error("disk");raw=v},
   onQueued:()=>true,run:async()=>{calls++;return {status:"VERIFIED_DELETED"}}});
 q.enqueue(task(0));
 fail=true;
 assert.equal(q.cancelUnissued().accepted,false);
 await Promise.resolve();
 assert.equal(calls,0);
 assert.equal(q.snapshot().jobs[0].status,"QUEUED");
});
test("journal failure before command start leaves no runnable task",()=>{
 const h=createDurableVideoDeleteQueue({
  read:()=>"",write:()=>{throw Error("disk full")},
  onQueued:()=>true,run:async()=>{throw Error("SHOULD_NOT_RUN")}
 });
 assert.equal(h.enqueue(task(0)).reason,"JOURNAL_UNAVAILABLE");
 assert.equal(h.snapshot().jobs.length,0);
});
