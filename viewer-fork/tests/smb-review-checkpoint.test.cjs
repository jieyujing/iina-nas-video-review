"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Review=require("../src/review-core.cjs");
const SMB=require("../src/smb-review-checkpoint.cjs");
const root="/Volumes/Movies/Review";
const mount="1234abcd";
const rootIdentity="40755|18|23|80|17000000";
const rows=["sample.mkv","z-next.mkv"].map(name=>({filename:name,path:"/"+name,isDir:false}));
function queue(){
 const q=Review.createQueue(root,rows,{recursive:false,nasReadOnly:true});
 q.nasReadOnly=true;q.nasBinding=mount;q.nasRootIdentity=rootIdentity;
 return q;
}
test("SMBFS reconnect allows a new local device id but requires matching directory type and inode",()=>{
 assert.equal(SMB.sameRootAfterRemount("40755|18|23","40755|66|23|90|1800000"),true);
 assert.equal(SMB.sameRootAfterRemount("40755|18|23","40755|66|24"),false);
 assert.equal(SMB.sameRootAfterRemount("40755|18|23","100644|66|23"),false);
 assert.equal(SMB.sameRootAfterRemount("40755|18|23","invalid"),false);
});
test("SMB record saves non-destructive KEEP/cursor only and survives reload",()=>{
 const q=queue();Review.keepAndAdvance(q);
 const raw=SMB.encode(q,1,1700000000000);
 const saved=SMB.parse(raw,1700000000000);
 assert.equal(saved.root,root);
 assert.equal(saved.mountBinding,mount);
 assert.equal(saved.rootIdentity,"40755|18|23");
 assert.equal(saved.entries[0].status,"KEEP");
 assert.equal(saved.cursor,1);
 assert.equal(SMB.hasPending(saved),true);
 assert.equal("playback" in saved,false);
 const recovered=SMB.reconcile(saved,{root,mountBinding:mount,rootIdentity,listed:rows});
 assert.equal(recovered.cursor,1);
 assert.equal(recovered.entries[0].status,"KEEP");
 assert.equal(recovered.entries[1].status,"PENDING");
});
test("SMB restore refuses changed share, root inode, and unexpected new media",()=>{
 const saved=SMB.parse(SMB.encode(queue(),1,1700000000000),1700000000000);
 for(const context of [
  {root,mountBinding:"other",rootIdentity,listed:rows},
  {root,mountBinding:mount,rootIdentity:"40755|18|99|80|17000000",listed:rows},
  {root,mountBinding:mount,rootIdentity,listed:[...rows,{filename:"new.mkv",path:"/new.mkv",isDir:false}]}
 ])assert.throws(()=>SMB.reconcile(saved,context));
});
test("same verified SMB folder treats absent PENDING as DELETED without losing KEEP or cursor continuity",()=>{
 const q=Review.createQueue(root,[
   ...rows,{filename:"third.mkv",path:"/third.mkv",isDir:false}
 ],{recursive:false,nasReadOnly:true});
 q.nasReadOnly=true;q.nasBinding=mount;q.nasRootIdentity=rootIdentity;
 Review.keepAndAdvance(q);
 const saved=SMB.parse(SMB.encode(q,3,1700000000000),1700000000000);
 assert.equal(saved.cursor,1);
 const actual=[...rows];
 const resumed=SMB.reconcile(saved,{
   root,mountBinding:mount,rootIdentity,listed:actual
 });
 assert.equal(resumed.entries[0].status,"KEEP");
 assert.equal(resumed.entries[1].status,"DELETED");
 assert.equal(resumed.entries[2].status,"PENDING");
 assert.equal(resumed.cursor,2);
 assert.equal(resumed.active,true);
 assert.equal(SMB.parse(SMB.encode(resumed,4,1700000000000),1700000000000).entries[1].status,"DELETED");
});
test("legacy MISSING becomes DELETED when still absent from the verified SMB folder",()=>{
 const q=Review.createQueue(root,[
   ...rows,{filename:"third.mkv",path:"/third.mkv",isDir:false}
 ],{recursive:false,nasReadOnly:true});
 q.nasReadOnly=true;q.nasBinding=mount;q.nasRootIdentity=rootIdentity;
 Review.keepAndAdvance(q);
 const saved=SMB.parse(SMB.encode(q,3,1700000000000),1700000000000);
 const missing=SMB.reconcile(saved,{root,mountBinding:mount,rootIdentity,
   listed:rows});
 const recovered=SMB.reconcile(SMB.parse(SMB.encode(missing,4,1700000000000),1700000000000),{
   root,mountBinding:mount,rootIdentity,
   listed:rows
 });
 assert.equal(recovered.entries[1].status,"DELETED");
 assert.equal(recovered.entries[0].status,"KEEP");
 assert.equal(recovered.cursor,2);
});
test("when no pending SMB video remains, recovered Review finishes rather than refusing restore",()=>{
 const saved=SMB.parse(SMB.encode(queue(),5,1700000000000),1700000000000);
 const completed=SMB.reconcile(saved,{
   root,mountBinding:mount,rootIdentity,listed:[]
 });
 assert.equal(completed.active,false);
 assert.equal(completed.cursor,-1);
 assert.deepEqual(completed.entries.map(x=>x.status),["DELETED","DELETED"]);
 assert.ok(SMB.parse(SMB.encode(completed,6,1700000000000),1700000000000));
});
test("SMB record tracks DELETED without treating intentionally absent file as a changed snapshot",()=>{
 const q=queue();Review.advance(q,"DELETED");
 const saved=SMB.parse(SMB.encode(q,3,1700000000000),1700000000000);
 const recovered=SMB.reconcile(saved,{
  root,mountBinding:mount,rootIdentity,listed:[rows[1]]
 });
 assert.equal(recovered.entries[0].status,"DELETED");
 assert.equal(recovered.entries[1].status,"PENDING");
 assert.equal(recovered.cursor,1);
});
test("SMB checkpoint rejects malicious, stale, duplicated, oversized and arbitrary source records",()=>{
 const raw=SMB.encode(queue(),1,1700000000000);
 for(const value of [
  "{",JSON.stringify({...JSON.parse(raw),root:"/private/tmp/foo"}),
  JSON.stringify({...JSON.parse(raw),entries:[...JSON.parse(raw).entries,JSON.parse(raw).entries[0]]}),
  JSON.stringify({...JSON.parse(raw),entries:[
    JSON.parse(raw).entries[0],JSON.parse(raw).entries[0],
    JSON.parse(raw).entries[1]
  ]}),
  raw.replace("sample.mkv","../unsafe.mkv"),
  "a".repeat(1024*1024+1)
 ])assert.equal(SMB.parse(value,1700000000000),null);
 assert.equal(SMB.parse(raw,1700000000000+8*86400000),null);
});
