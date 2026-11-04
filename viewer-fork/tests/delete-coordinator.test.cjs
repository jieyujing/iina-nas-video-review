"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createDeleteCoordinator}=require("../src/delete-coordinator.cjs");
function harness({capability="SUPPORTED_VERIFIED",confirmResult=true,failAt="",changedIdentity=false}={}){
 let current={root:"/Volumes/M/Films",path:"/Volumes/M/Films/movie.mp4",
    cursor:0,active:true,matched:true,mountBinding:"share-id",queueId:"session-A"};
 const actions=[],journal=new Map();
 const backend={
  capability,
  async inspect(){
   actions.push("inspect");
   return {rootIdentity:"root-A",fileIdentity:changedIdentity&&actions.filter(x=>x==="inspect").length>1?"file-B":"file-A",
     regular:true,symlink:false,mountIdentity:"share-id"};
  },
  async deleteIfIdentity({expectedIdentity}){
   actions.push("conditional-delete");
   assert.equal(expectedIdentity,"file-A");
   if(failAt==="response")throw Error("SMB disconnected");
   return {status:failAt==="permission"?"CONFIRMED_FAILED":"SUCCESS"};
  },
  async verifyAbsent(){actions.push("verify");return failAt==="verify"?false:true;}
 };
 const coordinator=createDeleteCoordinator({
  backend,
  state:()=>current,
  confirm:async()=>{actions.push("confirm");return confirmResult;},
  journal:{
   read:()=>journal.get("op")||null,
   write:(v)=>{actions.push("journal:"+v.state);
     if(failAt==="journal"&&v.state==="ISSUED")throw Error("sync failed");
     journal.set("op",v);}
  },
  onVerified:()=>{actions.push("advance");
    if(failAt==="advance")throw Error("Playback failed");}
 });
 return {coordinator,actions,journal,setCurrent:v=>{current=v;}};
}
test("unsupported SMB backend refuses before confirmation, journal, or any delete",async()=>{
 const h=harness({capability:"UNSUPPORTED"});
 assert.equal((await h.coordinator.request()).reason,"UNSUPPORTED_SAFETY_CAPABILITY");
 assert.deepEqual(h.actions,[]);
});
test("cancelled native confirmation performs no mutation",async()=>{
 const h=harness({confirmResult:false});
 assert.equal((await h.coordinator.request()).reason,"CANCELLED");
 assert.deepEqual(h.actions,["inspect","confirm"]);
});
test("identity replacement between preview and confirmation refuses without deletion",async()=>{
 const h=harness({changedIdentity:true});
 assert.equal((await h.coordinator.request()).reason,"FILE_IDENTITY_CHANGED");
 assert.equal(h.actions.includes("conditional-delete"),false);
});
test("successful conditional delete journals INTENT, ISSUED, VERIFIED before advancing",async()=>{
 const h=harness();
 const r=await h.coordinator.request();
 assert.equal(r.status,"VERIFIED_DELETED");
 assert.deepEqual(h.actions,["inspect","confirm","inspect","journal:INTENT","journal:ISSUED",
   "conditional-delete","verify","journal:VERIFIED_DELETED","advance"]);
});
test("durable journal error blocks delete and advance",async()=>{
 const h=harness({failAt:"journal"});
 assert.equal((await h.coordinator.request()).reason,"JOURNAL_UNAVAILABLE");
 assert.equal(h.actions.includes("conditional-delete"),false);
});
test("lost response or failed final verification becomes UNKNOWN, never advances/reissues",async()=>{
 for(const failAt of ["response","verify"]){
  const h=harness({failAt});
  const r=await h.coordinator.request();
  assert.equal(r.status,"UNKNOWN");
  assert.equal(h.actions.includes("advance"),false);
  const attempted=h.actions.filter(x=>x==="conditional-delete").length;
  assert.equal((await h.coordinator.request()).reason,"UNRESOLVED_OPERATION");
  assert.equal(h.actions.filter(x=>x==="conditional-delete").length,attempted);
 }
});
test("verified deletion with failed queue advance never reissues same cursor",async()=>{
 const h=harness({failAt:"advance"});
 const result=await h.coordinator.request();
 assert.equal(result.status,"VERIFIED_DELETED");
 assert.equal(result.nextPlayback,"FAILED");
 assert.equal((await h.coordinator.request()).reason,"ALREADY_DELETED");
 assert.equal(h.actions.filter(x=>x==="conditional-delete").length,1);
});
test("stale player identity or unconfirmed file-loaded blocks deletion",async()=>{
 const h=harness();
 h.setCurrent({root:"/Volumes/M/Films",path:"/Volumes/M/Films/movie.mp4",
  cursor:0,active:true,matched:false,queueId:"session-A"});
 assert.equal((await h.coordinator.request()).reason,"REVIEW_NOT_READY");
 assert.deepEqual(h.actions,[]);
});
