"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createExperimentalDelete}=require("../src/experimental-delete.cjs");
const mount={allowed:true,binding:"mount-A",mountPoint:"/Volumes/Media"};
function harness({confirmed=true,changed=false,throwDelete=false,rootChanged=false,
    notMounted=false,symlink=false,unknown=false,notEnabled=false,
    lostJournalWrites=false,recoveryAccepted=true,rootMetadataChanges=false,
    rootInodeChanges=false,rootMetadataChangesOnDelete=false,
    rootInodeChangesOnDelete=false,playbackUnmatchedAfterDelete=false,
    cursorChangedAfterDelete=false,missingAfterDelete=false,
    missingAdvanceFails=false,progressSaveFails=false,
    failSuccessJournalWrite=false,recursive=false,nested=false,
    cacheCaptureFails=false,cacheCleanupFails=false}={}){
 const root="/Volumes/Media/review",path=root+(nested?"/Season 1":"")+"/sample.mkv";
 const events=[],journal=[],observations=[];
 let exists=true,visits=0;
 const state={active:true,matched:true,optIn:!notEnabled,nasReadOnly:true,recursive,
   root,path,cursor:0,queueId:3,mountBinding:"mount-A"};
 const backend=createExperimentalDelete({
  state:()=>({...state}),
  mountProbe:async()=>notMounted?{allowed:false}:mount,
  stat:async(p)=>{
   events.push("stat");
   if(p===root)return {type:rootChanged?"link":"dir",
     identity:rootInodeChanges&&journal.at(-1)?.state==="UNKNOWN"?"40755|18|24|80|1000":
       rootInodeChangesOnDelete&&!exists?"40755|18|99|80|1000":
       rootMetadataChangesOnDelete&&!exists?"40755|18|23|84|1001":
       rootMetadataChanges&&journal.at(-1)?.state==="UNKNOWN"?"40755|18|23|84|1001":
         "40755|18|23|80|1000"};
   if(p===path){visits++;return {type:symlink?"link":"file",identity:changed&&visits>1?"file-B":"file-A"};}
   return {type:"dir",identity:"parent-A"};
  },
  confirm:async()=>{events.push("confirm");return confirmed;},
  confirmReconcile:async()=>{events.push("confirm-reconcile");return recoveryAccepted;},
  captureCache:async()=>{
    events.push("cache-capture");
    if(cacheCaptureFails)throw Error("CacheCaptureUnavailable");
    return {hashes:["0123456789abcdef0123456789abcdef"]};
  },
  afterCommandSuccess:snapshot=>{
    if(!snapshot)return;
    events.push("cache-enqueue");
    if(cacheCleanupFails)throw Error("CacheCleanupUnavailable");
  },
  journal:{read:()=>lostJournalWrites?null:journal.at(-1)||null,
    write:async j=>{
      events.push("journal:"+j.state);
      if(failSuccessJournalWrite&&j.state==="RM_EXIT_ZERO")
        throw Error("JournalNotSaved");
      journal.push(j);
    }},
  deletePath:async()=>{events.push("delete");if(throwDelete)throw Error("SMB uncertain");exists=false;
    if(playbackUnmatchedAfterDelete)state.matched=false;
    if(cursorChangedAfterDelete)state.cursor=1;},
  exists:async()=>unknown?true:exists,
  verifyMissing:async()=>missingAfterDelete,
  onMissing:async()=>{
    events.push("mark-missing");
    if(missingAdvanceFails)throw Error("CheckpointWriteFailed");
  },
  log:(event,data)=>observations.push({event,data}),
  onDeleted:async()=>{
    events.push("advance");
    if(progressSaveFails)throw Error("ReviewProgressNotPersisted");
  }
 });
 return {backend,events,journal,observations,root,path,
   setPlaying(value){state.matched=value;}};
}
test("normal SMB deletion does not require an experimental opt-in",async()=>{
 const h=harness({notEnabled:true});
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("cache identity is captured before rm and cleanup enqueued only after exit 0",async()=>{
 const h=harness();
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.ok(h.events.indexOf("cache-capture")<h.events.indexOf("delete"));
 assert.ok(h.events.indexOf("cache-enqueue")>h.events.indexOf("delete"));
 assert.equal(h.events.filter(x=>x==="cache-enqueue").length,1);
});
test("cleanup error cannot override successful rm or Review progression",async()=>{
 const h=harness({cacheCleanupFails:true});
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.ok(h.events.includes("advance"));
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
});
test("capture unavailable never blocks confirmed deletion",async()=>{
 const h=harness({cacheCaptureFails:true});
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.equal(h.events.includes("cache-enqueue"),false);
 assert.ok(h.events.includes("advance"));
});
test("failed, uncertain, or cancelled rm never queues thumbnail cleanup",async()=>{
 for(const config of [{throwDelete:true},{confirmed:false},{symlink:true}]){
  const h=harness(config);
  assert.notEqual((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
  assert.equal(h.events.includes("cache-enqueue"),false);
 }
});
test("recursive SMB Review D removes a playing nested video after explicit consent",async()=>{
 const h=harness({recursive:true,nested:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(h.events.filter(x=>x==="confirm").length,1);
 assert.equal(h.events.filter(x=>x==="delete").length,1);
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
});
test("recursive SMB Review D refuses if the video is not currently playing",async()=>{
 const h=harness({recursive:true,nested:true});
 h.setPlaying(false);
 assert.equal((await h.backend.request()).reason,"REVIEW_NOT_READY");
 assert.equal(h.events.includes("confirm"),false);
 assert.equal(h.events.includes("delete"),false);
});
test("experimental delete is cancelled before path deletion",async()=>{
 const h=harness({confirmed:false});
 assert.equal((await h.backend.request()).status,"CANCELLED");
 assert.equal(h.events.includes("delete"),false);
});
test("mount, symlink or file replacement fail closed",async()=>{
 for(const config of [{notMounted:true},{symlink:true},{rootChanged:true},{changed:true}]){
  const h=harness(config);
  assert.notEqual((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
  assert.equal(h.events.includes("delete"),false);
 }
});
test("a confirmed isolated test deletes exactly once after journaling and verifies absence",async()=>{
 const h=harness();
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal((await h.backend.request()).reason,"ALREADY_DELETED");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("successful SMB unlink changes parent directory size/mtime but must still verify deletion",async()=>{
 const h=harness({rootMetadataChangesOnDelete:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("rm exit zero remains successful even if SMB root postcheck identity changes",async()=>{
 const h=harness({rootInodeChangesOnDelete:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("file closes and player unmatches after confirmed deletion: never misclassify as UNKNOWN",async()=>{
 const h=harness({playbackUnmatchedAfterDelete:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("rm exit zero with changed Review cursor reports queue mismatch, not UNKNOWN",async()=>{
 const h=harness({cursorChangedAfterDelete:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(result.nextPlayback,"QUEUE_CHANGED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal(h.events.includes("advance"),false);
});
test("rm exit zero with stale file.exists is successful and records a diagnostic warning",async()=>{
 const h=harness({unknown:true});
 assert.equal((await h.backend.request()).status,"EXPERIMENTAL_DELETED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.ok(h.observations.some(x=>x.event==="review.delete_test.command_completed"));
 assert.equal(JSON.stringify(h.observations).includes(h.path),false);
});
test("failing path delete records backend command stage without speculative success",async()=>{
 const h=harness({throwDelete:true});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 assert.ok(h.observations.some(x=>x.event==="review.delete_test.unknown_stage" &&
   x.data.stage==="backend_command"));
 assert.equal(h.observations.some(x=>x.event==="review.delete_test.verified"),false);
});
test("UNKNOWN target absence can be manually acknowledged as MISSING without retrying delete",async()=>{
 const h=harness({throwDelete:true,missingAfterDelete:true});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 const result=await h.backend.acknowledgeUnknown();
 assert.equal(result.status,"ACKNOWLEDGED");
 assert.equal(result.missingSkipped,true);
 assert.equal(h.journal.at(-1).state,"MANUALLY_RECONCILED");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
 assert.equal(h.events.filter(x=>x==="mark-missing").length,1);
});
test("failed MISSING progress persistence leaves UNKNOWN journal locked",async()=>{
 const h=harness({throwDelete:true,missingAfterDelete:true,missingAdvanceFails:true});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 const result=await h.backend.acknowledgeUnknown();
 assert.equal(result.reason,"MISSING_PROGRESS_UNAVAILABLE");
 assert.equal(h.journal.at(-1).state,"UNKNOWN");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("definite nonzero rm with unchanged video is CONFIRMED_FAILED, not UNKNOWN",async()=>{
 const root="/Volumes/Media/review",path=root+"/sample.mkv";
 const state={active:true,matched:true,nasReadOnly:true,recursive:false,
   root,path,cursor:0,queueId:3,mountBinding:"mount-A"};
 const journal=[];
 const backend=createExperimentalDelete({
   state:()=>({...state}),mountProbe:async()=>mount,
   stat:async p=>p===root?{type:"dir",identity:"40755|18|23|80|1000"}:
     {type:"file",identity:"100644|18|24|900|1000"},
   confirm:async()=>true,exists:async()=>true,
   journal:{read:async()=>journal.at(-1)||null,write:async j=>journal.push(j)},
   deletePath:async()=>{
     const err=new Error("rm failed");err.rmExitCode=1;
     err.rmDetail="Permission denied";throw err;
   },
   onDeleted:async()=>{throw Error("must not advance");}
 });
 const result=await backend.request();
 assert.equal(result.status,"COMMAND_FAILED");
 assert.equal(result.exitCode,1);
 assert.equal(result.detail,"Permission denied");
 assert.equal(journal.at(-1).state,"CONFIRMED_FAILED");
});
test("missing reliable rm exit result becomes UNKNOWN and is never retried",async()=>{
 for(const config of [{throwDelete:true}]){
  const h=harness(config);
  assert.equal((await h.backend.request()).status,"UNKNOWN");
  assert.equal((await h.backend.request()).reason,"UNRESOLVED_OPERATION");
  assert.equal(h.events.filter(x=>x==="delete").length,1);
  assert.equal(h.events.includes("advance"),false);
 }
});
test("rm exit zero with failed Review checkpoint persistence reports progress failure",async()=>{
 const h=harness({progressSaveFails:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(result.nextPlayback,"PROGRESS_SAVE_FAILED");
 assert.equal(h.journal.at(-1).state,"RM_EXIT_ZERO");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
 assert.equal((await h.backend.request()).reason,"ALREADY_DELETED");
});
test("rm exit zero with failed completion journal is not UNKNOWN and leaves recoverable ISSUED",async()=>{
 const h=harness({failSuccessJournalWrite:true,missingAfterDelete:true});
 const result=await h.backend.request();
 assert.equal(result.status,"EXPERIMENTAL_DELETED");
 assert.equal(result.nextPlayback,"JOURNAL_SAVE_FAILED");
 assert.equal(h.journal.at(-1).state,"ISSUED");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
 assert.equal((await h.backend.request()).reason,"UNRESOLVED_OPERATION");
 const reconciled=await h.backend.acknowledgeUnknown();
 assert.equal(reconciled.status,"ACKNOWLEDGED");
 assert.equal(reconciled.missingSkipped,true);
 assert.equal(h.journal.at(-1).state,"MANUALLY_RECONCILED");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
test("ISSUED journal must be readable before invoking any destructive backend",async()=>{
 const h=harness({lostJournalWrites:true});
 const result=await h.backend.request();
 assert.equal(result.status,"REFUSED");
 assert.equal(result.reason,"JOURNAL_UNAVAILABLE");
 assert.equal(h.events.includes("delete"),false);
 assert.equal(h.events.includes("advance"),false);
});
test("UNKNOWN manual reconciliation needs unchanged SMB root and explicit acknowledgement; never deletes",async()=>{
 const h=harness({throwDelete:true});
 assert.equal((await h.backend.request()).reason,"DELETE_INDETERMINATE");
 assert.equal((await h.backend.request()).reason,"UNRESOLVED_OPERATION");
 const result=await h.backend.acknowledgeUnknown();
 assert.equal(result.status,"ACKNOWLEDGED");
 assert.equal(h.journal.at(-1).state,"MANUALLY_RECONCILED");
 assert.equal(h.events.filter(x=>x==="delete").length,1,
   "reconciliation must never retry an ambiguous delete");
});
test("UNKNOWN cannot clear itself when recovery confirmation is declined",async()=>{
 const h=harness({throwDelete:true,recoveryAccepted:false});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 const result=await h.backend.acknowledgeUnknown();
 assert.notEqual(result.status,"ACKNOWLEDGED");
 assert.equal(h.journal.at(-1).state,"UNKNOWN");
});
test("UNKNOWN from prior session can be reconciled when only root directory size or mtime changed",async()=>{
 const h=harness({throwDelete:true,rootMetadataChanges:true});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 const result=await h.backend.acknowledgeUnknown();
 assert.equal(result.status,"ACKNOWLEDGED");
 assert.equal(h.journal.at(-1).state,"MANUALLY_RECONCILED");
 assert.equal(h.events.filter(x=>x==="delete").length,1,
   "reconcile is never a delete retry");
});
test("UNKNOWN reconciliation fails closed if SMB root inode changed",async()=>{
 const h=harness({throwDelete:true,rootInodeChanges:true});
 assert.equal((await h.backend.request()).status,"UNKNOWN");
 const result=await h.backend.acknowledgeUnknown();
 assert.equal(result.reason,"REVIEW_CHANGED");
 assert.equal(h.journal.at(-1).state,"UNKNOWN");
 assert.equal(h.events.filter(x=>x==="delete").length,1);
});
