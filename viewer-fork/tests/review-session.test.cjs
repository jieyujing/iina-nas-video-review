"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Review=require("../src/review-core.cjs");
const Session=require("../src/review-session.cjs");
const root="/private/tmp/iina-nas-review-fixture-resume";
function queue(){
  return Review.createQueue(root,[
    {filename:"video10.mp4",path:"/video10.mp4",isDir:false},
    {filename:"video2.mp4",path:"/video2.mp4",isDir:false}
  ]);
}
function saved(){
  const q=queue();
  Review.keepAndAdvance(q);
  return Session.encode(q,2,1700000000000);
}
test("durable v4 record includes recursive flag and no player state",()=>{
  const data=Session.parse(saved(),1700000000000);
  assert.deepEqual(data.entries.map(x=>x.name),["video2.mp4","video10.mp4"]);
  assert.deepEqual(data.entries.map(x=>x.status),["KEEP","PENDING"]);
  assert.equal(data.cursor,1);
  assert.equal(data.revision,2);
  assert.equal(data.version,4);
  assert.equal(data.recursive,false);
  assert.equal("playback" in data,false);
});
test("explicit Resume accepts only exactly matching scan of same local source",()=>{
  const data=Session.parse(saved(),1700000000000);
  const fresh=Session.reconcile(data,root,[
    {filename:"video10.mp4",path:"/video10.mp4",isDir:false},
    {filename:"video2.mp4",path:"/video2.mp4",isDir:false}
  ]);
  assert.equal(fresh.cursor,1);
  assert.equal(fresh.entries[0].status,"KEEP");
  assert.equal(Review.current(fresh).name,"video10.mp4");
  assert.throws(()=>Session.reconcile(data,"/Volumes/NAS",[]),/SOURCE_MISMATCH/);
  assert.throws(()=>Session.reconcile(data,root,[{filename:"video2.mp4",path:"/video2.mp4"}]),/SNAPSHOT_MISMATCH/);
  assert.throws(()=>Session.reconcile(data,root,[
    {filename:"video10.mp4",path:"/other.mp4"},
    {filename:"video2.mp4",path:"/video2.mp4"}
  ]),/SNAPSHOT_MISMATCH/);
});
test("corrupt, malicious, stale and oversized v3 checkpoints fail closed",()=>{
  const good=saved();
  const bad=[
    "{broken","{}",JSON.stringify({version:1,root:"/Volumes/NAS"}),
    good.replace("video10.mp4","../evil.mp4"),
    good.replace("PENDING","DELETED"),
    good.replace('"cursor":1','"cursor":999'),
    JSON.stringify({...JSON.parse(good),playback:{positionSec:14,paused:true}}),
    "x".repeat(300000)
  ];
  for(const value of bad)assert.equal(Session.parse(value,1700000000000),null);
  assert.equal(Session.parse(good,1700000000000+8*86400000),null);
});
test("completed Review is not resumable",()=>{
  const q=queue();
  Review.keepAndAdvance(q);Review.keepAndAdvance(q);
  const data=Session.parse(Session.encode(q,3,1700000000000),1700000000000);
  assert.equal(data.cursor,-1);
  assert.equal(data.active,false);
  assert.equal(Session.hasPending(data),false);
});
test("v2 queue-only checkpoints migrate to v3 without changing KEEP",()=>{
 const original=JSON.parse(saved());
 const {recursive:discard,...v2}=original;
 v2.version=2;
 const loaded=Session.parse(JSON.stringify(v2),1700000000000);
 assert.ok(loaded);
 assert.equal(loaded.recursive,false);
 assert.equal(loaded.cursor,1);
 assert.deepEqual(loaded.entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(JSON.parse(Session.encode(loaded,3,1700000000000)).version,4);
});
test("version 3 sequential checkpoint still migrates without changing KEEP decisions",()=>{
 const modern=JSON.parse(saved());
 modern.version=3;
 assert.equal(modern.recursive,false);
 const restored=Session.parse(JSON.stringify(modern),1700000000000);
 assert.ok(restored);
 assert.equal(restored.cursor,1);
 assert.deepEqual(restored.entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal(JSON.parse(Session.encode(restored,4,1700000000000)).version,4);
});
test("out-of-order KEEP survives a checkpoint without treating skipped items as reviewed",()=>{
 const q=Review.createQueue(root,["a.mp4","b.mp4","c.mp4"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 })));
 assert.equal(Review.select(q,2),true);
 Review.keepAndAdvance(q);
 const raw=Session.encode(q,4,1700000000000);
 const restored=Session.parse(raw,1700000000000);
 assert.equal(restored.cursor,0);
 assert.deepEqual(restored.entries.map(e=>e.status),["PENDING","PENDING","KEEP"]);
 const reconciled=Session.reconcile(restored,root,["a.mp4","b.mp4","c.mp4"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 })));
 assert.equal(reconciled.entries[2].status,"KEEP");
});
test("checkpoint rejects invalid or duplicate entries",()=>{
  const original=JSON.parse(Session.encode(queue(),1,1700000000000));
  for(const value of [
    {...original,entries:[...original.entries,{...original.entries[0]}]},
    {...original,entries:[{name:"sub/x.mp4",status:"PENDING"},original.entries[1]]},
    {...original,entries:[{name:"..",status:"PENDING"},original.entries[1]]}
  ])assert.equal(Session.parse(JSON.stringify(value),1700000000000),null);
});
