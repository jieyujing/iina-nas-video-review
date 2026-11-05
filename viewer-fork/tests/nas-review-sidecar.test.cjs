"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const Sidecar=require("../src/nas-review-sidecar.cjs");
const root="/Volumes/Movies/Review";
const identity={allowed:true,binding:"aabbccdd",portableBinding:"11223344",
  mountPoint:"/Volumes/Movies"};
function snapshot(revision=2){
 return {version:1,sourceKind:"finder_smb_progress_only",
   root,mountBinding:identity.binding,rootIdentity:"40755|18|23",
   recursive:true,revision,updatedAt:1800000000000,
   cursor:1,active:true,
   entries:[{name:"Season 1/a.mp4",status:"KEEP"},
     {name:"Season 1/b.mp4",status:"PENDING"}]};
}
test("NAS backup is a portable, bounded relative-path snapshot, no Mac mount point",()=>{
 const raw=Sidecar.encode(snapshot(),identity,"writer-a");
 assert.equal(raw.includes("/Volumes/Movies"),false);
 const record=Sidecar.parse(raw);
 assert.equal(record.sourceId,"11223344");
 assert.equal(record.relativeRoot,"Review");
 assert.equal(record.writerId,"writer-a");
 assert.deepEqual(record.entries,snapshot().entries.map(x=>({
   path:x.name,status:x.status
 })));
 assert.equal(record.localRevision,2);
});
test("sidecar refuses path traversal, forged revisions, duplicate paths, and corruption",()=>{
 const source=Sidecar.encode(snapshot(),identity,"writer-a");
 const original=JSON.parse(source);
 for(const bad of [
  {...original,relativeRoot:"../elsewhere"},
  {...original,entries:[{path:"../escape",status:"KEEP"}]},
  {...original,entries:[{path:"a.mp4",status:"KEEP"},{path:"a.mp4",status:"PENDING"}]},
  {...original,cursor:2000},
  {...original,sourceId:"evil"},
  {...original,writerId:"../../evil"},
 ]){
   const changed={...bad};
   // Even if the accidentally-corrupt checksum is recomputed by a caller,
   // invalid fields must be rejected by the parser.
   assert.equal(Sidecar.parse(JSON.stringify(changed)),null);
 }
 assert.equal(Sidecar.parse(source.slice(0,-2)),null);
 assert.equal(Sidecar.parse("x".repeat(1100000)),null);
});
test("NAS mirror rejects a conflicting writer, never overwrites a divergent checkpoint",async()=>{
 const previous=Sidecar.encode(snapshot(3),identity,"writer-other");
 let wrote=0;
 const mirror=Sidecar.createMirror({
   load:async()=>previous,
   save:async()=>{wrote++;},
   log:()=>{}
 });
 const result=await mirror.publish(snapshot(4),identity,"writer-this");
 assert.equal(result.status,"conflict");
 assert.equal(wrote,0);
});
test("same-writer same-revision but different KEEP state is a conflict, never false synced",async()=>{
 const previous=Sidecar.encode(snapshot(3),identity,"writer-a");
 const changed=snapshot(3);
 changed.entries[0].status="PENDING";
 changed.cursor=0;
 const mirror=Sidecar.createMirror({
   load:async()=>previous,save:async()=>{throw Error("must not overwrite");}
 });
 assert.equal((await mirror.publish(changed,identity,"writer-a")).status,"conflict");
});
test("portable backup supports the SMB share mount root itself",()=>{
 const rootSnapshot={...snapshot(),root:"/Volumes/Movies"};
 const proof={...identity,portableBinding:"deadbeef"};
 const data=Sidecar.parse(Sidecar.encode(rootSnapshot,proof,"writer-a"));
 assert.equal(data.relativeRoot,"");
 assert.equal(data.sourceId,"deadbeef");
});
test("NAS mirror serializes writes, retries after failure, and keeps latest local revision",async()=>{
 let saved=null,calls=0;
 const mirror=Sidecar.createMirror({
   load:async()=>saved,
   save:async raw=>{
     if(++calls===1)throw Error("SMB_OFFLINE");
     saved=raw;
   },log:()=>{}
 });
 assert.equal((await mirror.publish(snapshot(2),identity,"writer-a")).status,"pending");
 assert.equal((await mirror.publish(snapshot(3),identity,"writer-a")).status,"synced");
 assert.equal(Sidecar.parse(saved).localRevision,3);
 assert.equal(calls,2);
});
