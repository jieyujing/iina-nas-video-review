"use strict";
// Persisted single-worker video deletion queue. This module never deletes files.
// A task with an uncertain outcome is never replayed on startup.
const ACTIVE=new Set(["QUEUED","RUNNING","PAUSED","UNKNOWN"]);
const FINISHED=new Set(["DELETED","FAILED","CANCELLED","RECONCILED"]);
const MAX_JOBS=256;
function validTask(j){
 return !!j && typeof j.id==="string" && j.id.length>0 &&
   typeof j.root==="string" && j.root.startsWith("/Volumes/") &&
   typeof j.path==="string" && j.path.startsWith(j.root+"/") &&
   !j.path.split("/").some(part=>part===".."||part===".") &&
   typeof j.binding==="string" && j.binding.length>0 &&
   typeof j.queueKey==="string" && j.queueKey.length>0 &&
   Number.isSafeInteger(j.index) && j.index>=0 &&
   typeof j.status==="string" && (ACTIVE.has(j.status)||FINISHED.has(j.status));
}
function createDurableVideoDeleteQueue({read,write,onQueued,run,onSettled=()=>{},
    onStatus=()=>{},onResumeConfirm=()=>false,maxPending=128}={}){
 let jobs=[],processing=false,healthy=true,sequence=0;
 const promises=new Map();
 const copy=()=>jobs.map(j=>({...j}));
 const snapshot=()=>({jobs:copy(),processing,healthy,
   unresolved:jobs.some(j=>j.status==="UNKNOWN"),
   pending:jobs.filter(j=>ACTIVE.has(j.status)).length});
 function notify(){try{onStatus(snapshot());}catch(_){}}
 function persist(next){
   if(!healthy)return false;
   const before=jobs;
   try{
     if(typeof read!=="function"||typeof write!=="function")throw Error("NO_STORE");
     const encoded=JSON.stringify({version:1,jobs:next});
     write(encoded);
     if(read()!==encoded)throw Error("JOURNAL_READBACK_FAILED");
     jobs=next;
     return true;
   }catch(_){
     // Never execute a pending mutation after ambiguous persistence.
     healthy=false;
     jobs=before;
     notify();
     return false;
   }
 }
 try{
   const raw=typeof read==="function"?read():"";
   if(raw){
     const parsed=JSON.parse(raw);
     if(parsed?.version!==1||!Array.isArray(parsed.jobs)||
        parsed.jobs.length>MAX_JOBS||!parsed.jobs.every(validTask))
       throw Error("INVALID_JOURNAL");
     const ids=new Set();
     if(parsed.jobs.some(j=>ids.has(j.id)||!(ids.add(j.id))))throw Error("DUPLICATE_JOB");
     jobs=parsed.jobs.map(j=>({...j}));
     let changed=false;
     for(const task of jobs){
       if(task.status==="QUEUED"){task.status="PAUSED";changed=true;}
       else if(task.status==="RUNNING"){task.status="UNKNOWN";changed=true;}
     }
     if(changed && !persist(copy()))healthy=false;
   }
 }catch(_){healthy=false;}
 function blocked(){
   return !healthy||jobs.some(j=>j.status==="UNKNOWN");
 }
 function activeForTask(task){
   return jobs.find(j=>ACTIVE.has(j.status)&&j.root===task.root&&j.index===task.index);
 }
 function allowed(task){
   if(blocked())return healthy?"UNRESOLVED_OPERATION":"JOURNAL_UNAVAILABLE";
   if(!task||typeof task.root!=="string"||typeof task.path!=="string" ||
      !task.path.startsWith(task.root+"/")||!Number.isSafeInteger(task.index)||
      task.index<0||typeof task.binding!=="string"||!task.binding ||
      typeof task.queueKey!=="string"||!task.queueKey ||
      !task.root.startsWith("/Volumes/"))return "INVALID_TARGET";
   if(activeForTask(task))return "DUPLICATE_TARGET";
   if(jobs.some(j=>ACTIVE.has(j.status)&&j.queueKey!==task.queueKey))
     return "ANOTHER_REVIEW_PENDING";
   if(jobs.filter(j=>ACTIVE.has(j.status)).length>=maxPending)return "QUEUE_FULL";
   return null;
 }
 function next(){
   const pending=jobs.find(j=>j.status==="QUEUED");
   if(!pending || blocked())return null;
   return pending;
 }
 async function pump(){
   if(processing||blocked())return;
   processing=true;
   try{
     while(!blocked()){
       const selected=next();
       if(!selected)break;
       const running=jobs.map(j=>j.id===selected.id?{...j,status:"RUNNING"}:j);
       if(!persist(running))break;
       notify();
       let result;
       try{result=await run({...running.find(j=>j.id===selected.id)});}
       catch(_){result={status:"UNKNOWN",reason:"EXECUTOR_EXCEPTION"};}
       if(!result||typeof result.status!=="string")
         result={status:"UNKNOWN",reason:"INVALID_EXECUTOR_RESULT"};
       const status=
         result.status==="VERIFIED_DELETED"||
         (result.status==="EXPERIMENTAL_DELETED"&&
          (result.nextPlayback==="NOT_ISSUED"||result.nextPlayback==="DONE"))?
           "DELETED":
         result.status==="COMMAND_FAILED"||result.status==="REFUSED"?
           "FAILED":
         result.status==="CANCELLED"?"CANCELLED":"UNKNOWN";
       const terminal=jobs.map(j=>j.id===selected.id?
         {...j,status,reason:result.reason||result.nextPlayback||""}:j);
       if(!persist(terminal))break;
       notify();
       try{onSettled(terminal.find(j=>j.id===selected.id),result);}
       catch(_){}
       const done=promises.get(selected.id);
       if(done){done.resolve(result);promises.delete(selected.id);}
       if(status==="UNKNOWN")break;
     }
   }finally{processing=false;notify();}
 }
 function enqueue(task){
   const reason=allowed(task);
   if(reason)return {accepted:false,reason};
   const job={root:task.root,path:task.path,index:task.index,
     binding:task.binding,queueKey:task.queueKey,
     name:typeof task.name==="string"?task.name:"",
     duration:Number.isFinite(task.duration)?task.duration:0,
     id:"video-delete-"+Date.now()+"-"+(++sequence),status:"QUEUED"};
   const clean=jobs.filter(j=>ACTIVE.has(j.status)).concat(
     jobs.filter(j=>FINISHED.has(j.status)).slice(-Math.max(0,MAX_JOBS-130)));
   if(!persist(clean.concat(job)))return {accepted:false,reason:"JOURNAL_UNAVAILABLE"};
   // Cursor changes must succeed durably before the worker is allowed to rm.
   let accepted=false;
   try{accepted=onQueued(job)===true;}catch(_){}
   if(!accepted){
     // The queued job was never issued. Do not delete if rollback fails.
     if(!persist(jobs.map(j=>j.id===job.id?{...j,status:"PAUSED"}:j))){
       return {accepted:false,reason:"JOURNAL_UNAVAILABLE"};
     }
     notify();
     return {accepted:false,reason:"CHECKPOINT_UNAVAILABLE"};
   }
   let resolve;
   const completion=new Promise(r=>{resolve=r});
   promises.set(job.id,{resolve});
   notify();
   void Promise.resolve().then(pump);
   return {accepted:true,id:job.id,completion};
 }
 async function resumePaused(){
   if(blocked())return {accepted:false,reason:"UNRESOLVED_OPERATION"};
   const paused=jobs.filter(j=>j.status==="PAUSED");
   if(!paused.length)return {accepted:false,reason:"NO_PAUSED_JOBS"};
   for(const task of paused){
     if((await onResumeConfirm({...task}))!==true)
       return {accepted:false,reason:"RESUME_NOT_AUTHORIZED"};
   }
   if(!persist(jobs.map(j=>j.status==="PAUSED"?{...j,status:"QUEUED"}:j)))
     return {accepted:false,reason:"JOURNAL_UNAVAILABLE"};
   notify();
   void Promise.resolve().then(pump);
   return {accepted:true,count:paused.length};
 }
 // The caller MUST independently verify the original SMB target and obtain
 // user confirmation. This method has no authority to infer a deletion.
 function reconcileUnknown(id,{verified=false,absent=false}={}){
   if(!verified || typeof id!=="string")return false;
   if(!jobs.some(j=>j.id===id&&j.status==="UNKNOWN"))return false;
   if(!persist(jobs.map(j=>j.id===id?{...j,status:"RECONCILED",
      reason:absent?"OBSERVED_MISSING":"OBSERVED_PRESENT"}:j)))return false;
   notify();
   return true;
 }
 function pendingIndices(root){return new Set(jobs.filter(j=>
   ACTIVE.has(j.status)&&j.root===root).map(j=>j.index));}
 function pendingCount(){return jobs.filter(j=>ACTIVE.has(j.status)).length;}
 return {enqueue,resumePaused,reconcileUnknown,pendingIndices,pendingCount,
   snapshot,blocked};
}
module.exports={createDurableVideoDeleteQueue};
