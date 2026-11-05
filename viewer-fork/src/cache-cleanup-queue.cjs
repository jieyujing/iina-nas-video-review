"use strict";
// Durable, best-effort cleanup of ONLY the plugin's generated JPEGs. The
// entries contain no SMB path or media filename. They are enqueued only
// after a separately confirmed /bin/rm exit code 0 for the video.
const KEY="nasTimelineCacheCleanupQueueV1";
const LIMIT=32;
function validSnapshot(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||
     typeof value.dir!=="string" || !(
       /^\/Users\/[^/]+\/Library\/Caches\/com\.colliderli\.iina\/nas-review-generated$/.test(value.dir)||
       value.dir==="/tmp/Library/Caches/com.colliderli.iina/nas-review-generated"
     )||!Array.isArray(value.hashes)||value.hashes.length<1||
     value.hashes.length>16)return false;
  return value.hashes.every(hash=>typeof hash==="string"&&
    /^[0-9a-f]{32}$/.test(hash));
}
function createCacheCleanupQueue({preferences,run,log=()=>{}}={}){
  let jobs=[];
  try{
    const raw=preferences?.get?.(KEY);
    if(raw){
      const parsed=JSON.parse(raw);
      if(Array.isArray(parsed)&&parsed.length<=LIMIT)
        jobs=parsed.filter(x=>x&&typeof x.id==="string"&&
          x.id.length>0&&x.id.length<=100&&validSnapshot(x.snapshot));
    }
  }catch(_){log("thumbnail.cleanup.journal_invalid",{},"warn");}
  let draining=null,sequence=0;
  function save(){
    if(typeof preferences?.set!=="function"||
       typeof preferences?.sync!=="function")
      throw Error("cleanup_persistence_unavailable");
    preferences.set(KEY,JSON.stringify(jobs));
    preferences.sync();
  }
  function drain(){
    if(draining)return draining;
    draining=(async()=>{
      while(jobs.length){
        const job=jobs[0];
        try{
          if(typeof run!=="function")throw Error("cleanup_api_unavailable");
          const result=await run(job.snapshot);
          if(!result || !Number.isInteger(result.failed)||result.failed>0)
            throw Error("cleanup_partial");
          jobs.shift();
          try{save();}
          catch(_){log("thumbnail.cleanup.journal_save_failed",{},"warn");}
        }catch(_){
          // Retain the failed job on disk for a later IINA startup.
          log("thumbnail.cleanup.pending_retry",{},"warn");
          break;
        }
      }
    })().finally(()=>{draining=null;});
    return draining;
  }
  function enqueue(snapshot){
    if(!validSnapshot(snapshot)||jobs.length>=LIMIT){
      log("thumbnail.cleanup.queue_rejected",{},"warn");
      return false;
    }
    const entry={id:String(Date.now())+"-"+(++sequence),
      snapshot:{dir:snapshot.dir,hashes:[...new Set(snapshot.hashes)]}};
    jobs.push(entry);
    try{save();}
    catch(_){log("thumbnail.cleanup.journal_save_failed",{},"warn");}
    void drain();
    return true;
  }
  return {enqueue,resume:()=>drain(),waitForIdle:()=>draining||Promise.resolve(),
    pending:()=>jobs.length};
}
module.exports={createCacheCleanupQueue,validSnapshot,KEY};
