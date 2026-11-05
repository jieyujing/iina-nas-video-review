"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createCacheCleanupQueue,validSnapshot,KEY}=
  require("../src/cache-cleanup-queue.cjs");
const snapshot={
  dir:"/tmp/Library/Caches/com.colliderli.iina/nas-review-generated",
  hashes:["0123456789abcdef0123456789abcdef"]
};
function storage(){
  const values=new Map(),writes=[];
  return {values,writes,prefs:{
    get:key=>values.get(key)||null,
    set(key,value){writes.push({key,value});values.set(key,value);},
    sync(){}
  }};
}
test("queue persists cleanup identity before running it and clears after success",async()=>{
 const s=storage(),seen=[];
 const queue=createCacheCleanupQueue({preferences:s.prefs,run:async value=>{
   seen.push(value);
   assert.equal(JSON.parse(s.values.get(KEY)).length,1,
     "the job must be durable before attempting cleanup");
   return {removed:4,failed:0};
 }});
 assert.equal(queue.enqueue(snapshot),true);
 await queue.waitForIdle();
 assert.equal(queue.pending(),0);
 assert.equal(JSON.parse(s.values.get(KEY)).length,0);
 assert.deepEqual(seen,[snapshot]);
});
test("a partial cleanup is retained for the next IINA startup, not retried in a tight loop",async()=>{
 const s=storage(),observations=[];
 const first=createCacheCleanupQueue({preferences:s.prefs,
   run:async()=>{observations.push("failed");return {removed:1,failed:1};}});
 assert.equal(first.enqueue(snapshot),true);
 await first.waitForIdle();
 assert.equal(first.pending(),1);
 assert.deepEqual(observations,["failed"]);
 const second=createCacheCleanupQueue({preferences:s.prefs,run:async value=>{
   assert.deepEqual(value,snapshot);
   observations.push("recovered");
   return {removed:1,failed:0};
 }});
 await second.resume();
 assert.deepEqual(observations,["failed","recovered"]);
 assert.equal(second.pending(),0);
 assert.equal(JSON.parse(s.values.get(KEY)).length,0);
});
test("corrupted or arbitrary paths cannot enter a durable cleanup queue",async()=>{
 const s=storage(),seen=[];
 const queue=createCacheCleanupQueue({preferences:s.prefs,
   run:async value=>seen.push(value)});
 for(const candidate of [
   {...snapshot,dir:"/Volumes/Media/Library/Caches/com.colliderli.iina/nas-review-generated"},
   {...snapshot,hashes:["../unrelated"]},
   {...snapshot,hashes:[]},
   {...snapshot,hashes:["a".repeat(32),"a".repeat(32),"x".repeat(32)]},
   null
 ]){
   assert.equal(validSnapshot(candidate),false);
   assert.equal(queue.enqueue(candidate),false);
 }
 await queue.waitForIdle();
 assert.deepEqual(seen,[]);
 assert.equal(queue.pending(),0);
});
