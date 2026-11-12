"use strict";
// Single-consumer scheduler with a cleanup write barrier. Newer preview
// requests overtake older queued previews only within the same barrier epoch.
// In-flight FFmpeg cannot be interrupted by this abstraction: the consumer
// awaits its real process completion before cleanup can remove its JPEGs.
function createThumbnailJobScheduler({log=()=>{}}={}){
 const pending=[];
 let active=false;
 function drain(){
  if(active)return;
  active=true;
  void (async()=>{
   while(pending.length){
    const barrier=pending.findIndex(task=>task.kind==="cleanup");
    const candidates=barrier<0?pending.length:barrier;
    // Cleanup has absolute priority once everything queued before it ran.
    const index=candidates===0?0:candidates-1;
    const [task]=pending.splice(index,1);
    if(task.kind==="generate" && task.isCancelled?.()){
     log("thumbnail.job.cancelled",{reason:"stale_queued"});
     task.resolve([]);
     continue;
    }
    try{task.resolve(await task.run());}
    catch(error){task.reject(error);}
   }
  })().finally(()=>{active=false;if(pending.length)drain();});
 }
 function enqueue(kind,run,isCancelled){
  return new Promise((resolve,reject)=>{
   pending.push({kind,run,isCancelled,resolve,reject});
   drain();
  });
 }
 return {
  generate:(run,{isCancelled}={})=>enqueue("generate",run,isCancelled),
  cleanup:run=>enqueue("cleanup",run),
  pending:()=>pending.length
 };
}
module.exports={createThumbnailJobScheduler};
