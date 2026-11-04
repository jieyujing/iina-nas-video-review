"use strict";
// Storage-agnostic delete transaction. Inject only an independently VERIFIED
// atomic identity-conditional backend; IINA's pathname file.delete is unsafe.
// This module itself performs no filesystem operations.
function createDeleteCoordinator({backend,state,confirm,journal,onVerified}){
  let busy=false,sequence=0;
  const refused=reason=>({status:"REFUSED",reason});
  const ready=s=>!!s && s.active===true && s.matched===true &&
    typeof s.root==="string" && typeof s.path==="string" &&
    s.path.startsWith(s.root+"/") && Number.isInteger(s.cursor) && s.cursor>=0;
  const sameState=(a,b)=>ready(b) && a.root===b.root &&
    a.path===b.path && a.cursor===b.cursor &&
    a.queueId===b.queueId && a.mountBinding===b.mountBinding;
  const validEvidence=e=>!!e && e.regular===true && e.symlink===false &&
    typeof e.rootIdentity==="string" && !!e.rootIdentity &&
    typeof e.fileIdentity==="string" && !!e.fileIdentity &&
    typeof e.mountIdentity==="string" && !!e.mountIdentity;
  const sameEvidence=(a,b)=>validEvidence(a)&&validEvidence(b)&&
    a.rootIdentity===b.rootIdentity && a.fileIdentity===b.fileIdentity &&
    a.mountIdentity===b.mountIdentity;
  async function request(){
    if(busy)return refused("OPERATION_IN_PROGRESS");
    busy=true;
    try{
      const current=state();
      if(!ready(current))return refused("REVIEW_NOT_READY");
      if(backend?.capability!=="SUPPORTED_VERIFIED" ||
         typeof backend.deleteIfIdentity!=="function")
        return refused("UNSUPPORTED_SAFETY_CAPABILITY");
      if(typeof backend.inspect!=="function"||
         typeof backend.verifyAbsent!=="function"||
         typeof journal?.read!=="function"||
         typeof journal?.write!=="function")
        return refused("BACKEND_CONTRACT_UNAVAILABLE");
      let existing;
      try{existing=await journal.read();}catch(_){return refused("JOURNAL_UNAVAILABLE");}
      if(existing && !["VERIFIED_DELETED","CONFIRMED_FAILED"].includes(existing.state))
        return refused("UNRESOLVED_OPERATION");
      if(existing?.state==="VERIFIED_DELETED" &&
         existing.queueId===current.queueId && existing.cursor===current.cursor)
        return refused("ALREADY_DELETED");
      let first;
      try{first=await backend.inspect(current);}catch(_){return refused("SOURCE_UNAVAILABLE");}
      if(!validEvidence(first)||first.mountIdentity!==current.mountBinding)
        return refused("IDENTITY_UNVERIFIED");
      let accepted=false;
      try{accepted=await confirm({name:current.path.slice(current.root.length+1)});}
      catch(_){return refused("CONFIRMATION_UNAVAILABLE");}
      if(accepted!==true)return {status:"CANCELLED",reason:"CANCELLED"};
      if(!sameState(current,state()))return refused("REVIEW_CHANGED");
      let second;
      try{second=await backend.inspect(current);}
      catch(_){return refused("SOURCE_UNAVAILABLE");}
      if(!sameEvidence(first,second))return refused("FILE_IDENTITY_CHANGED");
      const id="delete-"+Date.now()+"-"+(++sequence);
      const intent={id,state:"INTENT",cursor:current.cursor,queueId:current.queueId,
        rootIdentity:first.rootIdentity,fileIdentity:first.fileIdentity,
        mountIdentity:first.mountIdentity};
      try{
        await journal.write(intent);
        await journal.write({...intent,state:"ISSUED"});
      }catch(_){return refused("JOURNAL_UNAVAILABLE");}
      let result;
      try{
        result=await backend.deleteIfIdentity({
          path:current.path,root:current.root,
          expectedIdentity:first.fileIdentity,
          expectedRootIdentity:first.rootIdentity,
          expectedMountIdentity:first.mountIdentity,id
        });
      }catch(_){result={status:"UNKNOWN"};}
      if(result?.status==="CONFIRMED_FAILED"){
        try{await journal.write({...intent,state:"CONFIRMED_FAILED"});}
        catch(_){return {status:"UNKNOWN",reason:"JOURNAL_UNAVAILABLE"};}
        return {status:"CONFIRMED_FAILED",reason:"STORAGE_REJECTED"};
      }
      if(result?.status==="SUCCESS"){
        try{
          const absent=await backend.verifyAbsent({
            path:current.path,root:current.root,expectedRootIdentity:first.rootIdentity,
            expectedMountIdentity:first.mountIdentity,id
          });
          if(absent===true && sameState(current,state())){
            await journal.write({...intent,state:"VERIFIED_DELETED"});
            try{await onVerified({id,queueCursor:current.cursor});}
            catch(_){return {status:"VERIFIED_DELETED",nextPlayback:"FAILED"};}
            return {status:"VERIFIED_DELETED",nextPlayback:"NOT_ISSUED"};
          }
        }catch(_){/* Outcome remains unknown: never auto-retry. */}
      }
      try{await journal.write({...intent,state:"UNKNOWN"});}catch(_){}
      return {status:"UNKNOWN",reason:"DELETE_INDETERMINATE"};
    }finally{busy=false;}
  }
  return {request};
}
module.exports={createDeleteCoordinator};
