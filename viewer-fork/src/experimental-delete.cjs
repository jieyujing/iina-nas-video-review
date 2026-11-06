"use strict";
// Guarded, individually confirmed NON-ATOMIC SMB pathname deletion.
// Path-based IINA deletion can race with a concurrent file replacement. This
// must never be advertised as a verified production deletion backend.
function createExperimentalDelete({state,reconcileState=state,mountProbe,stat,confirm,confirmReconcile,journal,deletePath,exists,onDeleted,
  onCommandIssued=()=>{},captureCache=async()=>null,afterCommandSuccess=()=>{},
  verifyMissing=async()=>false,onMissing=async()=>{},log=()=>{}}){
 let busy=false,sequence=0;
 const refused=reason=>({status:"REFUSED",reason});
 const validTarget=(root,path)=>{
   if(typeof root!=="string"||typeof path!=="string"||
      !path.startsWith(root+"/")||path.includes("\u0000"))return false;
   // Recursion is a scan setting, not a deletion prohibition. Validate
   // every component of the one selected video path instead of assuming
   // direct children; never allow path traversal or directory targets.
   const parts=path.slice(root.length+1).split("/");
   return parts.length>0&&parts.every(part=>
     part.length>0 && part!=="." && part!==".." &&
     !part.startsWith(".") && !part.includes("\\") &&
     !/[\u0000-\u001f\u007f]/.test(part));
 };
 const ready=s=>s?.active===true && s?.matched===true &&
   s?.nasReadOnly===true &&
   Number.isInteger(s.cursor) && s.cursor>=0 &&
   typeof s.root==="string" && s.root.startsWith("/Volumes/") &&
   validTarget(s.root,s.path);
 const same=(a,b)=>ready(b) && a.root===b.root && a.path===b.path &&
   a.queueId===b.queueId && a.cursor===b.cursor &&
   a.mountBinding===b.mountBinding &&
   a.queueCursor===b.queueCursor && a.queueRevision===b.queueRevision;
 // Once the delete has been issued, the player may unload the deleted file.
 // This must NOT invalidate an otherwise independently verified deletion.
 // Keep pre-delete checks strict, but use queue identity (not playback
 // matching) to attribute the observed absence after the command returns.
 const sameQueue=(a,b)=>b?.active===true && b?.nasReadOnly===true &&
   a.root===b.root && a.path===b.path && a.queueId===b.queueId &&
   a.cursor===b.cursor && a.mountBinding===b.mountBinding &&
   a.queueCursor===b.queueCursor && a.queueRevision===b.queueRevision;
 const validProof=(s,p)=>p?.allowed===true && p.binding===s.mountBinding &&
   typeof p.mountPoint==="string" &&
   (s.root===p.mountPoint || s.root.startsWith(p.mountPoint+"/"));
 async function inspect(s,proof){
   const root=await stat(s.root);
   const file=await stat(s.path);
   if(!root || root.type!=="dir" || !root.identity ||
      !file || file.type!=="file" || !file.identity)return null;
   return {root:root.identity,file:file.identity,mount:proof.binding};
 }
 const sameEvidence=(a,b)=>a&&b && a.root===b.root &&
   a.file===b.file && a.mount===b.mount;
 // /usr/bin/stat -f %p|%d|%i|%z|%m returns mode, device, inode,
 // size and mtime. A directory's size/mtime legitimately change between
 // sessions; neither participates in stable directory object identity.
 // Compare the stable directory object identity when observing a completed
 // deletion or manually reconciling UNKNOWN. A successful unlink changes
 // parent directory size and mtime, so exact identity comparison here
 // creates a false UNKNOWN even when the video is absent.
 // Never use this weaker comparison for *target-file* delete eligibility.
 const sameRootObject=(oldId,newId)=>{
   if(oldId===newId)return true;
   const parse=value=>{
     if(typeof value!=="string")return null;
     const parts=value.split("|");
     return parts.length===5 && parts.every(x=>/^\d+$/.test(x))?
       parts.slice(0,3):null;
   };
   const old=parse(oldId),next=parse(newId);
   return !!old && !!next && old.every((v,i)=>v===next[i]);
 };
 async function request(){
   if(busy)return refused("OPERATION_IN_PROGRESS");
   busy=true;
   try{
     const current=state();
     if(!ready(current))return refused("REVIEW_NOT_READY");
     let old;
     try{old=await journal.read();}catch(_){return refused("JOURNAL_UNAVAILABLE");}
     if(old && !["DELETED_OBSERVED","RM_EXIT_ZERO","CONFIRMED_FAILED","MANUALLY_RECONCILED",
       "RECOVERED_ABSENT"].includes(old.state))
       return refused("UNRESOLVED_OPERATION");
     if(["DELETED_OBSERVED","RM_EXIT_ZERO"].includes(old?.state) &&
        old.queueId===current.queueId &&
        (old.cursor===current.cursor || old.cursor===current.queueCursor))
       return refused("ALREADY_DELETED");
     let first,proof;
     try{
       proof=await mountProbe(current.root);
       if(!validProof(current,proof))return refused("MOUNT_UNVERIFIED");
       first=await inspect(current,proof);
       if(!first)return refused("FILE_IDENTITY_UNVERIFIED");
     }catch(_){return refused("SOURCE_UNAVAILABLE");}
     let yes=false;
     try{yes=await confirm({name:current.path.slice(current.root.length+1)});}
     catch(_){return refused("CONFIRMATION_UNAVAILABLE");}
     if(yes!==true)return {status:"CANCELLED",reason:"CANCELLED"};
     if(!same(current,state()))return refused("REVIEW_CHANGED");
     // Collect the *verified target's* cache identity before unlink. This
     // changes no media and may fail without vetoing the user's deletion.
     // The subsequent identity re-check still precedes /bin/rm.
     let cacheSnapshot=null;
     try{
       cacheSnapshot=await captureCache({
         path:current.path,fileIdentity:first.file
       });
     }catch(_){log("thumbnail.cleanup.capture_unavailable",{},"warn");}
     try{
       const secondProof=await mountProbe(current.root);
       if(!validProof(current,secondProof))return refused("MOUNT_CHANGED");
       const second=await inspect(current,secondProof);
       if(!sameEvidence(first,second))return refused("FILE_IDENTITY_CHANGED");
     }catch(_){return refused("SOURCE_UNAVAILABLE");}
     const intent={id:"test-delete-"+Date.now()+"-"+(++sequence),state:"INTENT",
       queueId:current.queueId,cursor:current.cursor,
       mountIdentity:first.mount,rootIdentity:first.root,fileIdentity:first.file};
     try{
       await journal.write(intent);
       await journal.write({...intent,state:"ISSUED"});
       // A write/sync API can report success even if the later preference
       // read cannot recover the guard. Never invoke a destructive command
       // without an independently readable ISSUED record for this attempt.
       const persisted=await journal.read();
       if(persisted?.id!==intent.id || persisted?.state!=="ISSUED" ||
          persisted?.queueId!==intent.queueId || persisted?.cursor!==intent.cursor ||
          persisted?.fileIdentity!==intent.fileIdentity ||
          persisted?.mountIdentity!==intent.mountIdentity ||
          persisted?.rootIdentity!==intent.rootIdentity)
         return refused("JOURNAL_UNAVAILABLE");
     }catch(_){return refused("JOURNAL_UNAVAILABLE");}
     let commandError=null;
     try{
       // deletePath returns normally ONLY for a known /bin/rm exit code 0.
       // This is still non-atomic pathname deletion (TOCTOU remains).
       // Start next playback only after the command has truly been dispatched.
       // The queue remains unchanged until the command exits successfully.
       await deletePath(current.path,()=>{
         try{onCommandIssued({path:current.path,cursor:current.cursor});}
         catch(_){log("review.delete.preview_failed",{},"warn");}
       });
     }catch(error){commandError=error;}
     if(commandError){
       // No confirmed zero exit: preserve the old uncertainty contract.
       let knownRmFailure=null;
       if(Number.isInteger(commandError?.rmExitCode) && commandError.rmExitCode!==0){
         knownRmFailure={
           commandFailed:true,exitCode:commandError.rmExitCode,
           detail:commandError.rmDetail||""
         };
         try{
           const after=await mountProbe(current.root);
           if(!validProof(current,after))throw Error("MountChanged");
           const root=await stat(current.root);
           if(root?.type!=="dir"||!sameRootObject(first.root,root.identity))
             throw Error("RootChanged");
           if(await exists(current.path)!==true)throw Error("FileMissing");
           const target=await stat(current.path);
           if(target?.type!=="file"||target.identity!==first.file||
              !sameQueue(current,state()))throw Error("TargetChanged");
           await journal.write({...intent,state:"CONFIRMED_FAILED"});
           log("review.delete.command_failed_confirmed",{
             exitCode:commandError.rmExitCode
           },"warn");
           return {status:"COMMAND_FAILED",reason:"RM_EXIT_NONZERO",
             exitCode:commandError.rmExitCode,detail:commandError.rmDetail||""};
         }catch(_){/* Target did not prove unchanged: retain UNKNOWN. */}
       }
       log("review.delete_test.unknown_stage",{stage:"backend_command"},"warn");
       try{await journal.write({...intent,state:"UNKNOWN"});}catch(_){}
       return {status:"UNKNOWN",reason:"DELETE_INDETERMINATE",
         ...(knownRmFailure||{})};
     }
     // The command's explicit exit 0 is definitive for command success.
     // SMB postchecks may be stale; they are telemetry, never an override.
     log("review.delete_test.command_completed",{status:"exit_zero"});
     // Cleanup is best-effort and queued separately. It must never change a
     // successful rm result, nor hold Review progression for disk cleanup.
     try{
       Promise.resolve(afterCommandSuccess(cacheSnapshot)).catch(()=>
         log("thumbnail.cleanup.enqueue_failed",{},"warn"));
     }catch(_){log("thumbnail.cleanup.enqueue_failed",{},"warn");}
     let stage="mount_postcheck";
     try{
       const after=await mountProbe(current.root);
       if(!validProof(current,after))throw Error("MountPostcheckFailed");
       stage="root_postcheck";
       const root=await stat(current.root);
       if(root?.type!=="dir" || !sameRootObject(first.root,root.identity))
         throw Error("RootPostcheckFailed");
       stage="file_absence_postcheck";
       if(await exists(current.path)!==false &&
          (await verifyMissing(current.path,current))!==true)
         throw Error("FileAbsenceNotConfirmed");
     }catch(_){
       log("review.delete.postcheck_warning",{stage},"warn");
     }
     // Keep command completion in a distinct journal state. Never mislabel
     // an unverified absence as DELETED_OBSERVED or retry rm on failure.
     try{await journal.write({...intent,state:"RM_EXIT_ZERO"});}
     catch(_){
       log("review.delete.progress_warning",{reason:"journal_save_failed"},"error");
       return {status:"EXPERIMENTAL_DELETED",nextPlayback:"JOURNAL_SAVE_FAILED"};
     }
     log("review.delete_test.verified",{status:"rm_exit_zero"});
     if(!sameQueue(current,state()))
       return {status:"EXPERIMENTAL_DELETED",nextPlayback:"QUEUE_CHANGED"};
     try{await onDeleted({path:current.path,cursor:current.cursor});}
     catch(error){
       return {status:"EXPERIMENTAL_DELETED",
         nextPlayback:error?.message==="ReviewProgressNotPersisted"?
           "PROGRESS_SAVE_FAILED":"FAILED"};
     }
     return {status:"EXPERIMENTAL_DELETED",nextPlayback:"NOT_ISSUED"};
   }finally{busy=false;}
 }
 // Explicit operator reconciliation only. Does not delete, advance or
 // establish the previous outcome; retains the old journal for inspection.
 // The next delete still requires new per-item confirmation + fresh evidence.
 async function acknowledgeUnknown(){
   if(busy)return refused("OPERATION_IN_PROGRESS");
   busy=true;
   try{
     // Restore the original pending Review entry instead of the preview player.
     const current=reconcileState();
     if(current?.active!==true ||
        current?.nasReadOnly!==true || typeof current.root!=="string")
       return refused("TEST_MODE_DISABLED");
     let old;
     try{old=await journal.read();}
     catch(_){return refused("JOURNAL_UNAVAILABLE");}
     if(!["UNKNOWN","ISSUED"].includes(old?.state))
       return refused("NO_UNKNOWN_OPERATION");
     try{
       const proof=await mountProbe(current.root);
       if(!validProof(current,proof)||proof.binding!==old.mountIdentity)
         return refused("MOUNT_CHANGED");
       const root=await stat(current.root);
       if(root?.type!=="dir"||!sameRootObject(old.rootIdentity,root.identity))
         return refused("REVIEW_CHANGED");
     }catch(_){return refused("SOURCE_UNAVAILABLE");}
     // A once-issued delete might have removed its target even when the
     // plugin could not verify the postcheck. The old journal has no media
     // filename, so require the SAME saved cursor and fresh absence evidence.
     // This only authorizes a non-destructive MISSING decision, never DELETED.
     let observedMissing=false;
     if(old.cursor===current.cursor){
       try{observedMissing=(await verifyMissing(current.path,current))===true;}
       catch(_){observedMissing=false;}
     }
     let consent=false;
     try{consent=(await confirmReconcile({missing:observedMissing}))===true;}
     catch(_){return refused("CONFIRMATION_UNAVAILABLE");}
     if(!consent)return {status:"CANCELLED",reason:"CANCELLED"};
     if(observedMissing){
       try{
         const again=await mountProbe(current.root);
         if(!validProof(current,again)||again.binding!==old.mountIdentity)
           return refused("MOUNT_CHANGED");
         const root=await stat(current.root);
         if(root?.type!=="dir"||!sameRootObject(old.rootIdentity,root.identity))
           return refused("REVIEW_CHANGED");
         if(!sameQueue(current,reconcileState()) ||
            (await verifyMissing(current.path,current))!==true)
           return refused("MISSING_VERIFICATION_CHANGED");
         // Persist progress BEFORE releasing the old journal lock. If the
         // progress write fails, retain UNKNOWN and do not proceed.
         await onMissing({path:current.path,cursor:current.cursor});
       }catch(_){return refused("MISSING_PROGRESS_UNAVAILABLE");}
     }
     // Manual acknowledgement does not mean the old file was or was not
     // removed. It only allows a *new*, independently confirmed request.
     try{
       await journal.write({...old,state:"MANUALLY_RECONCILED"});
       const saved=await journal.read();
       if(saved?.id!==old.id || saved?.state!=="MANUALLY_RECONCILED")
         return refused("JOURNAL_UNAVAILABLE");
     }catch(_){return refused("JOURNAL_UNAVAILABLE");}
     return {status:"ACKNOWLEDGED",reason:"MANUAL_RECONCILIATION",
       missingSkipped:observedMissing};
   }finally{busy=false;}
 }
 return {request,acknowledgeUnknown};
}
module.exports={createExperimentalDelete};
