const {
  sidebar,
  event,
  console,
  core,
  file,
  utils,
  input,
  menu,
  mpv,
  preferences,
  overlay
} = iina;
import VIDEO_EXTENSIONS from 'video-extensions';
import Path from "path-browserify"
const Review = require("./review-core.cjs");
const Session = require("./review-session.cjs");
const SMBCheckpoint=require("./smb-review-checkpoint.cjs");
const Sidecar=require("./nas-review-sidecar.cjs");
const {createDirectoryIO}=require("./nas-sidecar-file.cjs");
const Nas = require("./nas-source.cjs");
const Scan = require("./review-scan.cjs");
const {createDeleteCoordinator}=require("./delete-coordinator.cjs");
const {createExperimentalDelete}=require("./experimental-delete.cjs");
const {createDurableVideoDeleteQueue}=require("./video-delete-queue.cjs");
const {createDirectoryDelete}=require("./directory-delete.cjs");
const {createThumbnailOverlay}=require("./thumbnail-overlay.cjs");
const {createThumbnailGenerator}=require("./thumbnail-generator.cjs");
const {createCacheCleanupQueue}=require("./cache-cleanup-queue.cjs");
const {createDebugLogger}=require("./debug-log.cjs");

const FILENAME_BLACKLIST = ['.DS_Store', '.localized'];
let reviewQueue = null;
// An expected URL is not proof that IINA finished loading that video. Every
// plugin-initiated open must be followed by the matching iina.file-loaded
// event before KEEP can advance a new queue item.
let reviewAwaitingLoad=false;
// The loaded-media event, not URL mutation alone, proves that IINA completed
// a load. Used only for non-destructive K resynchronization of queue entries.
let reviewLastLoadedPath="";
let reviewTextInputFocused = false;
let reviewKShortcutEnabled = false;
let reviewKRegistration = "Not initialized";
let reviewKInputEvents = 0;
let reviewLastKResult = "No K key received";
let reviewKMenuItem=null;
let reviewDMenuItem=null;
let reviewSessionEpoch=0;
let sidebarFullscreenEpoch=0;
let reviewLastEOFToken="";
// Monotonic ordering for playback observations. Date.now() ties for two
// events in the same millisecond (a drag seek and the EOF probe), which made
// a valid completion look like "the user seeked after the evidence".
let reviewObservationSeq=0;
// Set when playback deliberately leaves the terminal region. A later "the file
// ended right after a seek" inference must not override that retreat.
let reviewRetreatedToken="";
let reviewProgressPrevious=null;
// Proof that THIS loaded item reached its terminal tail while playing. IINA
// publishes the final time-pos sample with pause/zero position while it
// unloads the finished media, which erases any "last sample" witness. A
// recorded terminal observation therefore must survive those resets.
let reviewTerminal=null;
// A native mpv seek can jump to exact EOF without delivering a final
// time-pos sample. Bind that seek to the loaded Review item only.
let reviewSeekIntent=null;
let reviewFileLoadedBaseline=null;
const CHECKPOINT_KEY="nasReviewCheckpointV1";
const SMB_CHECKPOINT_KEY="nasSMBReviewCheckpointV1";
const NAS_BACKUP_WRITER_KEY="nasReviewDirectoryBackupWriterV1";
const NAS_BACKUP_PAUSED_ROOTS_KEY="nasReviewDirectoryBackupPausedRootsV1";
const SMB_RECOVERY_BACKUP_KEY="nasSMBReviewRecoveryBackupV1";
const UNKNOWN_RECOVERY_BACKUP_KEY="nasDeleteUnknownRecoveryBackupV1";
const DELETE_JOURNAL_KEY="nasDeleteJournalV1";
const TEST_DELETE_JOURNAL_KEY="nasExperimentalDeleteJournalV1";
const DIRECTORY_DELETE_JOURNAL_KEY="nasDirectoryDeleteJournalV1";
let directoryModeRoot="";
let directoryModeBinding="";
let directoryModeEpoch=0;
const SKIP_DELETE_CONFIRM_KEY="nasReviewSkipDeleteConfirmationV1";
let skipDeleteConfirmationEnabled=false;
try{skipDeleteConfirmationEnabled=preferences?.get(SKIP_DELETE_CONFIRM_KEY)==="true";}
catch(_){/* Fail closed: keep the confirmation enabled. */}
function setSkipDeleteConfirmation(enabled){
  if(typeof enabled!=="boolean" || !preferences ||
     typeof preferences.set!=="function" || typeof preferences.sync!=="function")return false;
  const previous=skipDeleteConfirmationEnabled;
  try{
    preferences.set(SKIP_DELETE_CONFIRM_KEY,enabled?"true":"false");
    preferences.sync();
    skipDeleteConfirmationEnabled=enabled;
  }catch(_){
    try{
      preferences.set(SKIP_DELETE_CONFIRM_KEY,previous?"true":"false");
      preferences.sync();
    }catch(__){}
    debugLog.log("review.delete.setting_failed",{},"warn");
    reportReview();
    return false;
  }
  reportReview();
  return true;
}
const REVIEW_WINDOW_SIZE=120;
// Keep the established journal key so UNKNOWN transactions survive upgrades.
const deleteProcessNonce=String(Date.now())+"-"+Math.random().toString(36).slice(2);
let checkpointRecord=null;
let checkpointRevision=0;
let smbCheckpointRecord=null;
let smbCheckpointRevision=0;
let nasBackupStatus="disabled";
let nasBackupTail=Promise.resolve();
let reviewResumePending=false;
let nasProbePending=false;
let nasProbeRevision=0;
// Snapshot the actual playing Review item only for the duration of an
// explicitly requested D transaction. A successful rm can unload its player.
let activeDeleteRequest=null;
// Transient preview, never a persisted deletion decision. An issued SMB rm
// may be slow; the next item can load before the old transaction resolves.
let deletePreview=null;
const VIDEO_DELETE_QUEUE_KEY="nasSMBVideoDeleteQueueV1";
let videoDeleteQueue=null;
let deleteQueueNotice="";
// Only a verified atomic identity-conditional SMB backend may replace this.
// Explicitly NOT iina.file.delete(path), iina.file.trash(path) or unlinkat.
const deleteBackend=Object.freeze({capability:"UNSUPPORTED"});
const debugLog=createDebugLogger({
  sink:entry=>{
    // Also leave minimal, redacted bootstrap/error evidence in IINA Log Viewer
    // when the sidebar WebView cannot load. Never print media paths.
    if(entry.level!=="info" || entry.event.startsWith("plugin.") ||
       entry.event==="input.k.received"){
      try{console.log("[NAS Review debug] "+JSON.stringify(entry));}catch(_){}
    }
    try{sidebar.postMessage("debug-event",entry);}catch(_){}
  }
});
debugLog.log("plugin.entry");
// Automatic KEEP depends on these observers; a captured log must show which
// mpv capability this IINA build actually exposes.
debugLog.log("plugin.mpv_api",{
  enabled:typeof mpv?.getFlag==="function" ||
    typeof mpv?.getNumber==="function",
  reason:typeof mpv?.getNumber==="function"?"position_probe_available":
    typeof mpv?.getFlag==="function"?"flag_only":"unavailable"
});

const previewGenerator=createThumbnailGenerator({
  utils,file,log:(event,data,level)=>debugLog.log(event,data,level)
});
const cacheCleanupQueue=createCacheCleanupQueue({
  preferences,run:snapshot=>previewGenerator.queueCleanup(snapshot),
  log:(event,data,level)=>debugLog.log(event,data,level)
});
const thumbnails=createThumbnailOverlay({
  overlay,core,file,utils,input,preferences,
  generatePreviewFrames:previewGenerator.generate,
  getCurrentPath:()=>{
    if(!reviewQueue?.active || reviewTextInputFocused ||
       !isCurrentReviewPlayback())return null;
    return Review.current(reviewQueue)?.path||null;
  },
  log:(event,data,level)=>debugLog.log(event,data,level)
});

function readCheckpoint(){
  try{
    const raw=preferences?.get(CHECKPOINT_KEY);
    const parsed=Session.parse(raw);
    if(raw && !parsed)debugLog.log("review.checkpoint.invalid",{},"warn");
    checkpointRecord=parsed;
    checkpointRevision=parsed?.revision||0;
    debugLog.log("review.checkpoint.loaded",{active:Session.hasPending(parsed)});
  }catch(error){
    checkpointRecord=null;
    debugLog.log("review.checkpoint.read_failed",{errorName:error?.name||"Error"},"error");
  }
}
function hasPendingCheckpoint(){
  return Session.hasPending(checkpointRecord)||
    SMBCheckpoint.hasPending(smbCheckpointRecord);
}
function readSMBCheckpoint(){
  try{
    const raw=preferences?.get(SMB_CHECKPOINT_KEY);
    smbCheckpointRecord=SMBCheckpoint.parse(raw);
    smbCheckpointRevision=smbCheckpointRecord?.revision||0;
    if(raw&&!smbCheckpointRecord)
      debugLog.log("nas.review.checkpoint.invalid",{},"warn");
    debugLog.log("nas.review.checkpoint.loaded",{
      active:SMBCheckpoint.hasPending(smbCheckpointRecord)
    });
  }catch(_){
    smbCheckpointRecord=null;
    debugLog.log("nas.review.checkpoint.read_failed",{},"warn");
  }
}
// SMB backup is on by default for every verified Review root. An explicit
// pause is scoped to that directory and survives IINA restarts. Invalid
// preferences fail closed rather than silently resuming network writes.
function pausedNASBackupRoots(){
 try{
   const raw=preferences?.get(NAS_BACKUP_PAUSED_ROOTS_KEY);
   if(raw===null || raw===undefined || raw==="")return [];
   if(typeof raw!=="string" || raw.length>16384)return null;
   const parsed=JSON.parse(raw);
   if(!Array.isArray(parsed)||parsed.length>128 ||
      parsed.some(x=>Nas.normalize(x)!==x) ||
      new Set(parsed).size!==parsed.length)return null;
   return parsed;
 }catch(_){return null;}
}
function nasBackupEnabled(){
 const root=smbCheckpointRecord?.root;
 const paused=pausedNASBackupRoots();
 return !!root && Nas.normalize(root)===root &&
   paused!==null && !paused.includes(root);
}
function nasBackupWriter(){
 let previous;
 let changed=false;
 try{
   if(!preferences||typeof preferences.get!=="function"||
      typeof preferences.set!=="function"||
      typeof preferences.sync!=="function")return null;
   previous=preferences.get(NAS_BACKUP_WRITER_KEY);
   if(typeof previous==="string" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(previous))return previous;
   const writer="mac-"+Date.now().toString(36)+"-"+
     Math.random().toString(36).slice(2,14);
   preferences.set(NAS_BACKUP_WRITER_KEY,writer);
   changed=true;
   preferences.sync();
   return writer;
 }catch(_){
   if(changed)try{
     preferences.set(NAS_BACKUP_WRITER_KEY,previous);
     preferences.sync();
   }catch(_){debugLog.log("nas.sidecar.writer_rollback_uncertain",{},"warn");}
   return null;
 }
}
function scheduleNASBackup(){
 if(!nasBackupEnabled() || !smbCheckpointRecord)return;
 const record=smbCheckpointRecord;
 // Support the real IINA APIs, but do not change a mock/local fixture's
 // preferences if it has no NAS file-write capability.
 if(typeof file?.write!=="function"||
    typeof file?.read!=="function"||
    typeof file?.exists!=="function"){
   nasBackupStatus="pending";return;
 }
 const writer=nasBackupWriter();
 if(!writer){
   nasBackupStatus="pending";return;
 }
 nasBackupStatus="pending";
 const task=nasBackupTail.then(async()=>{
   if(!nasBackupEnabled() || smbCheckpointRecord?.root!==record.root){
     if(!nasBackupEnabled())nasBackupStatus="disabled";
     return;
   }
   try{
     const proof=await testMountProbe(record.root);
     if(!proof.allowed||proof.binding!==record.mountBinding)
       throw Error("sidecar_mount_unavailable");
     const identity=await verifiedSMBRootIdentity(record.root,proof);
     if(!SMBCheckpoint.sameRootAfterRemount(record.rootIdentity,identity))
       throw Error("sidecar_root_changed");
     if(!nasBackupEnabled() || smbCheckpointRecord?.root!==record.root)return;
     const io=createDirectoryIO({root:record.root,proof,utils,file});
     const mirror=Sidecar.createMirror({
       load:io.load,save:io.save,
       log:(event,data,level)=>debugLog.log(event,data,level)
     });
     const result=await mirror.publish(record,proof,writer);
     nasBackupStatus=nasBackupEnabled()?result.status:"disabled";
     debugLog.log("nas.sidecar.sync",{status:result.status},
       result.status==="synced"?"info":"warn");
   }catch(_){
     nasBackupStatus="pending";
     debugLog.log("nas.sidecar.pending_retry",{},"warn");
   }
   // A queued network backup can finish after Resume reports a safety
   // rejection. Updating only backup status must not clear that Review error.
   sidebar.postMessage("nas-backup-status",{
     root:record.root,status:nasBackupStatus,
     enabled:nasBackupEnabled()
   });
 });
 nasBackupTail=task.catch(()=>{});
}
function setNASBackupEnabled(data){
 const enabled=data?.enabled===true;
 const root=smbCheckpointRecord?.root;
 if(!root || Nas.normalize(root)!==root){
   reportReview("Start or resume an SMB Review before changing its directory backup.");
   return;
 }
 let oldPaused;
 let staged=false;
 try{
   if(!preferences||typeof preferences.set!=="function"||
      typeof preferences.sync!=="function")throw Error("StorageUnavailable");
   const roots=pausedNASBackupRoots();
   if(!roots)throw Error("InvalidBackupPreferences");
   oldPaused=preferences.get(NAS_BACKUP_PAUSED_ROOTS_KEY);
   const next=enabled?roots.filter(x=>x!==root):
     roots.includes(root)?roots:[...roots,root];
   if(next.length>128)throw Error("TooManyPausedBackupRoots");
   staged=true;
   preferences.set(NAS_BACKUP_PAUSED_ROOTS_KEY,JSON.stringify(next));
   preferences.sync();
   nasBackupStatus=enabled?"pending":"disabled";
   if(enabled)scheduleNASBackup();
   debugLog.log("nas.sidecar.configured",{enabled});
   reportReview();
 }catch(_){
   if(staged)try{
     preferences.set(NAS_BACKUP_PAUSED_ROOTS_KEY,oldPaused);
     preferences.sync();
   }catch(_){debugLog.log("nas.sidecar.preference_rollback_uncertain",{},"warn");}
   nasBackupStatus="pending";
   reportReview("Could not save NAS backup preference. No media files were changed.");
 }
}
async function importNASBackup(data){
 if(reviewQueue?.active || hasPendingCheckpoint() || reviewResumePending){
   reportReview("NAS import blocked: an existing local Review checkpoint takes priority.");
   return;
 }
 const root=Nas.normalize(data?.path);
 if(!root){reportReview("Select a Finder-mounted SMB Review folder first.");return;}
 // A malformed/expired local record may still contain recoverable data.
 // Never overwrite its raw bytes with an imported NAS snapshot.
 try{
   if(preferences?.get(SMB_CHECKPOINT_KEY)){
     reportReview("NAS import blocked: existing local checkpoint data must be backed up before replacement.");
     return;
   }
 }catch(_){reportReview("Cannot verify local checkpoint storage.");return;}
 reviewResumePending=true;
 try{
   const proof=await testMountProbe(root);
   if(!proof.allowed)throw Error("NAS_IMPORT_NOT_MOUNTED");
   const identity=await verifiedSMBRootIdentity(root,proof);
   const io=createDirectoryIO({root,proof,utils,file});
   const portable=Sidecar.parse(await io.load());
   if(!portable)throw Error("NAS_IMPORT_NO_VALID_SNAPSHOT");
   const rel=root.slice(proof.mountPoint.length);
   if(portable.sourceId!==proof.portableBinding ||
      portable.relativeRoot!==(rel.startsWith("/")?rel.slice(1):rel) ||
      portable.cursor<0)throw Error("NAS_IMPORT_SOURCE_MISMATCH");
   const rows=portable.entries.map(row=>({
     filename:row.path,path:root+"/"+row.path,isDir:false
   }));
   const candidate=Review.createQueue(root,rows,{
     nasReadOnly:true,recursive:portable.recursive
   });
   const byName=new Map(portable.entries.map(row=>[row.path,row]));
   for(const row of candidate.entries)row.status=byName.get(row.name).status;
   const cursorName=portable.entries[portable.cursor].path;
   candidate.cursor=candidate.entries.findIndex(row=>row.name===cursorName);
   candidate.active=candidate.cursor>=0;
   candidate.nasBinding=proof.binding;
   candidate.nasRootIdentity=identity;
   const local=SMBCheckpoint.parse(SMBCheckpoint.encode(candidate,1));
   if(!local)throw Error("NAS_IMPORT_SNAPSHOT_INVALID");
   const listed=portable.recursive?
     await Scan.scanAsync(root,dir=>file.list(dir),{
       recursive:true,maxFiles:20000,maxDirectories:5000,maxDepth:24
     }):Scan.scan(root,dir=>file.list(dir));
   const recovered=SMBCheckpoint.reconcile(local,{
     root,mountBinding:proof.binding,rootIdentity:identity,listed
   });
   if(hasPendingCheckpoint()||reviewQueue?.active)
     throw Error("NAS_IMPORT_LOCAL_CHANGED");
   // Continue the imported snapshot's revision rather than silently treating
   // a different revision-1 state as already mirrored.
   const previousRevision=smbCheckpointRevision;
   smbCheckpointRevision=Math.max(smbCheckpointRevision,portable.localRevision);
   if(!persistQueue(recovered)){
     smbCheckpointRevision=previousRevision;
     throw Error("NAS_IMPORT_LOCAL_WRITE_FAILED");
   }
   reviewQueue=recovered;
   reviewSessionEpoch++;
   reviewTextInputFocused=false;
   debugLog.log("nas.sidecar.imported",{
     kept:recovered.entries.filter(x=>x.status==="KEEP").length,
     cursor:recovered.cursor
   });
   reportReview();
 }catch(error){
   const reason=String(error?.message||"");
   debugLog.log("nas.sidecar.import_refused",{
     reason:/^NAS_IMPORT_/.test(reason)?reason:"snapshot_unverified"
   },"warn");
   reportReview("NAS backup import blocked: the saved source, inventory or backup could not be verified. Local progress was not overwritten.");
 }finally{reviewResumePending=false;}
}
function persistQueue(queue){
  const smb=queue?.nasReadOnly===true;
  const key=smb?SMB_CHECKPOINT_KEY:CHECKPOINT_KEY;
  let previous=null;
  let staged=false;
  try{
    const encoded=smb?
      SMBCheckpoint.encode(queue,smbCheckpointRevision+1):
      Session.encode(queue,checkpointRevision+1);
    if(!preferences||typeof preferences.set!=="function" ||
       typeof preferences.sync!=="function")throw new Error("StorageUnavailable");
    previous=preferences.get(key)||"";
    preferences.set(key,encoded);
    staged=true;
    preferences.sync();
    if(smb){
      smbCheckpointRecord=SMBCheckpoint.parse(encoded);
      smbCheckpointRevision++;
    }else{
      checkpointRecord=Session.parse(encoded);
      checkpointRevision++;
    }
    debugLog.log("review.checkpoint.saved",{
      cursor:queue.cursor,kept:queue.entries.filter(x=>x.status==="KEEP").length
    });
    // Never await SMB I/O on the KEEP/D path. Local persistence remains
    // authoritative and succeeds independently of network availability.
    if(smb)scheduleNASBackup();
    return true;
  }catch(error){
    if(staged){
      // The failed sync may have modified IINA's in-memory preferences even
      // if disk persistence failed; best-effort restore the previous record.
      try{
        preferences.set(key,previous);
        preferences.sync();
      }catch(_){debugLog.log("review.checkpoint.rollback_uncertain",{},"warn");}
    }
    debugLog.log("review.checkpoint.write_failed",{errorName:error?.name||"Error"},"error");
    return false;
  }
}
readCheckpoint();
readSMBCheckpoint();

function reviewPhase(error,queue){
  if(error)return "ERROR";
  if(queue?.active)return "ACTIVE";
  if(queue?.entries?.length && queue.cursor===-1 &&
     queue.entries.every(x=>["KEEP","DELETED","MISSING"].includes(x.status)))return "COMPLETE";
  return "IDLE";
}

function reportReview(error = "") {
  syncNativeKMenu();
  syncNativeDMenu();
  // The previous UNKNOWN remains durable across plugin reloads. Surface its
  // existence so the user sees the recovery action instead of retrying D.
  let deleteRecoveryPending=false,legacyDeleteJournal=null;
  try{
    const raw=preferences?.get(TEST_DELETE_JOURNAL_KEY);
    legacyDeleteJournal=raw?JSON.parse(raw):null;
    deleteRecoveryPending=["UNKNOWN","ISSUED"].includes(legacyDeleteJournal?.state);
  }catch(_){/* Do not expose malformed storage records in the sidebar. */}
  const queue=reviewQueue;
  const identity=inspectReviewPlayback();
  const totalCount=queue?.entries?.length||0;
  // Presentation only: point the sidebar at the media IINA is displaying,
  // even when it differs from the pending Review cursor (e.g. replayed KEEP).
  // This does not change the queue cursor, KEEP or delete authorization.
  const displayedPath=currentPlayerPath();
  const playingPosition=displayedPath &&
    displayedPath===reviewLastLoadedPath && !reviewAwaitingLoad &&
    queue?.entries?.length?
    queue.entries.findIndex(entry=>entry.path===displayedPath):-1;
  const keptCount=queue?.entries?.filter(e=>e.status==="KEEP").length||0;
  const deletedCount=queue?.entries?.filter(e=>e.status==="DELETED").length||0;
  const missingCount=queue?.entries?.filter(e=>e.status==="MISSING").length||0;
  const queued=videoDeleteQueue?.pendingIndices(queue?.root)||new Set();
  // The deletion queue is global, not scoped to the currently displayed
  // folder. Never claim it is safe to quit while another source has work.
  const deleteSnapshot=videoDeleteQueue?.snapshot();
  const jobs=deleteSnapshot?.jobs||[];
  // The old one-slot journal is ISSUED during a healthy active worker.
  // It is not a separate UNKNOWN that should block a second D or cause
  // the UI to report recovery required while /bin/rm is still running.
  if(deleteRecoveryPending && legacyDeleteJournal?.state==="ISSUED" &&
     jobs.some(job=>job.status==="RUNNING" &&
       job.id===legacyDeleteJournal.queueId))
    deleteRecoveryPending=false;
  const deleteQueueBlocked=videoDeleteQueue?.blocked()===true;
  const countStatus=status=>jobs.filter(job=>job.status===status).length;
  const deleteQueueRunning=countStatus("RUNNING");
  const deleteQueueWaiting=countStatus("QUEUED");
  const deleteQueuePausedCount=countStatus("PAUSED");
  const deleteQueueUnknown=countStatus("UNKNOWN");
  const deleteQueueDeleted=countStatus("DELETED");
  const deleteQueueFailed=countStatus("FAILED");
  const deleteQueueReconciled=countStatus("RECONCILED");
  const deleteQueueCancelled=countStatus("CANCELLED");
  const deleteQueueNeedsReview=deleteQueueFailed+
    deleteQueueReconciled+deleteQueueCancelled;
  const deleteQueueStatus=deleteQueueBlocked || deleteRecoveryPending ||
    deleteQueueUnknown>0?"BLOCKED":
    deleteQueueRunning>0 || deleteQueueWaiting>0 ||
    deleteSnapshot?.processing===true?"WORKING":
    deleteQueuePausedCount>0?"PAUSED":
    jobs.length===0?"IDLE":
    deleteQueueNeedsReview>0?"COMPLETE_WITH_WARNINGS":"COMPLETE";
  const deleteQueueCanClose=["COMPLETE","COMPLETE_WITH_WARNINGS"]
    .includes(deleteQueueStatus);
  const loadedForDelete=playingReviewDeleteTarget();
  // Display an accurate current inventory without removing snapshot entries.
  // Keep totalCount as the stable index space for paging and checkpoints.
  const remainingCount=Math.max(0,totalCount-deletedCount-missingCount);
  // A full NAS queue may contain many thousands of files. Center the window
  // on IINA's actual video, falling back to the pending Review cursor; never
  // send all 20k filenames or mutate the queue just to scroll the UI.
  const windowSize=queue?.nasReadOnly===true?REVIEW_WINDOW_SIZE:totalCount;
  const windowAnchor=playingPosition>=0?playingPosition:Math.max(0,queue?.cursor??0);
  const windowStart=totalCount>windowSize?
    Math.max(0,Math.min(windowAnchor-Math.floor(windowSize/2),
      totalCount-windowSize)):0;
  sidebar.postMessage("review-state", {
    phase:reviewPhase(error,queue),
    playbackMatched:identity.matched && !reviewAwaitingLoad,
    deletePlaybackReady:!deleteQueueBlocked && !!loadedForDelete &&
      !queued.has(loadedForDelete.index),
    playbackStatus:reviewAwaitingLoad && identity.matched?
      "awaiting_file_loaded":identity.reason,
    root:queue?.root || "",
    sessionEpoch:reviewSessionEpoch,
    viewRevision:queue?.nasReadOnly===true?
      smbCheckpointRevision:checkpointRevision,
    cursor:queue?.cursor ?? -1,
    playingPosition,
    active:!!queue?.active,
    nasReadOnly:queue?.nasReadOnly===true,
    recursive:queue?.recursive===true,
    deletionSupported:queue?.active===true && queue?.nasReadOnly===true,
    deleteRecoveryPending:deleteRecoveryPending ||
      jobs.some(job=>job.status==="UNKNOWN"),
    deleteQueueBlocked,deleteQueuePending:queued.size,
    deleteQueueStatus,deleteQueueCanClose,
    deleteQueueRunning,deleteQueueWaiting,
    deleteQueueUnknown,deleteQueueDeleted,deleteQueueFailed,
    deleteQueueReconciled,deleteQueueCancelled,
    deleteQueueNotice:deleteQueueNotice || (deleteQueueBlocked?
      "One or more deletions require manual verification. Pending jobs will not retry automatically.":""),
    deleteQueuePaused:deleteQueuePausedCount,
    deleteInFlight:deleteSnapshot?.processing===true,
    skipDeleteConfirmation:skipDeleteConfirmationEnabled,
    totalCount,remainingCount,keptCount,deletedCount,missingCount,windowStart,
    entries:queue?.entries?.slice(windowStart,windowStart+windowSize)
      .map(({name,status},i)=>{
        const index=windowStart+i;
        const job=jobs.find(task=>task.root===queue.root && task.index===index &&
          ["QUEUED","RUNNING","PAUSED","UNKNOWN"].includes(task.status));
        return {name,status:job?job.status:status,position:index};
      }) || [],
    kShortcutEnabled:reviewKShortcutEnabled,
    kRegistration:reviewKRegistration,
    kInputEvents:reviewKInputEvents,
    lastKResult:reviewLastKResult,
    resumeAvailable:hasPendingCheckpoint(),
    nasBackupEnabled:nasBackupEnabled(),
    nasBackupStatus,
    resumeTotal:(smbCheckpointRecord&&SMBCheckpoint.hasPending(smbCheckpointRecord)?
      smbCheckpointRecord:checkpointRecord)?.entries?.length||0,
    resumeKept:(smbCheckpointRecord&&SMBCheckpoint.hasPending(smbCheckpointRecord)?
      smbCheckpointRecord:checkpointRecord)?.entries?.filter(x=>x.status==="KEEP").length||0,
    resumeKind:SMBCheckpoint.hasPending(smbCheckpointRecord)?"smb":"local",
    // Only a validated, disposable local fixture root is disclosed to the
    // local sidebar. This is UI selection context, NOT file identity proof.
    resumeSource:SMBCheckpoint.hasPending(smbCheckpointRecord)?
      smbCheckpointRecord.root:
      Session.hasPending(checkpointRecord)?checkpointRecord.root:"",
    error
  });
}
function currentPlayerPath(){
  const raw=core.status?.url;
  if(typeof raw!=="string" || !raw)return null;
  let path=raw;
  if(path.startsWith("file://")){
    path=path.slice(7);
    if(path.startsWith("localhost/"))path=path.slice("localhost".length);
    else if(!path.startsWith("/"))return null;
  }else if(!path.startsWith("/"))return null;
  try{path=decodeURIComponent(path);}catch(_){return null;}
  // /tmp is a macOS symlink to /private/tmp. Only map that one explicit,
  // disposable-fixture prefix; never resolve arbitrary symlinks or NAS paths.
  if(path.startsWith("/tmp/iina-nas-review-fixture-"))
    path="/private"+path;
  return path;
}
function inspectReviewPlayback(){
  const item=reviewQueue&&Review.current(reviewQueue);
  if(!item)return {matched:false,reason:"session_inactive"};
  const path=currentPlayerPath();
  if(!path)return {matched:false,reason:"missing_url"};
  if(path===item.path)return {matched:true,
    reason:/^(?:file:\/\/)?\/tmp\/iina-nas-review-fixture-/.test(core.status?.url||"")?"tmp_alias":"exact"};
  if(path.startsWith(reviewQueue.root+"/"))
    return {matched:false,reason:"different_review_item"};
  if(path.startsWith("/private/tmp/iina-nas-review-fixture-"))
    return {matched:false,reason:"other_local_fixture"};
  return {matched:false,reason:"other_media"};
}
function isCurrentReviewPlayback(){
  return !reviewAwaitingLoad && inspectReviewPlayback().matched;
}
function playingReviewDeleteTarget(){
  if(!reviewQueue?.active || reviewQueue.nasReadOnly!==true ||
     reviewTextInputFocused)return null;
  const path=currentPlayerPath();
  // Never delete a stale URL while IINA is opening a different video.
  if(!path || path!==reviewLastLoadedPath)return null;
  const index=reviewQueue.entries.findIndex(entry=>entry.path===path &&
    (entry.status==="PENDING"||entry.status==="KEEP"));
  return index>=0?{path,index}:null;
}
function syncKToLoadedPendingVideo(){
  if(!reviewQueue?.active || reviewAwaitingLoad)return false;
  const path=currentPlayerPath();
  if(!path || path!==reviewLastLoadedPath ||
     !path.startsWith(reviewQueue.root+"/"))return false;
  const index=reviewQueue.entries.findIndex(x=>x.path===path && x.status==="PENDING");
  if(index<0 || queuedDeleteIndices().has(index))return false;
  const next={...reviewQueue,entries:reviewQueue.entries.map(x=>({...x}))};
  if(!Review.select(next,index) || !persistQueue(next))return false;
  reviewQueue=next;
  thumbnails.close();
  reviewProgressPrevious=null;
  reviewTerminal=null;
  reviewRetreatedToken="";
  reviewSeekIntent=null;
  reviewFileLoadedBaseline=null;
  debugLog.log("review.k.synced_to_loaded_pending",{cursor:index});
  return true;
}
function showPluginSidebar(){
  try{
    if(typeof sidebar?.show==="function"){
      sidebar.show();
      debugLog.log("plugin.sidebar.show_requested");
    }
  }catch(error){
    debugLog.log("plugin.sidebar.show_failed",{
      errorName:error?.name||"Error"
    },"warn");
  }
}
function openNextWhenDeleteIssued({path,cursor}={}){
  const item=reviewQueue?.entries?.[cursor];
  if(!activeDeleteRequest || !item || item.path!==path ||
     (item.status!=="PENDING"&&item.status!=="KEEP"))return;
  // This is an in-memory preview ONLY, never a DELETED checkpoint.
  const hypothetical={...reviewQueue,
    entries:reviewQueue.entries.map(entry=>({...entry}))};
  let next;
  if(cursor===hypothetical.cursor && item.status==="PENDING"){
    ({current:next}=Review.advance(hypothetical,"DELETED"));
  }else{
    hypothetical.entries[cursor].status="DELETED";
    next=Review.current(hypothetical);
  }
  if(!next || next.path===path)return;
  try{
    deletePreview={path:next.path,epoch:reviewSessionEpoch};
    debugLog.log("review.delete.next_dispatched",{index:hypothetical.cursor});
    core.open(next.path);
    reportReview("Deletion is running in the background. Review decisions are locked until it finishes.");
  }catch(_){
    deletePreview=null;
    debugLog.log("review.delete.early_playback_failed",{},"warn");
  }
}
// Find a Review item which is neither completed nor waiting for SMB deletion.
// The original snapshot indices never change; do not feed QUEUED items to K/D.
function nextAvailableReviewIndex(queue,after,excluding=new Set()){
  if(!queue?.entries?.length)return -1;
  for(let offset=1;offset<=queue.entries.length;offset++){
    const index=(after+offset)%queue.entries.length;
    if(queue.entries[index].status==="PENDING" && !excluding.has(index))
      return index;
  }
  return -1;
}
function queuedDeleteIndices(){
  return videoDeleteQueue?.pendingIndices(reviewQueue?.root)||new Set();
}
// Checkpoint codecs require the cursor to reference a PENDING entry, even
// if all remaining pending entries are already reserved by background D.
function checkpointCursor(queue,after){
  const available=nextAvailableReviewIndex(queue,after,queuedDeleteIndices());
  if(available>=0)return available;
  for(let n=1;n<=queue.entries.length;n++){
    const index=(after+n)%queue.entries.length;
    if(queue.entries[index].status==="PENDING")return index;
  }
  return -1;
}
function acceptQueuedVideoDelete(job){
  if(!reviewQueue?.active || reviewQueue?.root!==job.root ||
     reviewQueue?.entries?.[job.index]?.path!==job.path)return false;
  const nextIndex=nextAvailableReviewIndex(reviewQueue,job.index,queuedDeleteIndices());
  const candidate={...reviewQueue,
    entries:reviewQueue.entries.map(entry=>({...entry})),
    cursor:nextIndex>=0?nextIndex:checkpointCursor(reviewQueue,job.index),active:true};
  if(!persistQueue(candidate))return false;
  reviewQueue=candidate;
  if(nextIndex>=0){
    const next=candidate.entries[nextIndex];
    reviewAwaitingLoad=true;
    thumbnails.close();
    try{core.open(next.path);}
    catch(_){debugLog.log("review.delete.next_playback_failed",{},"warn");}
  }
  deleteQueueNotice="";
  debugLog.log("review.delete.queue.accepted",{index:job.index,pending:queuedDeleteIndices().size});
  reportReview();
  return true;
}
function onQueuedVideoDeleted({path,cursor}={}){
  if(!reviewQueue || reviewQueue.entries[cursor]?.path!==path ||
     !["PENDING","KEEP"].includes(reviewQueue.entries[cursor].status))
    throw Error("ReviewChanged");
  const candidate={...reviewQueue,entries:reviewQueue.entries.map(entry=>({...entry}))};
  candidate.entries[cursor].status="DELETED";
  if(candidate.entries.every(entry=>entry.status!=="PENDING")){
    candidate.cursor=-1;candidate.active=false;
  }else if(candidate.cursor===cursor){
    candidate.cursor=checkpointCursor(candidate,cursor);
  }
  if(!persistQueue(candidate))throw Error("ReviewProgressNotPersisted");
  reviewQueue=candidate;
  debugLog.log("review.delete.queue.committed",{index:cursor});
  reportReview();
}
function onReviewDeleted({path,cursor}={}){
  const selected=reviewQueue?.entries?.[cursor];
  if(!selected || selected.path!==path ||
     !["PENDING","KEEP"].includes(selected.status))
    throw Error("ReviewChanged");
  const candidate={...reviewQueue,entries:reviewQueue.entries.map(e=>({...e}))};
  let current;
  if(cursor===candidate.cursor && selected.status==="PENDING"){
    ({current}=Review.advance(candidate,"DELETED"));
  }else{
    candidate.entries[cursor].status="DELETED";
    current=Review.current(candidate);
  }
  if(!persistQueue(candidate))throw new Error("ReviewProgressNotPersisted");
  reviewQueue=candidate;
  const alreadyOpened=!!current && deletePreview?.epoch===reviewSessionEpoch &&
    deletePreview.path===current.path && currentPlayerPath()===current.path;
  reviewAwaitingLoad=!!current && (!alreadyOpened || reviewLastLoadedPath!==current.path);
  thumbnails.close();
  debugLog.log("review.delete.verified",{cursor:reviewQueue.cursor});
  reportReview();
  if(current && !alreadyOpened){
    try{core.open(current.path);}catch(_){
      debugLog.log("review.delete.next_playback_failed",{},"error");
      throw new Error("NextPlaybackFailed");
    }
  }
}
const deleteCoordinator=createDeleteCoordinator({
  backend:deleteBackend,
  state:()=>{
    const item=reviewQueue&&Review.current(reviewQueue);
    return {
      root:reviewQueue?.root,path:item?.path,
      cursor:reviewQueue?.cursor,active:!!reviewQueue?.active,
      matched:isCurrentReviewPlayback()&&!reviewTextInputFocused,
      queueId:reviewSessionEpoch,
      mountBinding:reviewQueue?.nasBinding||"unverified_local_fixture"
    };
  },
  confirm:({name})=>utils.ask(
    "Permanently delete ONLY this video? "+name+
    "\nThis cannot be undone. Sidecar subtitle/metadata files are not included."
  )===true,
  journal:{
    read:()=>{
      const raw=preferences?.get(DELETE_JOURNAL_KEY);
      if(raw===null||raw===""||raw===undefined)return null;
      const parsed=JSON.parse(raw);
      if(!parsed||typeof parsed.id!=="string"||typeof parsed.state!=="string")
        throw new Error("InvalidDeleteJournal");
      return parsed;
    },
    write:record=>{
      if(!preferences || typeof preferences.set!=="function" ||
        typeof preferences.sync!=="function")throw new Error("JournalUnavailable");
      preferences.set(DELETE_JOURNAL_KEY,JSON.stringify(record));
      preferences.sync();
    }
  },
  onVerified:onReviewDeleted
});
async function testMountProbe(root){
  const result=await utils.exec("/sbin/mount",[]);
  return result?.status===0?Nas.probe(root,result.stdout||""):{allowed:false};
}
async function testStatOne(path){
  const result=await utils.exec("/usr/bin/stat",["-f","%p|%d|%i|%z|%m",path]);
  if(result?.status!==0)throw new Error("StatUnavailable");
  const fields=String(result.stdout||"").trim().split("|");
  if(fields.length!==5 || !fields.every(x=>/^\d+$/.test(x)))
    throw new Error("InvalidStat");
  const mode=parseInt(fields[0],8)&0o170000;
  const type=mode===0o100000?"file":mode===0o040000?"dir":
    mode===0o120000?"link":"other";
  return {type,identity:fields.join("|")};
}
async function verifiedSMBRootIdentity(root,proof){
  if(!proof?.allowed || !proof.mountPoint ||
     (root!==proof.mountPoint&&!root.startsWith(proof.mountPoint+"/")))
    throw Error("SMB_ROOT_UNVERIFIED");
  let parent=proof.mountPoint;
  let observed=await testStatOne(parent);
  if(observed.type!=="dir")throw Error("SMB_MOUNT_NOT_DIRECTORY");
  for(const segment of root.slice(parent.length).split("/").filter(Boolean)){
    parent+="/"+segment;
    observed=await testStatOne(parent);
    if(observed.type!=="dir")throw Error("SMB_ROOT_SYMLINK_OR_CHANGED");
  }
  return observed.identity;
}
async function testStat(path){
  const root=reviewQueue?.root;
  if(!root || (path!==root && path!==Review.current(reviewQueue)?.path &&
     path!==activeDeleteRequest?.path))
    throw new Error("OutsideReview");
  const proof=await testMountProbe(root);
  if(!proof.allowed || proof.binding!==reviewQueue?.nasBinding)
    throw new Error("MountChanged");
  let parent=proof.mountPoint;
  // Also verify each nested parent of the playing video, not only the
  // Review root. A link masquerading as an intermediate directory must
  // never redirect the single-file rm outside the mounted SMB tree.
  const parentPath=path===root?root:path.slice(0,path.lastIndexOf("/"));
  if(parentPath!==parent && !parentPath.startsWith(parent+"/"))
    throw new Error("OutsideMount");
  const components=parentPath.slice(parent.length).split("/").filter(Boolean);
  for(const part of components){
    parent+="/"+part;
    if((await testStatOne(parent)).type!=="dir")throw new Error("SymlinkParent");
  }
  return testStatOne(path);
}
async function verifyMissingReviewTarget(path,current){
  // A non-destructive proof for operator reconciliation only. A file's
  // disappearance is not proof that /bin/rm caused it, so the queue may
  // be marked MISSING but must never be attributed as DELETED here.
  const queuedUnknown=videoDeleteQueue?.snapshot().jobs.some(job=>
    job.status==="UNKNOWN" && job.root===reviewQueue?.root &&
    job.index===current?.cursor && job.path===path);
  const existing=reviewQueue?.entries?.[current?.cursor];
  if(!reviewQueue?.active || reviewQueue.nasReadOnly!==true ||
     reviewQueue.root!==current?.root || existing?.path!==path ||
     existing?.status!=="PENDING" ||
     (!queuedUnknown && Review.current(reviewQueue)?.path!==path))return false;
  try{
    const parent=path.slice(0,path.lastIndexOf("/"));
    if(parent!==current.root && !parent.startsWith(current.root+"/"))
      return false;
    const listed=Scan.scan(parent,dir=>file.list(dir),{
      recursive:false,maxFiles:20000
    });
    const name=path.slice(parent.length+1);
    if(listed.some(row=>row.filename===name))return false;
    const result=await utils.exec("/usr/bin/stat",[
      "-f","%p|%d|%i|%z|%m",path
    ]);
    // A missing name in a successfully scanned parent PLUS a failed stat
    // are independent observations; no destructive command is issued.
    return Number.isInteger(result?.status) && result.status!==0;
  }catch(_){return false;}
}
function onReviewMissingReconciled({path,cursor}){
  const row=reviewQueue?.entries?.[cursor];
  if(!reviewQueue?.active || row?.path!==path || row.status!=="PENDING")
    throw Error("ReviewChanged");
  const candidate={...reviewQueue,entries:reviewQueue.entries.map(e=>({...e}))};
  candidate.entries[cursor].status="DELETED";
  if(candidate.entries.every(e=>e.status!=="PENDING")){
    candidate.cursor=-1;candidate.active=false;
  }else if(candidate.cursor===cursor){
    candidate.cursor=checkpointCursor(candidate,cursor);
  }
  if(!persistQueue(candidate))throw Error("MissingProgressNotPersisted");
  reviewQueue=candidate;
  // A background reconciliation must not unload another video that IINA
  // is already playing, nor clear its file-loaded barrier.
  if(currentPlayerPath()===path){
    reviewAwaitingLoad=false;
    thumbnails.close();
  }
  debugLog.log("review.delete.unknown_missing_reconciled",{
    cursor:reviewQueue.cursor,deleted:reviewQueue.entries.filter(e=>e.status==="DELETED").length
  });
  reportReview();
}
// Normal SMB Review single-file delete. Retains the previous journal format
// and all identity/confirmation guards from the earlier test-mode backend.
const smbDelete=createExperimentalDelete({
  log:(event,data,level="info")=>debugLog.log(event,data,level),
  state:()=>{
    const task=activeDeleteRequest?.taskId?activeDeleteRequest:null;
    const playing=task?null:playingReviewDeleteTarget();
    const selected=task||activeDeleteRequest||playing;
    const item=selected?reviewQueue?.entries?.[selected.index]:
      reviewQueue&&Review.current(reviewQueue);
    const validWorker=!!task && reviewQueue?.root===task.root &&
      item?.path===task.path && ["PENDING","KEEP"].includes(item.status);
    return {root:reviewQueue?.root,path:item?.path,
      cursor:selected?.index??reviewQueue?.cursor,
      queueCursor:task?task.index:reviewQueue?.cursor,
      queueRevision:task?task.revision:smbCheckpointRevision,
      active:task?validWorker:reviewQueue?.active===true,
      matched:task?validWorker:
        (!!playing && !!selected && playing.path===selected.path &&
         playing.index===selected.index),
      nasReadOnly:reviewQueue?.nasReadOnly===true,recursive:reviewQueue?.recursive===true,
      mountBinding:reviewQueue?.nasBinding,
      queueId:task?task.taskId:deleteProcessNonce+":"+reviewSessionEpoch};
  },
  mountProbe:testMountProbe,
  // UNKNOWN reconciliation must follow the old durable queue cursor, not
  // the next video that was provisionally opened after /bin/rm dispatch.
  reconcileState:()=>{
    const unknown=videoDeleteQueue?.snapshot().jobs.find(job=>
      job.status==="UNKNOWN" && job.root===reviewQueue?.root);
    return {
      root:reviewQueue?.root,path:unknown?.path||Review.current(reviewQueue)?.path,
      cursor:unknown?.index??reviewQueue?.cursor,
      queueCursor:unknown?.index??reviewQueue?.cursor,
      queueRevision:smbCheckpointRevision,active:reviewQueue?.active===true,
      nasReadOnly:reviewQueue?.nasReadOnly===true,
      mountBinding:reviewQueue?.nasBinding,
      queueId:unknown?.id||deleteProcessNonce+":"+reviewSessionEpoch
    };
  },
  stat:testStat,
  confirm:({name})=>!!activeDeleteRequest?.taskId ||
    skipDeleteConfirmationEnabled || utils.ask(
    "Permanently DELETE this video? "+name+
    "\nThis cannot be undone. Only this video will be removed."+
    "\nThe SMB operation is path-based (not atomic compare-and-delete)."+
    "\nSidecar subtitles and metadata are not included."
  )===true,
  confirmReconcile:({missing}={})=>utils.ask(missing?
    "PREVIOUS DELETE OUTCOME UNKNOWN."+
    "\nThe old current video is now absent from this verified SMB folder."+
    "\nTreat this absent Review entry as DELETED and move to the next pending video?"+
    "\nThis does NOT call rm, replay deletion, or claim that the original delete succeeded."+
    "\nThe old journal will be acknowledged, and KEEP entries stay unchanged.":
    "PREVIOUS DELETE OUTCOME UNKNOWN."+
    "\nFirst inspect the original video in Finder to establish whether it is still present."+
    "\nAcknowledge the UNKNOWN transaction for this same verified SMB folder?"+
    "\nThis does NOT delete, retry, advance or declare the old deletion successful."+
    "\nA future delete requires separate fresh identity checks and confirmation."
  )===true,
  verifyMissing:verifyMissingReviewTarget,
  onMissing:onReviewMissingReconciled,
  captureCache:({path,fileIdentity})=>
    previewGenerator.captureForDeletion(path,{
      fileIdentity,duration:activeDeleteRequest?.taskId?
        Number(activeDeleteRequest.duration):Number(core.status?.duration)
    }),
  afterCommandSuccess:snapshot=>{
    // Thumbnail cleanup itself remains independent of Review progression.
    // Stop old-video prefetch before the cache cleanup job enters the same
    // serialized FFmpeg queue. Do this even if progress persistence fails.
    if(!activeDeleteRequest?.taskId ||
       currentPlayerPath()===activeDeleteRequest.path)thumbnails.close();
    if(!snapshot){
      debugLog.log("thumbnail.cleanup.skipped",{
        reason:"cache_identity_unavailable"
      },"warn");
      return;
    }
    if(cacheCleanupQueue.enqueue(snapshot))
      debugLog.log("thumbnail.cleanup.queued",{});
  },
  journal:{
    read:()=>{
      const raw=preferences?.get(TEST_DELETE_JOURNAL_KEY);
      return raw?JSON.parse(raw):null;
    },
    write:record=>{
      if(typeof preferences?.set!=="function"||typeof preferences?.sync!=="function")
        throw new Error("JournalUnavailable");
      preferences.set(TEST_DELETE_JOURNAL_KEY,JSON.stringify(record));
      preferences.sync();
    }
  },
  onCommandIssued:data=>{
    if(!activeDeleteRequest?.taskId)openNextWhenDeleteIssued(data);
  },
  deletePath:async (path,onIssued)=>{
    // utils.exec uses executable + argv (no shell). The coordinator has
    // already verified SMB mount, each target path component, file identity, native
    // per-file confirmation and persisted the ISSUED journal. This is still
    // non-atomic pathname deletion, not an identity-conditional SMB2 unlink.
    if(typeof utils?.exec!=="function")throw new Error("DeleteExecUnavailable");
    let outcome;
    try{
      const command=utils.exec("/bin/rm",["--",path]);
      // Once the command is issued, begin loading the next video without
      // awaiting SMB deletion or its non-authoritative postchecks.
      if(typeof onIssued==="function")onIssued();
      outcome=await command;
    }
    catch(_){
      debugLog.log("review.delete_test.command_unavailable",{},"warn");
      throw new Error("DeleteExecUnavailable");
    }
    if(!Number.isInteger(outcome?.status)||outcome.status!==0){
      const error=new Error("DeleteCommandFailed");
      if(Number.isInteger(outcome?.status)){
        error.rmExitCode=outcome.status;
        // Preserve the system error reason, never the full user media path.
        let detail=String(outcome.stderr||"").split("\n").find(Boolean)||"";
        detail=detail.replace(/\x1b\[[0-9;]*m/g,"")
          .replace(/[\x00-\x1f\x7f]/g," ").replaceAll(path,"[video]")
          .replace(/^rm:\s*(?:(?:.|\s)*?:\s*)?/i,"").trim();
        error.rmDetail=detail.slice(0,220);
      }
      debugLog.log("review.delete.command_failed",{
        exitCode:Number.isInteger(outcome?.status)?outcome.status:null
      },"warn");
      throw error;
    }
  },
  exists:path=>{
    if(typeof file?.exists!=="function")throw new Error("ExistsAPIUnavailable");
    return file.exists(path);
  },
  onDeleted:data=>activeDeleteRequest?.taskId?
    onQueuedVideoDeleted(data):onReviewDeleted(data)
});


videoDeleteQueue=createDurableVideoDeleteQueue({
  read:()=>preferences?.get(VIDEO_DELETE_QUEUE_KEY)||"",
  write:encoded=>{
    if(typeof preferences?.set!=="function"||
       typeof preferences?.sync!=="function")throw Error("JournalUnavailable");
    preferences.set(VIDEO_DELETE_QUEUE_KEY,encoded);
    preferences.sync();
  },
  onQueued:acceptQueuedVideoDelete,
  run:async job=>{
    if(!reviewQueue || reviewQueue.root!==job.root ||
       reviewQueue.nasBinding!==job.binding ||
       reviewQueue.entries[job.index]?.path!==job.path)
      return {status:"UNKNOWN",reason:"REVIEW_SOURCE_CHANGED"};
    activeDeleteRequest={
      path:job.path,index:job.index,taskId:job.id,root:job.root,
      revision:smbCheckpointRevision,duration:job.duration||0
    };
    try{
      const result=await smbDelete.request();
      if(result.status==="EXPERIMENTAL_DELETED"){
        return result.nextPlayback==="NOT_ISSUED"?
          {...result,status:"VERIFIED_DELETED"}:
          {...result,status:"UNKNOWN",
             reason:"RM_SUCCEEDED_BUT_REVIEW_NOT_COMMITTED"};
      }
      if(result.status==="REFUSED" &&
         ["UNRESOLVED_OPERATION","JOURNAL_UNAVAILABLE","REVIEW_CHANGED",
          "QUEUE_CHANGED"].includes(result.reason))
        return {...result,status:"UNKNOWN"};
      return result;
    }finally{activeDeleteRequest=null;}
  },
  onSettled:(job,result)=>{
    if(result.status==="VERIFIED_DELETED")
      debugLog.log("review.delete.job_completed",{index:job.index});
    else debugLog.log("review.delete.job_problem",{
      index:job.index,status:result.status,reason:result.reason||null
    },result.status==="UNKNOWN"?"error":"warn");
    const message=result.status==="VERIFIED_DELETED"?
      "":
      result.status==="UNKNOWN"?
        (result.reason==="RM_SUCCEEDED_BUT_REVIEW_NOT_COMMITTED"?
          "SMB rm succeeded, but Review checkpoint or completion journal could NOT be saved. Further deletions are paused; inspect the original file before reconciliation.":
          "Delete result UNKNOWN. Pending jobs are paused; inspect the original SMB video before reconciliation. Never retry automatically."):
        result.status==="COMMAND_FAILED"?
          ("Delete command failed (rm code "+result.exitCode+"): "+
            (result.detail||"No system detail")+
            ". Original video remains PENDING; other queued jobs continue."):
          "Background deletion blocked: "+(result.reason||result.status);
    deleteQueueNotice=message;
    reportReview();
  },
  onStatus:()=>reportReview(),
  onResumeConfirm:async job=>{
    if(!reviewQueue?.active || reviewQueue.root!==job.root ||
       reviewQueue.nasBinding!==job.binding ||
       reviewQueue.entries[job.index]?.path!==job.path)return false;
    return utils.ask("Resume a previously queued but NOT issued deletion? "+
      job.name+"\\nThe SMB file will be fully rechecked before deletion.");
  }
});
const directoryDelete=createDirectoryDelete({
  state:data=>({
    enabled:!!directoryModeRoot && data?.root===directoryModeRoot,
    reviewBusy:!!reviewQueue?.active || hasPendingCheckpoint() || reviewResumePending,
    playingUnknown:!!core.status?.url && !currentPlayerPath(),
    root:directoryModeRoot,parent:data?.parent,name:data?.name,
    binding:directoryModeBinding,epoch:directoryModeEpoch
  }),
  mountProbe:testMountProbe,
  stat:testStatOne,
  list:path=>file.list(path),
  playingPath:currentPlayerPath,
  confirm:({stage,name,path,childCount})=>utils.ask(stage==="initial"?
    "DELETE ENTIRE SMB DIRECTORY?\\n"+path+
    "\\nThis permanently deletes the folder AND ALL files/subfolders under it."+
    "\\nImmediate children: "+childCount+". This is not a total item count."+
    "\\nNo Trash, no undo. SMB pathname deletion is not atomic.":stage==="final"?
    "FINAL CONFIRMATION: recursively delete "+path+" and ALL its contents?"+
    "\\nThis is independent of Skip delete confirmation for videos.":
    "Previous directory delete is unresolved. You have inspected Finder and verified "+
    path+" is ABSENT. Acknowledge the prior operation without retrying?")===true,
  journal:{
    read:()=>{
      const raw=preferences?.get(DIRECTORY_DELETE_JOURNAL_KEY);
      if(!raw)return null;
      const obj=JSON.parse(raw);
      if(!obj || typeof obj.id!=="string" || typeof obj.state!=="string")
        throw Error("InvalidDirectoryDeleteJournal");
      return obj;
    },
    write:row=>{
      if(typeof preferences?.set!=="function" ||
         typeof preferences?.sync!=="function")throw Error("JournalUnavailable");
      preferences.set(DIRECTORY_DELETE_JOURNAL_KEY,JSON.stringify(row));
      preferences.sync();
    }
  },
  deleteTree:async path=>{
    if(typeof utils?.exec!=="function")throw Error("DeleteCommandUnavailable");
    // argv only, no shell interpolation. The coordinator independently checks
    // exact direct-child identity and both native confirmations first.
    return utils.exec("/bin/rm",["-r","--",path]);
  }
});
async function setDirectoryMode(data){
  directoryModeRoot="";
  directoryModeBinding="";
  directoryModeEpoch++;
  if(data?.enabled!==true){
    sidebar.postMessage("directory-mode-state",{enabled:false});
    return {enabled:false};
  }
  const root=data?.root;
  if(typeof root!=="string" || Nas.normalize(root)!==root ||
     !!reviewQueue?.active || hasPendingCheckpoint() || reviewResumePending){
    sidebar.postMessage("directory-mode-state",{
      enabled:false,reason:"REVIEW_CHECKPOINT_OR_INVALID_ROOT"
    });
    return {enabled:false};
  }
  const epoch=directoryModeEpoch;
  try{
    const proof=await testMountProbe(root);
    if(!proof.allowed)throw Error("MOUNT_UNAVAILABLE");
    await verifiedSMBRootIdentity(root,proof);
    if(epoch!==directoryModeEpoch)return {enabled:false};
    directoryModeRoot=root;
    directoryModeBinding=proof.binding;
    sidebar.postMessage("directory-mode-state",{enabled:true,root});
    return {enabled:true};
  }catch(_){
    sidebar.postMessage("directory-mode-state",{
      enabled:false,reason:"SMB_MOUNT_NOT_VERIFIED"
    });
    return {enabled:false};
  }
}
async function requestDirectoryDelete(data){
  const result=await directoryDelete.request(data);
  debugLog.log("directory.delete.outcome",{
    status:result.status,reason:result.reason||null
  },result.status==="UNKNOWN"?"error":"info");
  sidebar.postMessage("directory-delete-result",result);
  return result;
}
async function reconcileDirectoryDelete(){
  const result=await directoryDelete.reconcileMissing();
  debugLog.log("directory.delete.reconcile",{
    status:result.status,reason:result.reason||null
  });
  sidebar.postMessage("directory-delete-result",result);
  return result;
}
function reviewStart(data){
  debugLog.log("review.start.request");
  if(activeDeleteRequest || videoDeleteQueue?.pendingCount()>0){
    reportReview("Deletion in progress. Cannot replace this Review queue.");
    return;
  }
  // Never replace a live or persisted unfinished Review on a new Start.
  // This check must precede all source parsing, listing, preference writes,
  // player changes and in-memory queue mutations. An intentional restart
  // requires Exit (if active) and explicit checkpoint discard first.
  if(reviewQueue?.active || hasPendingCheckpoint() || nasProbePending){
    debugLog.log("review.start.rejected",{
      reason:nasProbePending?"mount_verification_pending":
        reviewQueue?.active?"session_active":"unfinished_checkpoint"
    },"warn");
    reportReview("An unfinished Review exists. Resume the saved queue, or Exit and explicitly discard its checkpoint before starting a new Review.");
    return;
  }
  const received=typeof data?.path==="string"?data.path:"";
  const nasRoot=Nas.normalize(received);
  if(nasRoot){
    nasProbePending=true;
    const token=++nasProbeRevision;
    debugLog.log("nas.mount.check_requested");
    // IINA Plugin API exec is asynchronous. Verify the OS mount table before
    // *any* file.list, queue creation, core.open or preference write.
    return Promise.resolve().then(()=>{
      if(!utils || typeof utils.exec!=="function")
        throw new Error("MountInspectorUnavailable");
      return utils.exec("/sbin/mount",[]);
    }).then(async result=>{
      if(!nasProbePending || nasProbeRevision!==token)return;
      const proof=Number(result?.status)===0?
        Nas.probe(nasRoot,result.stdout):{allowed:false,reason:"mount_inspection_failed"};
      if(!proof.allowed){
        nasProbePending=false;
        debugLog.log("nas.mount.rejected",{reason:proof.reason},"warn");
        reportReview("NAS Review requires an existing Finder-mounted SMB share under /Volumes. Mount the share and select its folder; no filesystem access occurred.");
        return;
      }
      if(reviewQueue?.active || hasPendingCheckpoint()){
        nasProbePending=false;return;
      }
      const rootIdentity=await verifiedSMBRootIdentity(nasRoot,proof);
      if(!nasProbePending || nasProbeRevision!==token)return;
      debugLog.log("nas.mount.verified",{status:"read_only"});
      const options={nasReadOnly:true,nasBinding:proof.binding,
        nasRootIdentity:rootIdentity,
        recursive:data?.recursive===true};
      if(!options.recursive){
        nasProbePending=false;
        reviewStartReady(nasRoot,options);
        return;
      }
      debugLog.log("nas.scan.started",{recursive:true});
      return Scan.scanAsync(nasRoot,dir=>file.list(dir),{
        recursive:true,maxFiles:20000,maxDirectories:5000,maxDepth:24,
        cancelled:()=>!nasProbePending || nasProbeRevision!==token,
        onProgress:status=>{
          if(status.directories%8===0)
            sidebar.postMessage("review-scan-progress",{
              directories:status.directories,files:status.files
            });
        }
      }).then(rows=>{
        if(!nasProbePending || nasProbeRevision!==token)return;
        nasProbePending=false;
        debugLog.log("nas.scan.completed",{total:rows.length});
        reviewStartReady(nasRoot,options,rows);
      });
    }).catch(error=>{
      if(nasProbeRevision!==token)return;
      nasProbePending=false;
      const reason=String(error?.message||"");
      const scanProblem=reason.startsWith("SCAN_");
      debugLog.log(scanProblem?"nas.scan.failed":"nas.mount.rejected",{
        reason:scanProblem?reason:"mount_inspection_failed",
        errorName:error?.name||"Error"
      },"warn");
      reportReview(scanProblem?
        "Recursive NAS scan stopped safely ("+reason+"). Choose a narrower folder or disable recursion.":
        "Cannot verify or scan the Finder-mounted SMB share. Review was not started.");
    });
  }
  const localRoot=Review.normalizeRoot(received);
  if(!localRoot){
    debugLog.log("review.start.rejected",{reason:"source_not_allowed"},"warn");
    reportReview("Review requires a disposable local fixture or a Finder-mounted SMB directory. Select a supported folder.");
    return;
  }
  return reviewStartReady(localRoot,{nasReadOnly:false,recursive:data?.recursive===true});
}
function reviewStartReady(root,options={},preScanned=null){
  thumbnails.close();
  // A source-selection attempt is permitted only when no unfinished Review
  // checkpoint exists. Rejected sources can then safely clear transient UI.
  reviewQueue=null;
  reviewAwaitingLoad=false;
  reviewTextInputFocused=false;
  reviewKInputEvents=0;
  reviewLastKResult="No K key received";
  try{
    const listed=preScanned || Scan.scan(root,dir=>file.list(dir),{
      recursive:options.recursive===true
    });
    const nextQueue=Review.createQueue(root,listed,options);
    if(options.nasReadOnly===true){
      nextQueue.nasReadOnly=true;
      nextQueue.nasBinding=options.nasBinding;
      nextQueue.nasRootIdentity=options.nasRootIdentity;
    }
    debugLog.log("review.scan.summary",{
      total:Array.isArray(listed)?listed.length:0,
      accepted:nextQueue.entries.length
    });
    debugLog.log("review.queue.created",{
      total:nextQueue.entries.length,active:nextQueue.active
    });
    if(nextQueue.entries.length && !persistQueue(nextQueue)){
      reportReview("Could not save the Review checkpoint. Playback was not started.");
      return;
    }
    reviewQueue=nextQueue;
    reviewSessionEpoch++;
    reviewAwaitingLoad=!!Review.current(reviewQueue);
    reportReview(reviewQueue.entries.length?"":"No video files found in this folder.");
    const current=Review.current(reviewQueue);
    if(current){
      debugLog.log("review.play.request",{cursor:reviewQueue.cursor});
      core.open(current.path);
      // URL may now point to the requested file while its load is pending.
      // Reflect that intermediate state instead of leaving the sidebar with
      // the pre-open missing_url report.
      reportReview();
    }
  }catch(error){
    debugLog.log("review.start.error",{errorName:error?.name||"Error"},"error");
    reportReview("Cannot create review queue: "+String(error));
  }
}
function reviewKeep(){
  if(videoDeleteQueue?.blocked()){
    // KEEP remains possible during an unresolved rm provided local checkpoint
    // storage works; only new destructive commands are blocked.
  }
  if(reviewAwaitingLoad){
    debugLog.log("review.keep.rejected",{reason:"awaiting_file_loaded"},"warn");
    reportReview("IINA is still loading the current Review video. KEEP was not changed.");
    return false;
  }
  if(!isCurrentReviewPlayback()){
    const observed=inspectReviewPlayback();
    debugLog.log("review.keep.rejected",{
      reason:reviewQueue?.active?"playback_mismatch":"session_inactive",
      status:observed.reason
    },"warn");
    reportReview("Playback differs from the active review item. Nothing was changed.");
    return false;
  }
  return keepAndAdvanceReview();
}
// The only mutation path shared by explicit K and a separately verified
// natural EOF. Never expose it through an untrusted sidebar message.
function keepAndAdvanceReview(selectedIndex=null,{alreadyLoadedPath=null}={}){
  const candidate={
    ...reviewQueue,entries:reviewQueue.entries.map(item=>({...item}))
  };
  // Natural EOF may belong to another actually loaded pending queue entry
  // (e.g. IINA History). Select that entry atomically with KEEP persistence,
  // never marking the skipped cursor or an already-KEEP item by mistake.
  if(selectedIndex!==null && selectedIndex!==candidate.cursor &&
     !Review.select(candidate,selectedIndex))return false;
  const selected=candidate.cursor;
  if(selected<0 || candidate.entries[selected]?.status!=="PENDING" ||
     queuedDeleteIndices().has(selected))return false;
  candidate.entries[selected].status="KEEP";
  const nextIndex=nextAvailableReviewIndex(candidate,selected,queuedDeleteIndices());
  if(nextIndex>=0)candidate.cursor=nextIndex;
  else{
    candidate.cursor=checkpointCursor(candidate,selected);
    candidate.active=candidate.cursor>=0;
  }
  const current=nextIndex>=0?candidate.entries[nextIndex]:null;
  // Persist the KEEP decision before opening the next video. No in-memory
  // decision is committed if IINA's preferences sync fails.
  if(!persistQueue(candidate)){
    reportReview("Could not save KEEP. The current review item was not changed.");
    return false;
  }
  reviewQueue=candidate;
  reviewAwaitingLoad=!!current && current.path!==alreadyLoadedPath;
  thumbnails.close();
  debugLog.log("review.keep.accepted",{
    kept:reviewQueue.entries.filter(entry=>entry.status==="KEEP").length,
    next:!!current
  });
  if(!current)debugLog.log("review.completed",{
    kept:reviewQueue.entries.filter(x=>x.status==="KEEP").length
  });
  reportReview();
  if(current && current.path!==alreadyLoadedPath){
    core.open(current.path);
    reportReview();
  }
  return true;
}

function reviewPlay(data){
  const index=data?.position;
  if(!reviewQueue?.entries?.length || !Number.isInteger(index) ||
     index<0 || index>=reviewQueue.entries.length){
    debugLog.log("review.play_selected.rejected",{reason:"invalid_selection"},"warn");
    return false;
  }
  if(reviewAwaitingLoad){
    debugLog.log("review.play_selected.rejected",{reason:"awaiting_file_loaded"},"warn");
    return false;
  }
  const selected=reviewQueue.entries[index];
  if(queuedDeleteIndices().has(index))return false;
  if(selected.status==="DELETED" || selected.status==="MISSING" ||
     (selected.status==="PENDING" && !reviewQueue.active))return false;
  // Previously kept videos may be replayed, but never alter pending
  // progress or trigger a second KEEP on a natural EOF.
  if(selected.status==="PENDING"){
    const next={...reviewQueue,entries:reviewQueue.entries.map(e=>({...e}))};
    if(!Review.select(next,index))return false;
    if(!persistQueue(next)){
      reportReview("Unable to save selected Review position. No video opened.");
      return false;
    }
    reviewQueue=next;
  }
  reviewAwaitingLoad=selected.status==="PENDING";
  thumbnails.close();
  try{
    debugLog.log("review.play_selected.request",{
      position:index,alreadyKept:selected.status!=="PENDING"
    });
    core.open(selected.path);
    showPluginSidebar();
    reportReview();
    return true;
  }catch(error){
    debugLog.log("review.play_selected.failed",{errorName:error?.name||"Error"},"warn");
    reportReview("Could not open the selected Review video.");
    return false;
  }
}
function loadedPendingReview(){
  if(!reviewQueue?.active || reviewAwaitingLoad || !reviewLastLoadedPath)return null;
  const index=reviewQueue.entries.findIndex(item=>
    item.path===reviewLastLoadedPath && item.status==="PENDING");
  if(index<0 || queuedDeleteIndices().has(index))return null;
  const observedPath=currentPlayerPath();
  if(observedPath && observedPath!==reviewLastLoadedPath)return null;
  const item=reviewQueue.entries[index];
  return {index,item,token:reviewSessionEpoch+":"+index+":"+item.name};
}
function seekIntentForLoaded(loaded){
  const intent=reviewSeekIntent;
  if(!loaded || !intent || intent.token!==loaded.token ||
     Date.now()-intent.at>10000)return null;
  return intent;
}
function keepReviewFromSeek(loaded,source){
  const intent=seekIntentForLoaded(loaded);
  if(!intent || reviewTextInputFocused ||
     !["end_file_eof","mpv_eof"].includes(source) ||
     reviewLastEOFToken===loaded.token)return false;
  // A real EOF immediately following a seek, with no conflicting progress
  // samples, is the only reliable evidence when mpv unloads the file at 100%.
  reviewLastEOFToken=loaded.token;
  debugLog.log("review.auto_keep.seek_eof",{source,cursor:loaded.index});
  const accepted=keepAndAdvanceReview(loaded.index);
  if(!accepted)reviewLastEOFToken="";
  reviewSeekIntent=null;
  return accepted;
}
function reviewEOF(source){
  const loaded=loadedPendingReview();
  if(!loaded)return false;
  const {item,index,token}=loaded;
  const observedPath=currentPlayerPath();
  // The event may arrive after IINA has cleared the stopped URL; this is
  // acceptable for a real end-file eof only if the previous playback
  // samples independently prove that SAME loaded Review video reached its
  // natural end. Never accept an event while a foreign file is loaded.
  if(observedPath && observedPath!==item.path)return false;
  const progress=reviewProgressPrevious?.token===token?
    reviewProgressPrevious:null;
  // A delayed EOF for the previous video can arrive just after the next
  // file-loaded event, while core.status still carries the old video's
  // duration/last position. Require a near-end sample from THIS loaded
  // Review item before accepting any end-file completion notification.
  // IINA may send the last time-pos sample a few seconds before an
  // explicit end-file EOF. Accept that gap only with steady-play evidence.
  const sampleTolerance=progress?.duration>0?
    source==="end_file_eof"?Math.min(8,Math.max(5,progress.duration*0.005)):
      Math.min(5,Math.max(2,progress.duration*0.005)):2;
  if(!progress || !Number.isFinite(progress.duration) ||
     progress.duration<=0 || !Number.isFinite(progress.position) ||
     progress.position<progress.duration-sampleTolerance){
    if(keepReviewFromSeek(loaded,source))return true;
    debugLog.log("review.auto_keep.ignored",{reason:"no_matching_end_progress"});
    return false;
  }
  const liveDuration=core.status?.duration;
  const duration=Number.isFinite(liveDuration)&&liveDuration>0?
    liveDuration:progress?.duration;
  const livePosition=core.status?.position;
  // After IINA clears the finished video's URL, the final reported tick
  // can be a few seconds shy of duration. In that case only accept an
  // explicit natural EOF *plus* continuous near-end playback evidence.
  const endTolerance=source==="end_file_eof"?
    Math.min(8,Math.max(5,duration*0.005)):
    observedPath?Math.max(0.5,duration*0.005):
      Math.min(5,Math.max(2,duration*0.005));
  const position=Number.isFinite(livePosition) &&
    Number.isFinite(duration) &&
    livePosition>=duration-endTolerance?
    livePosition:progress?.position;
  if(!Number.isFinite(duration) || duration<=0 ||
     !Number.isFinite(position) || position<duration-endTolerance){
    if(keepReviewFromSeek(loaded,source))return true;
    debugLog.log("review.auto_keep.ignored",{reason:"not_near_end"});
    return false;
  }
  // The eof-reached property also changes after seek-to-end. Require
  // recorded terminal evidence when the event has no EOF reason.
  if(!completionEvidenceFor(token)){
    if(keepReviewFromSeek(loaded,source))return true;
    debugLog.log("review.auto_keep.ignored",{reason:"natural_progress_unverified"});
    return false;
  }
  if(reviewLastEOFToken===token)return false;
  reviewLastEOFToken=token;
  debugLog.log("review.auto_keep.eof",{source});
  const accepted=keepAndAdvanceReview(index);
  if(!accepted)reviewLastEOFToken="";
  return accepted;
}
// IINA's mpv event callbacks have no reason payload in the public API.
// Automatic playlist advancement can therefore load the next video before
// our EOF observers see a usable terminal signal. Only accept that transition
// for the EXACT next pending item after terminal evidence for the last item.
function previousPendingReviewToken(){
  if(!reviewQueue?.active || !reviewLastLoadedPath)return null;
  const index=reviewQueue.entries.findIndex(item=>
    item.path===reviewLastLoadedPath && item.status==="PENDING");
  if(index<0 || queuedDeleteIndices().has(index))return null;
  return {index,token:reviewSessionEpoch+":"+index+":"+
    reviewQueue.entries[index].name};
}
// Terminal evidence window. It is wider than the seek-tail tolerance because
// IINA may stop publishing time-pos a few seconds before it unloads the file;
// the exact next-item transition is independent proof the item reached its end.
function reviewTerminalWindow(duration){
  return Math.max(5,duration*0.01);
}
// An explicit seek that STOPPED inside the tail is the user's own completion
// decision, exactly like the time-pos seek_tail path.
function readMpvPositionSeconds(){
  try{
    const value=mpv?.getNumber?.("time-pos");
    return Number.isFinite(value)?value:null;
  }catch(_){return null;}
}
function tailSeekEvidenceFor(token){
  const intent=reviewSeekIntent;
  if(!intent || intent.token!==token)return null;
  const at=intent.at;
  if(!Number.isFinite(at) || Date.now()-at>10000)return null;
  const duration=intent.duration,from=intent.from;
  if(!Number.isFinite(duration) || duration<=0 ||
     !Number.isFinite(from))return null;
  const tailTolerance=Math.min(3,Math.max(2,duration*0.005));
  const minJump=Math.max(3,Math.min(15,duration*0.03));
  const destinations=[intent.to,intent.toProbe].filter(value=>
    Number.isFinite(value) && value>=duration-tailTolerance &&
    value<=duration+1 && value-from>=minJump);
  if(!destinations.length)return null;
  return {token,at,position:Math.max(...destinations),duration,
    source:"seek_tail",seq:intent.seq||0};
}
function completionEvidenceFor(token){
  return reviewTerminal?.token===token?reviewTerminal:tailSeekEvidenceFor(token);
}
function keepOnVerifiedNextFileLoad(nextPath){
  if(!reviewQueue?.active || reviewAwaitingLoad || !reviewLastLoadedPath ||
     !nextPath || nextPath===reviewLastLoadedPath || reviewTextInputFocused)
    return false;
  const previous=previousPendingReviewToken();
  if(!previous)return false;
  const previousIndex=previous.index,token=previous.token;
  const ignore=(reason)=>{
    debugLog.log("review.auto_keep.transition_ignored",{
      cursor:previousIndex,reason
    });
    return false;
  };
  if(reviewLastEOFToken===token)return false;
  const evidence=completionEvidenceFor(token);
  if(!evidence)return ignore("no_terminal_evidence");
  const age=Date.now()-evidence.at;
  if(!Number.isFinite(age) || age<0 || age>15000)
    return ignore("stale_terminal_evidence");
  const duration=evidence.duration;
  if(!Number.isFinite(duration) || duration<=0)
    return ignore("invalid_terminal_evidence");
  // A terminating seek proves "the drag ended the file"; the cached position
  // may still be the pre-drag point, so it must not be judged as a tail sample.
  if(evidence.source!=="terminating_seek"){
    const tolerance=reviewTerminalWindow(duration);
    if(!Number.isFinite(evidence.position) ||
       evidence.position<duration-tolerance ||
       evidence.position>duration+1)
      return ignore("not_at_terminal_tail");
  }
  // A newer seek that did not end inside the tail means the user left the
  // terminal region; never credit that as completion.
  if(evidence.source!=="seek_tail" && reviewSeekIntent?.token===token &&
     (reviewSeekIntent.seq||0)>(evidence.seq||0))
    return ignore("seek_after_evidence");
  const candidate={...reviewQueue,
    entries:reviewQueue.entries.map(item=>({...item}))};
  if(previousIndex!==candidate.cursor && !Review.select(candidate,previousIndex))
    return ignore("selection_unavailable");
  candidate.entries[previousIndex].status="KEEP";
  const nextIndex=nextAvailableReviewIndex(candidate,previousIndex,
    queuedDeleteIndices());
  if(nextIndex<0 || candidate.entries[nextIndex]?.path!==nextPath)
    return ignore("not_next_pending");
  reviewLastEOFToken=token;
  debugLog.log("review.auto_keep.next_file_verified",{
    cursor:previousIndex,nextCursor:nextIndex
  });
  const accepted=keepAndAdvanceReview(previousIndex,{
    alreadyLoadedPath:nextPath
  });
  if(!accepted)reviewLastEOFToken="";
  return accepted;
}
// Dragging to the end often unloads the file before IINA publishes the drag
// destination: the cached position still shows the pre-drag point and
// mpv.getNumber("time-pos") is already gone. A forward seek that ends within
// this window can only have reached the end of the file - anything short of
// the end keeps playing. This is the drag completion signal.
const TERMINATING_SEEK_MS=1500;
function reviewTerminatingSeekEvidence(){
  const previous=previousPendingReviewToken();
  if(!previous)return false;
  if(reviewRetreatedToken===previous.token)return false;
  const intent=reviewSeekIntent;
  if(!intent || intent.token!==previous.token)return false;
  const age=Date.now()-intent.at;
  if(!Number.isFinite(age) || age<0 || age>TERMINATING_SEEK_MS)return false;
  const duration=intent.duration,from=intent.from;
  if(!Number.isFinite(duration) || duration<=0 || !Number.isFinite(from))
    return false;
  const destinations=[intent.to,intent.toProbe].filter(Number.isFinite);
  if(!destinations.length)return false;
  const destination=Number.isFinite(intent.toProbe)?
    intent.toProbe:Math.max(...destinations);
  const peak=Number.isFinite(intent.peak)?intent.peak:
    Math.max(...destinations);
  if(destination<from)return false; // a backward drag leaves the item playing
  if(destination<peak-Math.max(1,duration*0.01))
    return false; // the drag retreated from its furthest point
  reviewTerminal={token:previous.token,at:Date.now(),position:destination,
    duration,source:"terminating_seek",seq:++reviewObservationSeq};
  debugLog.log("review.terminal.observed",{source:"terminating_seek",
    actualSeconds:Math.round(destination*10)/10,
    targetSeconds:Math.round(duration*10)/10});
  return true;
}
// The public end-file callback carries no reason, so ask mpv for the final
// position once. This records completion evidence only; it never opens media,
// seeks, deletes or mutates IINA's native history.
function reviewEndFilePositionProbe(){
  if(!reviewQueue?.active || reviewAwaitingLoad)return;
  const previous=previousPendingReviewToken();
  if(!previous)return;
  let position=null,duration=null;
  try{
    if(typeof mpv?.getNumber==="function"){
      position=mpv.getNumber("time-pos");
      duration=mpv.getNumber("duration");
    }
  }catch(_){position=null;duration=null;}
  if(!Number.isFinite(position) || !Number.isFinite(duration) ||
     duration<=0){
    const intent=reviewSeekIntent?.token===previous.token?reviewSeekIntent:null;
    const observed=[intent?.to,intent?.toProbe].filter(Number.isFinite);
    const data={enabled:false,reason:"position_unavailable"};
    if(observed.length)
      data.actualSeconds=Math.round(Math.max(...observed)*10)/10;
    if(Number.isFinite(intent?.duration))
      data.targetSeconds=Math.round(intent.duration*10)/10;
    debugLog.log("review.end_file.position",data);
    reviewTerminatingSeekEvidence();
    return;
  }
  const nearEnd=position>=duration-reviewTerminalWindow(duration) &&
    position<=duration+1;
  debugLog.log("review.end_file.position",{
    actualSeconds:Math.round(position*10)/10,
    targetSeconds:Math.round(duration*10)/10,
    nearEnd
  });
  if(!nearEnd){
    reviewTerminatingSeekEvidence();
    return;
  }
  reviewTerminal={token:previous.token,at:Date.now(),position,duration,
    source:"end_file_probe",seq:++reviewObservationSeq};
}
function reviewReopen(){
  const current=reviewQueue && Review.current(reviewQueue);
  const supported=reviewQueue &&
    (Review.allowedRoot(reviewQueue.root) ||
     (reviewQueue.nasReadOnly===true && !!Nas.normalize(reviewQueue.root)));
  if(!current || !supported){
    debugLog.log("review.playback.reopen_rejected",{
      reason:"session_inactive"
    },"warn");
    return false;
  }
  const observed=inspectReviewPlayback();
  if(observed.matched && !reviewAwaitingLoad){
    reportReview();
    return false;
  }
  thumbnails.close();
  reviewAwaitingLoad=true;
  debugLog.log("review.playback.reopen_requested",{reason:observed.reason});
  try{
    // User-initiated recovery of the same queued local fixture; do not
    // modify KEEP, cursor or checkpoint, and never follow the foreign URL.
    core.open(current.path);
    reportReview();
    return true;
  }catch(error){
    debugLog.log("review.playback.reopen_failed",{
      errorName:error?.name||"Error"
    },"warn");
    reportReview("Could not reopen the current Review item.");
    return false;
  }
}

async function reviewDelete(){
  // No opt-in switch: D is a single-file, individually confirmed request.
  // SMB mounts use strict mount/file identity checks and a durable journal;
  // unverified local sources still use the unsupported safe coordinator.
  const nas=reviewQueue?.nasReadOnly===true;
  if(nas){
    if(videoDeleteQueue){
      if(videoDeleteQueue.blocked()){
        reportReview("A delete outcome is unresolved or storage is unavailable. No new deletion was queued.");
        return {status:"REFUSED",reason:"UNRESOLVED_OPERATION"};
      }
      const old=preferences?.get(TEST_DELETE_JOURNAL_KEY);
      if(old){
        try{
          const previous=JSON.parse(old);
          const knownActiveWorker=videoDeleteQueue.snapshot().jobs.some(job=>
            job.status==="RUNNING" && job.id===previous?.queueId);
          if(["UNKNOWN","ISSUED","INTENT"].includes(previous?.state) &&
             !knownActiveWorker){
            reportReview("Previous deletion is unresolved. Reconcile it before queueing D.");
            return {status:"REFUSED",reason:"UNRESOLVED_OPERATION"};
          }
        }catch(_){return {status:"REFUSED",reason:"JOURNAL_UNAVAILABLE"};}
      }
      const target=playingReviewDeleteTarget();
      if(!target || queuedDeleteIndices().has(target.index)){
        reportReview("D requires a loaded, not-yet-queued Review video.");
        return {status:"REFUSED",reason:"PLAYBACK_NOT_READY"};
      }
      const name=reviewQueue.entries[target.index]?.name||"";
      let confirmed=false;
      try{
        confirmed=skipDeleteConfirmationEnabled || utils.ask(
          "Permanently queue deletion of this SMB video? "+name+
          "\\nPlayback advances immediately, but /bin/rm runs sequentially in the background."+
          "\\nThis operation bypasses Trash and cannot be undone.");
      }catch(_){return {status:"REFUSED",reason:"CONFIRMATION_UNAVAILABLE"};}
      if(!confirmed)return {status:"CANCELLED"};
      if(!playingReviewDeleteTarget() ||
         playingReviewDeleteTarget().path!==target.path ||
         queuedDeleteIndices().has(target.index))
        return {status:"REFUSED",reason:"PLAYBACK_CHANGED"};
      const accepted=videoDeleteQueue.enqueue({
        root:reviewQueue.root,path:target.path,index:target.index,
        name,binding:reviewQueue.nasBinding,
        queueKey:deleteProcessNonce+":"+reviewSessionEpoch,
        duration:Number(core.status?.duration)||0
      });
      if(!accepted.accepted){
        reportReview("Could not enqueue delete ("+accepted.reason+").");
        return {status:"REFUSED",reason:accepted.reason};
      }
      debugLog.log("review.delete.queued",{index:target.index});
      return accepted.completion;
    }

    if(activeDeleteRequest)
      return {status:"REFUSED",reason:"OPERATION_IN_PROGRESS"};
    const target=playingReviewDeleteTarget();
    if(!target){
      reportReview("D requires a currently loaded video from this Review. No file changed.");
      return {status:"REFUSED",reason:"PLAYBACK_NOT_READY"};
    }
    activeDeleteRequest=target;
  }
  try{
  const result=nas?await smbDelete.request():await deleteCoordinator.request();
  if(nas){
    activeDeleteRequest=null;
    deletePreview=null;
  }
  if(result.status==="EXPERIMENTAL_DELETED"){
    debugLog.log("review.delete.command_succeeded",{outcome:"rm_exit_zero"});
    const progressError={
      FAILED:"/bin/rm succeeded, but opening the next video failed. Review the saved queue; do not delete again.",
      PROGRESS_SAVE_FAILED:"/bin/rm succeeded, but the Review checkpoint could NOT be saved. Do not press D again. Reopen IINA to reconcile the missing file against SMB.",
      JOURNAL_SAVE_FAILED:"/bin/rm succeeded, but its completion journal could NOT be saved. Do not press D again; verify the SMB folder and recover the Review.",
      QUEUE_CHANGED:"/bin/rm succeeded, but the Review cursor changed before progress could be saved. Do not retry deletion; verify the queue against SMB."
    };
    reportReview(progressError[result.nextPlayback]||
      "Video deleted (/bin/rm exit code 0). Review advanced to the next item.");
    return {...result,status:"VERIFIED_DELETED"};
  }
  if(result.status==="COMMAND_FAILED"){
    const message="Delete failed: /bin/rm exited with code "+result.exitCode+
      ".\nReason: "+(result.detail||"The system returned no error text.")+
      "\nThe same video was verified as still present; no automatic retry was made.";
    debugLog.log("review.delete.failed",{exitCode:result.exitCode},"warn");
    reportReview(message);
    // IINA Utils.ask is the supported native modal API; here it displays
    // an informational failure, not an additional confirmation request.
    try{utils.ask(message);}catch(_){}
    return result;
  }
  if(result.status==="UNKNOWN" && result.commandFailed){
    const message="/bin/rm exited with code "+result.exitCode+
      ".\nSystem error: "+(result.detail||"No stderr detail returned.")+
      "\nWARNING: The file's final state could NOT be verified."+
      "\nInspect it in Finder before reconciling UNKNOWN. Do not retry deletion.";
    debugLog.log("review.delete.command_unknown",{exitCode:result.exitCode},"warn");
    reportReview(message);
    try{utils.ask(message);}catch(_){}
    return result;
  }
  if(result.status!=="VERIFIED_DELETED"){
    debugLog.log("review.delete.rejected",{
      reason:result.reason||result.status
    },result.status==="UNKNOWN"?"error":"warn");
    reportReview(result.status==="CANCELLED"?"Deletion cancelled. No file changed.":
      result.status==="UNKNOWN"?
        "Deletion outcome is UNKNOWN; no automatic retry is permitted.":
      result.reason==="UNRESOLVED_OPERATION"?
        "Previous delete outcome is UNKNOWN. Stop pressing D. Inspect the prior file in Finder, then click Reconcile previous UNKNOWN and confirm. No delete was attempted.":
        result.reason==="UNSUPPORTED_SAFETY_CAPABILITY"?
          "Permanent deletion is unavailable for this non-SMB test source. No file changed.":
          "Deletion unavailable ("+(result.reason||"safety_gate")+"). No file was changed by this request.");
  }
  return result;
  }finally{
    if(nas){
      activeDeleteRequest=null;
      deletePreview=null;
    }
  }
}
async function acknowledgeDurableQueueUnknown(job){
  // A queue job cannot be reconciled using the legacy one-slot rm journal:
  // that journal may already describe a different, later video.
  if(!job || job.status!=="UNKNOWN" || !reviewQueue?.active ||
     !reviewQueue.nasReadOnly || reviewQueue.root!==job.root ||
     reviewQueue.nasBinding!==job.binding ||
     reviewQueue.entries?.[job.index]?.path!==job.path ||
     !["PENDING","DELETED"].includes(reviewQueue.entries[job.index].status))
    return {status:"REFUSED",reason:"QUEUE_SOURCE_CHANGED"};
  const epoch=reviewSessionEpoch;
  async function observe(){
    const proof=await testMountProbe(job.root);
    if(!proof.allowed || proof.binding!==job.binding ||
       proof.binding!==reviewQueue?.nasBinding)throw Error("MOUNT_CHANGED");
    const rootIdentity=await verifiedSMBRootIdentity(job.root,proof);
    if(!SMBCheckpoint.sameRootAfterRemount(
        reviewQueue.nasRootIdentity,rootIdentity))
      throw Error("SOURCE_CHANGED");
    const parent=job.path.slice(0,job.path.lastIndexOf("/"));
    const name=job.path.slice(parent.length+1);
    if(!name || (parent!==job.root && !parent.startsWith(job.root+"/")))
      throw Error("INVALID_TARGET");
    let cursor=job.root;
    for(const part of parent.slice(job.root.length).split("/").filter(Boolean)){
      cursor+="/"+part;
      if((await testStatOne(cursor)).type!=="dir")
        throw Error("SOURCE_CHANGED");
    }
    const listed=Scan.scan(parent,dir=>file.list(dir),{
      recursive:false,maxFiles:20000
    });
    const candidate=listed.find(row=>row.filename===name);
    const result=await utils.exec("/usr/bin/stat",[
      "-f","%p|%d|%i|%z|%m",job.path
    ]);
    if(candidate && !candidate.isDir && result?.status===0){
      const fields=String(result.stdout||"").trim().split("|");
      if(fields.length!==5 || !fields.every(value=>/^\d+$/.test(value)) ||
         (parseInt(fields[0],8)&0o170000)!==0o100000)
        throw Error("TARGET_CHANGED");
      return {present:true,identity:fields.join("|")};
    }
    if(!candidate && Number.isInteger(result?.status) && result.status!==0)
      return {present:false,identity:""};
    throw Error("TARGET_INDETERMINATE");
  }
  let first;
  try{first=await observe();}
  catch(error){
    const reason=String(error?.message||"SOURCE_UNAVAILABLE");
    return {status:"REFUSED",reason:/^[A-Z_]+$/.test(reason)?
      reason:"SOURCE_UNAVAILABLE"};
  }
  const which="Review #"+(job.index+1)+" — "+
    (job.name||reviewQueue.entries[job.index].name);
  const message=first.present?
    "Queued deletion outcome UNKNOWN for "+which+". The queued pathname currently points to a video on this verified SMB share. Inspect it in Finder first, then acknowledge WITHOUT deleting anything? Review stays PENDING and later jobs stay paused.":
    "Queued deletion outcome UNKNOWN for "+which+". The pathname is absent from this verified SMB share. Mark its Review entry DELETED for navigation only (not proof of who deleted it)? No delete command will run; later jobs stay paused.";
  let confirmed=false;
  try{confirmed=utils.ask(message)===true;}
  catch(_){return {status:"REFUSED",reason:"CONFIRMATION_UNAVAILABLE"};}
  if(!confirmed)return {status:"CANCELLED",reason:"CANCELLED"};
  let second;
  try{second=await observe();}
  catch(_){return {status:"REFUSED",reason:"VERIFICATION_CHANGED"};}
  if(first.present!==second.present ||
     (first.present && first.identity!==second.identity))
    return {status:"REFUSED",reason:"VERIFICATION_CHANGED"};
  if(reviewSessionEpoch!==epoch || !reviewQueue?.active ||
     reviewQueue.root!==job.root ||
     reviewQueue.entries?.[job.index]?.path!==job.path ||
     videoDeleteQueue?.snapshot().jobs.find(row=>row.id===job.id)?.status!=="UNKNOWN")
    return {status:"REFUSED",reason:"QUEUE_CHANGED"};
  if(!first.present && reviewQueue.entries[job.index].status==="PENDING"){
    try{onReviewMissingReconciled({path:job.path,cursor:job.index});}
    catch(_){return {status:"REFUSED",reason:"MISSING_PROGRESS_UNAVAILABLE"};}
  }
  // A matching legacy journal may still be UNKNOWN from the same issued
  // task. Explicit recovery must release BOTH locks, never overwrite a
  // different task's journal or pretend a mismatched old journal is UNKNOWN.
  try{
    const raw=preferences?.get(TEST_DELETE_JOURNAL_KEY);
    const old=raw?JSON.parse(raw):null;
    if(old?.queueId===job.id && old.cursor===job.index &&
       old.mountIdentity===job.binding &&
       ["UNKNOWN","ISSUED"].includes(old.state)){
      const updated={...old,state:"MANUALLY_RECONCILED"};
      preferences.set(TEST_DELETE_JOURNAL_KEY,JSON.stringify(updated));
      preferences.sync();
      const checked=JSON.parse(preferences.get(TEST_DELETE_JOURNAL_KEY)||"null");
      if(checked?.id!==old.id || checked.state!=="MANUALLY_RECONCILED")
        throw Error("JOURNAL_READBACK_FAILED");
    }
  }catch(_){return {status:"REFUSED",reason:"LEGACY_JOURNAL_UNAVAILABLE"};}
  if(!videoDeleteQueue.reconcileUnknown(job.id,{
    verified:true,absent:!first.present
  }))return {status:"REFUSED",reason:"QUEUE_JOURNAL_UNAVAILABLE"};
  debugLog.log("review.delete.queue.unknown_reconciled",{
    index:job.index,observed:first.present?"present":"absent"
  });
  return {status:"ACKNOWLEDGED",reason:"QUEUE_MANUAL_RECONCILIATION",
    missingSkipped:!first.present};
}
async function reviewAcknowledgeUnknown(){
  const unknown=videoDeleteQueue?.snapshot().jobs.find(job=>
    job.status==="UNKNOWN" && job.root===reviewQueue?.root);
  const result=unknown?await acknowledgeDurableQueueUnknown(unknown):
    await smbDelete.acknowledgeUnknown();
  debugLog.log("review.delete_test.unknown_reconciliation",{
    status:result.status,reason:result.reason||null
  },result.status==="ACKNOWLEDGED"?"info":"warn");
  reportReview(result.status==="ACKNOWLEDGED" && result.missingSkipped?
    "The video is absent on SMB and was marked DELETED for Review progress. No delete was retried; open the next video from Review.":
    result.status==="ACKNOWLEDGED"?
    "Previous UNKNOWN manually acknowledged; no file changed. A new D request still requires confirmation.":
    "UNKNOWN reconciliation not accepted ("+(result.reason||result.status)+"). No file changed.");
  return result;
}
async function recoverPreviousUnknownBySMB(saved,recovered,proof,listed){
  // Treat the verified SMB directory as the authority for REVIEW status.
  // Do not infer which process removed the file, and never invoke rm here.
  let raw,old;
  try{
    raw=preferences?.get(TEST_DELETE_JOURNAL_KEY);
    old=raw?JSON.parse(raw):null;
  }catch(_){return false;}
  if(!["UNKNOWN","ISSUED"].includes(old?.state) ||
     old.mountIdentity!==proof.binding ||
     SMBCheckpoint.stableRootIdentity(old.rootIdentity)!==
       SMBCheckpoint.stableRootIdentity(saved.rootIdentity) ||
     !Number.isInteger(old.cursor) || old.cursor<0 ||
     old.cursor>=saved.entries.length)return false;
  const index=old.cursor;
  const original=saved.entries[index],observed=recovered.entries[index];
  if(!["PENDING","MISSING","DELETED"].includes(original?.status) ||
     observed?.status!=="DELETED" ||
     listed.some(row=>row.filename===original.name))return false;
  const target=saved.root+"/"+original.name;
  try{
    const absent=await utils.exec("/usr/bin/stat",
      ["-f","%p|%d|%i|%z|%m",target]);
    if(!Number.isInteger(absent?.status)||absent.status===0)return false;
    const fresh=await testMountProbe(saved.root);
    if(!fresh.allowed || fresh.binding!==old.mountIdentity)return false;
    const root=await verifiedSMBRootIdentity(saved.root,fresh);
    if(SMBCheckpoint.stableRootIdentity(root)!==
       SMBCheckpoint.stableRootIdentity(old.rootIdentity))return false;
    if(!preferences.get(UNKNOWN_RECOVERY_BACKUP_KEY)){
      preferences.set(UNKNOWN_RECOVERY_BACKUP_KEY,raw);
      preferences.sync();
    }
    const resolved={...old,state:"RECOVERED_ABSENT"};
    preferences.set(TEST_DELETE_JOURNAL_KEY,JSON.stringify(resolved));
    preferences.sync();
    const persisted=JSON.parse(preferences.get(TEST_DELETE_JOURNAL_KEY)||"null");
    if(persisted?.id!==old.id || persisted.state!=="RECOVERED_ABSENT")
      throw Error("RECOVERY_WRITE_NOT_VERIFIED");
    const unknownJob=videoDeleteQueue?.snapshot().jobs.find(job=>
      job.status==="UNKNOWN" && job.root===saved.root &&
      job.index===index && job.path===target);
    if(unknownJob)videoDeleteQueue.reconcileUnknown(unknownJob.id,{
      verified:true,absent:true
    });
    debugLog.log("review.delete.unknown_resolved_by_smb",{
      cursor:index,reason:"verified_absent"
    });
    return true;
  }catch(_){
    debugLog.log("review.delete.unknown_recovery_skipped",{
      reason:"verification_or_storage_failed"
    },"warn");
    return false;
  }
}
// Crash after /bin/rm exit 0 but before the queue's DONE state was saved:
// use the old command journal plus *fresh* SMB absence and the committed
// Review checkpoint to reconcile the task without ever issuing rm again.
async function reconcileQueueExitZeroOnResume(recovered,proof,listed){
  const unknown=videoDeleteQueue?.snapshot().jobs.find(job=>
    job.status==="UNKNOWN" && job.root===recovered?.root);
  if(!unknown || recovered.entries[unknown.index]?.status!=="DELETED")
    return false;
  try{
    const old=JSON.parse(preferences?.get(TEST_DELETE_JOURNAL_KEY)||"null");
    if(old?.state!=="RM_EXIT_ZERO" || old.queueId!==unknown.id ||
       old.cursor!==unknown.index || old.mountIdentity!==proof.binding ||
       listed.some(row=>row.filename===unknown.name))return false;
    const stat=await utils.exec("/usr/bin/stat",[
      "-f","%p|%d|%i|%z|%m",unknown.path
    ]);
    if(!Number.isInteger(stat?.status)||stat.status===0)return false;
    const fresh=await testMountProbe(recovered.root);
    if(!fresh.allowed||fresh.binding!==proof.binding)return false;
    if(!videoDeleteQueue.reconcileUnknown(unknown.id,{verified:true,absent:true}))
      return false;
    debugLog.log("review.delete.queue.crash_reconciled",{index:unknown.index});
    return true;
  }catch(_){return false;}
}
function reviewResume(data){
  debugLog.log("review.resume.request");
  // Restored jobs are PAUSED / UNKNOWN and never automatically replayed.
  // Resume the verified Review source so an operator can inspect them.
  if(activeDeleteRequest){
    reportReview("An active delete worker must finish before Resume.");
    return;
  }
  // Delayed or duplicate Resume messages from a sidebar remount must not
  // clear an active queue or advance its durable checkpoint. An active
  // Review is already attached to IINA's current playback; its progress
  // is changed only by an explicit KEEP/Start/Exit action.
  if(reviewQueue?.active){
    debugLog.log("review.resume.skipped",{reason:"already_active"});
    reportReview();
    return;
  }
  if(reviewResumePending){
    debugLog.log("review.resume.skipped",{reason:"verification_in_progress"});
    return;
  }
  reviewResumePending=true;
  const resumeEpoch=reviewSessionEpoch;
  thumbnails.close();
  reviewQueue=null;
  reviewAwaitingLoad=false;
  if(SMBCheckpoint.hasPending(smbCheckpointRecord)){
    const record=smbCheckpointRecord;
    const requested=Nas.normalize(data?.path);
    if(!requested||requested!==record.root){
      reviewResumePending=false;
      debugLog.log("nas.review.resume.rejected",{reason:"source_mismatch"},"warn");
      reportReview("Resume blocked: select the original saved SMB folder.");
      return;
    }
    return (async()=>{
      try{
        const proof=await testMountProbe(requested);
        if(!proof.allowed||proof.binding!==record.mountBinding)
          throw Error("SMB_MOUNT_CHANGED");
        const rootIdentity=await verifiedSMBRootIdentity(requested,proof);
        const listed=record.recursive?
          await Scan.scanAsync(requested,dir=>file.list(dir),{
            recursive:true,maxFiles:20000,maxDirectories:5000,maxDepth:24
          }):
          Scan.scan(requested,dir=>file.list(dir));
        const recovered=SMBCheckpoint.reconcile(record,{
          root:requested,mountBinding:proof.binding,rootIdentity,listed
        });
        if(resumeEpoch!==reviewSessionEpoch){
          debugLog.log("nas.review.resume.skipped",{reason:"session_changed"});
          return;
        }
        const recoveredAbsent=recovered.entries.filter((row,i)=>
          row.status==="DELETED" &&
          ["PENDING","MISSING"].includes(record.entries[i]?.status)).length;
        if(recoveredAbsent){
          // Preserve the exact original durable snapshot before updating a
          // stale missing-file status. Never overwrite an older backup.
          try{
            if(!preferences?.get(SMB_RECOVERY_BACKUP_KEY)){
              const original=preferences?.get(SMB_CHECKPOINT_KEY);
              if(typeof original!=="string"||!original)
                throw Error("SMB_BACKUP_SOURCE_UNAVAILABLE");
              preferences.set(SMB_RECOVERY_BACKUP_KEY,original);
              preferences.sync();
            }
          }catch(_){
            throw Error("SMB_RECOVERY_BACKUP_UNAVAILABLE");
          }
        }
        // The last saved cursor is the user's Review progress. An UNKNOWN
        // task is independent; do not rewind the foreground Review cursor.
        // Manual reconciliation identifies the original video by job index.
        // A previous build may have saved a cursor pointing at a video
        // whose delete is still UNKNOWN/PAUSED. Keep that original job
        // intact but select an unrelated PENDING item for foreground Review.
        // Prefer the native already-loaded IINA video; never call core.open.
        const reserved=videoDeleteQueue?.pendingIndices(requested)||new Set();
        if(recovered.cursor>=0 && reserved.has(recovered.cursor)){
          const observed=currentPlayerPath();
          const observedIndex=observed &&
            observed===reviewLastLoadedPath?
            recovered.entries.findIndex((entry,index)=>
              entry.path===observed && entry.status==="PENDING" &&
              !reserved.has(index)):-1;
          const next=observedIndex>=0?observedIndex:
            nextAvailableReviewIndex(recovered,recovered.cursor,reserved);
          if(next>=0){
            debugLog.log("nas.review.resume.cursor_recentered",{
              from:recovered.cursor,to:next,
              matchedNative:observedIndex===next
            });
            recovered.cursor=next;
          }
        }
        if(!persistQueue(recovered)){
          reportReview("Resume blocked: cannot save the verified SMB Review.");
          return;
        }
        reviewQueue=recovered;
        reviewSessionEpoch++;
        reviewTextInputFocused=false;
        await recoverPreviousUnknownBySMB(record,recovered,proof,listed);
        await reconcileQueueExitZeroOnResume(recovered,proof,listed);
        // IINA owns native history/position. No implicit core.open here.
        debugLog.log("nas.review.resume.attached",{
          cursor:reviewQueue.cursor,
          kept:reviewQueue.entries.filter(x=>x.status==="KEEP").length,
          deleted:reviewQueue.entries.filter(x=>x.status==="DELETED").length
        });
        reportReview();
        // IINA may already have the matching video loaded before Review
        // reattaches, so there may be no new file-loaded event to observe.
        void thumbnails.prefetchCurrent();
      }catch(error){
        if(resumeEpoch!==reviewSessionEpoch)return;
        debugLog.log("nas.review.resume.rejected",{
          reason:/^SMB_/.test(String(error?.message))?
            String(error.message):"snapshot_unverified"
        },"warn");
        const reason=String(error?.message||"");
        const explanation=reason==="SMB_MOUNT_CHANGED"?
          "The saved SMB share is not mounted under the original identity.":
          reason==="SMB_SOURCE_CHANGED"?
          "The SMB mount or original directory identity changed.":
          reason==="SMB_INVENTORY_ADDED"?
          "New or unexpected video filenames were found in the saved folder.":
          reason==="SMB_ALL_PENDING_MISSING"?
          "No remaining pending video exists; the original checkpoint was retained for retry.":
          reason==="SMB_RECOVERY_BACKUP_UNAVAILABLE"?
          "The original Review checkpoint could not be backed up safely.":
          "The saved Review source or inventory could not be verified.";
        reportReview("SMB Resume blocked: "+explanation+
          " The saved KEEP progress was not overwritten.");
      }finally{
        reviewResumePending=false;
      }
    })();
  }
  if(!Session.hasPending(checkpointRecord)){
    reviewResumePending=false;
    reportReview("No valid unfinished Review checkpoint is available.");
    return;
  }
  const requested=typeof data?.path==="string"?data.path:"";
  const normalized=Review.normalizeRoot(requested);
  if(!normalized || normalized!==checkpointRecord.root){
    reviewResumePending=false;
    debugLog.log("review.resume.rejected",{reason:"source_mismatch"},"warn");
    reportReview("Resume blocked: select the original local fixture folder.");
    return;
  }
  try{
    const scanned=Scan.scan(normalized,dir=>file.list(dir),{
      recursive:checkpointRecord.recursive===true
    });
    const next=Session.reconcile(checkpointRecord,normalized,scanned);
    if(!persistQueue(next)){
      reportReview("Resume blocked: cannot save the recovered queue.");
      return;
    }
    reviewQueue=next;
    reviewSessionEpoch++;
    reviewTextInputFocused=false;
    if(!Review.current(reviewQueue)){
      reportReview("Saved Review has no pending item.");
      return;
    }
    // Review restores KEEP/cursor only. IINA owns opening history, seek
    // position, pause and audio/subtitle tracks. Never issue core.open/seek
    // during Resume; if the current player differs, KEEP remains blocked.
    const identity=inspectReviewPlayback();
    debugLog.log("review.resume.attached",{
      cursor:reviewQueue.cursor,matched:identity.matched,reason:identity.reason
    });
    reportReview();
  }catch(error){
    debugLog.log("review.resume.rejected",{reason:"snapshot_mismatch"},"warn");
    reportReview("Resume blocked: saved file list changed or could not be verified. Start a new Review instead.");
  }finally{
    reviewResumePending=false;
  }
}
function reviewDiscard(){
  if(activeDeleteRequest || videoDeleteQueue?.pendingCount()>0)return false;
  if(reviewResumePending){
    debugLog.log("review.checkpoint.discard_rejected",{reason:"resume_pending"},"warn");
    reportReview("Cannot discard progress while verifying the saved Review.");
    return false;
  }
  if(reviewQueue?.active){
    debugLog.log("review.checkpoint.discard_rejected",{reason:"session_active"},"warn");
    reportReview("Exit the active Review before discarding its checkpoint.");
    return false;
  }
  try{
    if(!preferences || typeof preferences.set!=="function" ||
       typeof preferences.sync!=="function")throw new Error("StorageUnavailable");
    const smb=SMBCheckpoint.hasPending(smbCheckpointRecord);
    preferences.set(smb?SMB_CHECKPOINT_KEY:CHECKPOINT_KEY,"");
    preferences.sync();
    if(smb){
      smbCheckpointRecord=null;
      smbCheckpointRevision=0;
    }else{
      checkpointRecord=null;
      checkpointRevision=0;
    }
    debugLog.log("review.checkpoint.discarded");
    reportReview();
    return true;
  }catch(error){
    debugLog.log("review.checkpoint.discard_failed",{errorName:error?.name||"Error"},"error");
    reportReview("Could not discard saved Review checkpoint.");
    return false;
  }
}

function registerManagedKShortcut(){
  // IINA dispatches input to the frontmost window. Never shadow a configured K
  // binding; no global hotkey is registered when the API cannot prove that.
  if(!input || typeof input.normalizeKeyCode!=="function" ||
     typeof input.getAllKeyBindings!=="function" ||
     typeof input.onKeyDown!=="function"){
    reviewKRegistration="IINA input API unavailable";
    debugLog.log("input.k.registration",{reason:"api_unavailable"},"warn");
    return;
  }
  try {
    // mpv uses CASE-SENSITIVE key names: "k" is plain k, "K" is Shift+k.
    const code=input.normalizeKeyCode("k");
    const bindings=input.getAllKeyBindings();
    if(!code || !bindings){
      reviewKRegistration="Cannot inspect IINA key bindings";
      debugLog.log("input.k.registration",{reason:"cannot_inspect"},"warn");
      return;
    }
    if(Object.prototype.hasOwnProperty.call(bindings,code)){
      reviewKRegistration="K already assigned in IINA; use Keep & Next button";
      debugLog.log("input.k.registration",{reason:"binding_conflict"},"warn");
      return;
    }
    input.onKeyDown("k",({isRepeat}={})=>{
      // HIGH runs before IINA's default handlers. In every non-Review state,
      // return false so the user's existing key behavior remains untouched.
      if(!reviewQueue?.active){
        debugLog.log("input.k.ignored",{reason:"session_inactive"});
        return false;
      }
      // Plain K is owned by the player input handler. The Plugin menu has
      // NO keyBinding: menu accelerators are processed before player input
      // and a registered-but-undelivered menu shortcut previously masked K.
      reviewKInputEvents++;
      debugLog.log("input.k.received",{source:"player",repeat:!!isRepeat});
      if(isRepeat){
        debugLog.log("input.k.ignored",{reason:"repeat"});
        reviewLastKResult="Repeat ignored";
        reportReview();return false;
      }
      if(reviewTextInputFocused){
        debugLog.log("input.k.ignored",{reason:"text_focus"});
        reviewLastKResult="Text field focused";
        reportReview();return false;
      }
      if(!isCurrentReviewPlayback() && !syncKToLoadedPendingVideo()){
        debugLog.log("input.k.ignored",{reason:"playback_mismatch"},"warn");
        reviewLastKResult="K received; current video does not match the Review item";
        reportReview();return false;
      }
      reviewLastKResult="Player K received; processing Keep";
      return reviewKeep();
    },input.PRIORITY_HIGH);
    reviewKShortcutEnabled=true;
    reviewKRegistration="IINA K listener registered (high priority, Review only)";
    debugLog.log("input.k.registration",{enabled:true,status:"high_priority"});
  } catch(error) {
    reviewKShortcutEnabled=false;
    reviewKRegistration="K registration failed ("+(error?.name||"Error")+")";
    debugLog.log("input.k.registration",{reason:"registration_error",errorName:error?.name||"Error"},"error");
    console.error("NAS Review: K shortcut unavailable ("+(error?.name||"Error")+")");
  }
}

// IINA dispatches keyboard input to the menu bar BEFORE input.onKeyDown.
// Keep the native menu item CLICK-ONLY. Do not install a keyBinding here,
// because it may swallow a physical plain K before player input receives it.
// The sole keyboard shortcut owner is input.onKeyDown; menu clicks remain
// a separate explicitly user-initiated action.
function registerNativeKMenu(){
  if(!reviewKShortcutEnabled || !menu ||
     typeof menu.item!=="function" || typeof menu.addItem!=="function" ||
     typeof menu.forceUpdate!=="function")return;
  try{
    const item=menu.item("Review: Keep & Next",()=>{
      // Never trust menu enabled state alone. IINA may deliver a queued
      // action after a source switch, or a stale menu accelerator.
      if(!reviewKMenuItem?.enabled || !reviewQueue?.active ||
         reviewTextInputFocused || !isCurrentReviewPlayback()){
        debugLog.log("input.k.menu_ignored",{reason:"session_or_playback_invalid"},"warn");
        return;
      }
      reviewKInputEvents++;
      debugLog.log("input.k.received",{source:"menu",repeat:false});
      reviewLastKResult="Native menu K received; processing Keep";
      reviewKeep();
    },{enabled:false});
    menu.addItem(item);
    reviewKMenuItem=item;
    reviewKRegistration="Player plain K via high-priority input; native menu click also available";
    debugLog.log("input.k.menu_registered",{enabled:true});
    syncNativeKMenu();
  }catch(error){
    reviewKMenuItem=null;
    debugLog.log("input.k.menu_unavailable",{
      reason:"registration_failed",errorName:error?.name||"Error"
    },"warn");
  }
}
function syncNativeKMenu(){
  if(!reviewKMenuItem)return;
  const enabled=!!reviewQueue?.active && !reviewTextInputFocused &&
    isCurrentReviewPlayback() && !queuedDeleteIndices().has(reviewQueue.cursor);
  if(reviewKMenuItem.enabled===enabled)return;
  try{
    reviewKMenuItem.enabled=enabled;
    menu.forceUpdate();
    debugLog.log("input.k.menu_state",{enabled});
  }catch(_){
    // A failed native menu update must not change Review business state.
    reviewKMenuItem.enabled=false;
    debugLog.log("input.k.menu_unavailable",{reason:"update_failed"},"warn");
  }
}
function syncNativeDMenu(){
  if(!reviewDMenuItem)return;
  const target=playingReviewDeleteTarget();
  const enabled=!!target && !videoDeleteQueue?.blocked() &&
    !queuedDeleteIndices().has(target.index);
  if(reviewDMenuItem.enabled===enabled)return;
  try{
    reviewDMenuItem.enabled=enabled;
    menu.forceUpdate();
    debugLog.log("input.d.menu_state",{enabled});
  }catch(_){
    reviewDMenuItem.enabled=false;
    debugLog.log("input.d.menu_unavailable",{reason:"update_failed"},"warn");
  }
}
function registerDShortcut(){
  // D is an explicit request to the safe coordinator, never direct delete.
  // Preserve existing user key bindings and normal non-Review input handling.
  if(!input || typeof input.normalizeKeyCode!=="function" ||
     typeof input.getAllKeyBindings!=="function")return;
  try{
    // Likewise, "d" is plain d and "D" requires Shift.
    const key=input.normalizeKeyCode("d");
    const bindings=input.getAllKeyBindings();
    if(!key || !bindings || Object.prototype.hasOwnProperty.call(bindings,key)){
      debugLog.log("input.d.unavailable",{reason:"binding_conflict"},"warn");
      return;
    }
    if(typeof input.onKeyDown==="function"){
      input.onKeyDown("d",({isRepeat}={})=>{
        if(isRepeat || !playingReviewDeleteTarget())return false;
        debugLog.log("input.d.received",{source:"player"});
        reviewDelete();
        return true;
      },input.PRIORITY_HIGH);
      debugLog.log("input.d.registration",{enabled:true,status:"high_priority"});
    }
    if(menu && typeof menu.item==="function" &&
       typeof menu.addItem==="function" && typeof menu.forceUpdate==="function"){
      const item=menu.item("Review: Request Permanent Delete…",()=>{
        if(!reviewDMenuItem?.enabled || !playingReviewDeleteTarget())return;
        debugLog.log("input.d.received",{source:"menu"});
        reviewDelete();
      },{enabled:false});
      menu.addItem(item);
      reviewDMenuItem=item;
      debugLog.log("input.d.menu_registered",{enabled:true});
      syncNativeDMenu();
    }
  }catch(error){
    debugLog.log("input.d.unavailable",{
      reason:"registration_failed",errorName:error?.name||"Error"
    },"warn");
  }
}

event.on("iina.window-loaded", () => {
  debugLog.log("plugin.window_loaded");
  // Revisit only cleanup jobs from earlier confirmed rm exit-0 operations.
  // This never attempts any SMB unlink and does not touch IINA thumb_cache.
  void cacheCleanupQueue.resume();
  sidebar.loadFile("dist/ui/sidebar/index.html");
  debugLog.log("plugin.sidebar.load_requested");
  showPluginSidebar();

  sidebar.onMessage("get-files", (data) => {
    const { path, currentPath, tabId } = data;
    try {
      let files = file.list(currentPath).filter((f) => {
        if (FILENAME_BLACKLIST.indexOf(f.filename) !== -1) {
          return false;
        }
        if (f.isDir) {
          return true;
        }
        let extension = Path.extname(f.filename).toLowerCase();
        return extension && VIDEO_EXTENSIONS.indexOf(extension.substring(1)) !== -1;
      });
      files.sort((a, b) => {
        if (a.isDir && !b.isDir) {
          return -1;
        } else if (!a.isDir && b.isDir) {
          return 1;
        } else {
          return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
        }
      });
      for (let file of files) {
        file.path = Path.join(currentPath, file.path);
      }
      if (path !== currentPath) {
        files.unshift({
          filename: "..",
          path: Path.join(currentPath, ".."),
          isDir: true,
        });
      }
      sidebar.postMessage("files-list", {
        path: currentPath,
        tabId,
        files
      });
      debugLog.log("viewer.files.listed",{total:files.length});
    } catch (err) {
      debugLog.log("viewer.files.error",{errorName:err?.name||"Error"},"error");
      console.error("NAS Review: unable to list directory ("+(err?.name||"Error")+")");
    }
  });

  sidebar.onMessage("open-file", (data) => {
    debugLog.log("viewer.open.request");
    thumbnails.close();
    core.open(data.path);
    showPluginSidebar();
  });

  sidebar.onMessage("choose-folder", () => {
    utils.chooseFile("Choose a folder", {
      chooseDir: true,
      allowedFileTypes: []
    }).then(path => {
      if (path) {
        sidebar.postMessage("selected-folder", path);
      }
    });
  });

  sidebar.onMessage("ask", (data) => {
    utils.ask('test:' + data);
  });

  // Additive non-destructive review commands; original File Viewer navigation
  // and file playback handlers above are preserved.
  sidebar.onMessage("review-start", reviewStart);
  sidebar.onMessage("review-nas-backup-enable",setNASBackupEnabled);
  sidebar.onMessage("review-nas-backup-import",importNASBackup);
  sidebar.onMessage("review-window",data=>{
    // This is a read-only view into the already scanned Review queue. No
    // listing, cursor mutation, filesystem operations, or checkpoint writes.
    if(!reviewQueue ||
       !(reviewQueue.active || reviewPhase("",reviewQueue)==="COMPLETE") ||
       reviewQueue.nasReadOnly!==true ||
       !Number.isSafeInteger(data?.sessionEpoch) ||
       data.sessionEpoch!==reviewSessionEpoch ||
       !Number.isSafeInteger(data?.requestId) ||
       data.requestId<1||data.requestId>1000000000 ||
       !Number.isSafeInteger(data?.start)||data.start<0 ||
       (data.count!==undefined&&data.count!==REVIEW_WINDOW_SIZE))return;
    const total=reviewQueue.entries.length;
    const start=Math.max(0,Math.min(data.start,
      Math.max(0,total-REVIEW_WINDOW_SIZE)));
    sidebar.postMessage("review-window-data",{
      requestId:data.requestId,sessionEpoch:reviewSessionEpoch,
      viewRevision:smbCheckpointRevision,
      windowStart:start,totalCount:total,
      entries:reviewQueue.entries.slice(start,start+REVIEW_WINDOW_SIZE)
        .map(({name,status},i)=>({name,status,position:start+i}))
    });
  });
  sidebar.onMessage("review-play",reviewPlay);
  sidebar.onMessage("review-delete",reviewDelete);
  sidebar.onMessage("review-resume-paused-deletes",async()=>{
    if(!videoDeleteQueue)return;
    const outcome=await videoDeleteQueue.resumePaused();
    reportReview(outcome.accepted?
      "Previously unissued deletion jobs resumed after explicit confirmation.":
      "Cannot resume deletion jobs ("+(outcome.reason||"unavailable")+").");
  });
  sidebar.onMessage("directory-mode",setDirectoryMode);
  sidebar.onMessage("directory-delete",requestDirectoryDelete);
  sidebar.onMessage("directory-delete-reconcile",reconcileDirectoryDelete);
  sidebar.onMessage("review-delete-confirmation-setting",setSkipDeleteConfirmation);
  sidebar.onMessage("review-delete-test-acknowledge-unknown",reviewAcknowledgeUnknown);
  sidebar.onMessage("review-thumbnails-toggle",()=>thumbnails.toggle());
  sidebar.onMessage("review-reopen",reviewReopen);
  sidebar.onMessage("review-resume",reviewResume);
  sidebar.onMessage("review-discard",reviewDiscard);
  sidebar.onMessage("review-keep", data=>{
    debugLog.log("review.keep.request",{source:data?.source==="sidebar-key"?"sidebar":"button"});
    if(data?.source==="sidebar-key")reviewLastKResult="Sidebar K received; processing Keep";
    return reviewKeep();
  });
  sidebar.onMessage("review-input-focus",data=>{
    reviewTextInputFocused=data?.focused===true;
    debugLog.log("review.input.focus",{focused:reviewTextInputFocused});
    syncNativeKMenu();
    syncNativeDMenu();
  });
  sidebar.onMessage("review-exit", () => {
    if(activeDeleteRequest || videoDeleteQueue?.pendingCount()>0){
      debugLog.log("review.exit.blocked",{reason:"delete_in_flight"},"warn");
      reportReview("Deletion is in progress. Wait for its result before exiting Review.");
      return false;
    }
    debugLog.log("review.exit");
    thumbnails.close();
    nasProbePending=false;
    nasProbeRevision++;
    reviewQueue=null;
    reviewSessionEpoch++;
    reviewAwaitingLoad=false;
    reviewTextInputFocused=false;
    reportReview();
  });
  sidebar.onMessage("review-ready", () => {
    showPluginSidebar();
    if(nasBackupEnabled()&&smbCheckpointRecord)scheduleNASBackup();
    // The first sidebar load may precede Finder re-mounting the SMB share.
    // Retry only on another explicit sidebar-ready handshake; never poll
    // or rewrite a failed checkpoint. Concurrent attempts remain coalesced.
    if(hasPendingCheckpoint() && !reviewQueue?.active && !reviewResumePending){
      const record=SMBCheckpoint.hasPending(smbCheckpointRecord)?
        smbCheckpointRecord:checkpointRecord;
      debugLog.log("review.resume.auto_attempt",{source:record===smbCheckpointRecord?"smb":"local"});
      return reviewResume({path:record.root,automatic:true});
    }
    reportReview();
  });
  sidebar.onMessage("debug-ready",()=>sidebar.postMessage("debug-snapshot",debugLog.snapshot()));
  sidebar.onMessage("debug-clear",()=>debugLog.clear());
  registerManagedKShortcut();
  registerNativeKMenu();
  registerDShortcut();
  thumbnails.register();
});

event.on("iina.window-will-close",()=>{
  thumbnails.close();
});
// IINA can collapse its native sidebar as part of the fullscreen layout
// transition, AFTER the initial show() call. Reassert on the documented
// fullscreen event with a bounded post-transition follow-up, never polling.
event.on("iina.window-fs.changed",(fullscreen)=>{
  const epoch=++sidebarFullscreenEpoch;
  debugLog.log("plugin.sidebar.fullscreen_changed",{enabled:fullscreen===true});
  if(fullscreen!==true){
    showPluginSidebar();
    return;
  }
  // Two one-shot layout phases cover both immediate and animated fullscreen.
  // Stale callbacks from an obsolete transition are ignored.
  for(const ms of [120,850]){
    setTimeout(()=>{
      if(epoch!==sidebarFullscreenEpoch)return;
      showPluginSidebar();
    },ms);
  }
});
event.on("iina.file-loaded", () => {
  keepOnVerifiedNextFileLoad(currentPlayerPath());
  thumbnails.onFileLoaded();
  reviewProgressPrevious=null;
  reviewTerminal=null;
  reviewSeekIntent=null;
  reviewFileLoadedBaseline=null;
  reviewLastLoadedPath=currentPlayerPath()||"";
  const identity=inspectReviewPlayback();
  if(reviewQueue?.active && reviewAwaitingLoad && identity.matched){
    reviewAwaitingLoad=false;
    debugLog.log("review.playback.ready",{cursor:reviewQueue.cursor});
  }
  const loadedForSeek=loadedPendingReview();
  const startPosition=core.status?.position;
  const startDuration=core.status?.duration;
  if(loadedForSeek && Number.isFinite(startPosition) &&
     Number.isFinite(startDuration) && startDuration>0 &&
     startPosition<=startDuration-Math.max(4,startDuration*0.04))
    reviewFileLoadedBaseline={token:loadedForSeek.token,
      position:startPosition,duration:startDuration};
  debugLog.log("player.file_loaded",{
    active:!!reviewQueue?.active,
    matched:identity.matched,reason:identity.reason
  },reviewQueue?.active && !identity.matched?"warn":"info");
  sidebar.postMessage("playing-file", core.status.url);
  showPluginSidebar();
  if(reviewQueue?.entries?.length)reportReview();
});
// Some IINA builds publish the duration after file-loaded. Start the same
// guarded prefetch once the real duration is available; repeated notifications
// reuse the current prefetch rather than dispatching duplicate FFmpeg work.
event.on("mpv.duration.changed",()=>{
  void thumbnails.prefetchCurrent();
});
// mpv's seek event is observable even when seeking exactly to 100%
// immediately unloads the file and prevents a time-pos.changed callback.
event.on("mpv.seek",()=>{
  const loaded=loadedPendingReview();
  if(!loaded || currentPlayerPath()!==reviewLastLoadedPath){
    reviewSeekIntent=null;return;
  }
  const duration=core.status?.duration;
  const current=core.status?.position;
  const last=reviewProgressPrevious?.token===loaded.token?
    reviewProgressPrevious.position:null;
  const baseline=reviewFileLoadedBaseline?.token===loaded.token?
    reviewFileLoadedBaseline.position:null;
  if(!Number.isFinite(duration) || duration<=0 ||
     !Number.isFinite(current)){reviewSeekIntent=null;return;}
  const tailTolerance=Math.min(3,Math.max(2,duration*0.005));
  const minJump=Math.max(3,Math.min(15,duration*0.03));
  const prior=seekIntentForLoaded(loaded);
  // IINA's cached status can lag behind the seek it just reported. The live
  // mpv property is an independent destination candidate; both are bounded
  // to this loaded item and never used to open or delete media.
  const livePosition=readMpvPositionSeconds();
  const progressClass=current>=duration-tailTolerance?"tail":
    current>=duration-Math.max(5,duration*0.02)?"near_tail":"before_tail";
  // Real IINA may emit a series of seek callbacks while users advance toward
  // the end, with no corresponding time-pos callbacks. Preserve the first
  // observed starting position instead of resetting it on every seek.
  if(prior && Math.abs(prior.duration-duration)<=Math.max(1,duration*0.01) &&
     current>=prior.from-1 && current<=duration+1){
    if(current>=duration-tailTolerance &&
       current-prior.from>=minJump && !reviewTextInputFocused &&
       reviewLastEOFToken!==loaded.token){
      reviewLastEOFToken=loaded.token;
      debugLog.log("review.auto_keep.cumulative_seek_tail",{cursor:loaded.index});
      if(keepAndAdvanceReview(loaded.index)){
        reviewSeekIntent=null;return;
      }
      reviewLastEOFToken="";
    }
    const latestDestination=Number.isFinite(livePosition)?livePosition:current;
    const priorPeak=Number.isFinite(prior.peak)?prior.peak:
      (Number.isFinite(prior.toProbe)?prior.toProbe:prior.to);
    reviewSeekIntent={...prior,at:Date.now(),to:current,
      toProbe:livePosition,seq:++reviewObservationSeq,
      peak:Math.max(Number.isFinite(priorPeak)?priorPeak:latestDestination,
        latestDestination)};
    debugLog.log("review.seek.observed",{cursor:loaded.index,
      progressClass,sequence:"continuing"});
    return;
  }
  // mpv can publish the destination before the seek callback. Do not treat
  // a 100%-position observation as proof of a starting point.
  const start=current>=duration-tailTolerance?
    (Number.isFinite(last)?last:baseline):current;
  if(!Number.isFinite(start) ||
     start>duration-Math.max(4,duration*0.04)){
    reviewSeekIntent=null;return;
  }
  reviewSeekIntent={token:loaded.token,from:start,duration,at:Date.now(),
    to:current,toProbe:livePosition,seq:++reviewObservationSeq,
    peak:Number.isFinite(livePosition)?livePosition:current};
  debugLog.log("review.seek.observed",{cursor:loaded.index,
    progressClass,sequence:"start"});
});
// mpv may complete a seek while paused, or restart playback without an
// intervening time-pos event. Both callbacks share the same guarded check.
function reviewSeekDestination(source){
  const loaded=loadedPendingReview();
  const intent=seekIntentForLoaded(loaded);
  if(!intent || currentPlayerPath()!==reviewLastLoadedPath)return;
  const position=core.status?.position,duration=core.status?.duration;
  if(!Number.isFinite(position) || !Number.isFinite(duration) ||
     duration<=0)return;
  const tailTolerance=Math.min(3,Math.max(2,duration*0.005));
  const minJump=Math.max(3,Math.min(15,duration*0.03));
  if(position>=duration-tailTolerance && position<=duration+1 &&
     position-intent.from>=minJump && !reviewTextInputFocused &&
     reviewLastEOFToken!==loaded.token){
    reviewLastEOFToken=loaded.token;
    debugLog.log("review.auto_keep.seek_destination",{
      cursor:loaded.index,source});
    if(keepAndAdvanceReview(loaded.index)){reviewSeekIntent=null;return;}
    reviewLastEOFToken="";
  }
  if(position<duration-tailTolerance &&
     Math.abs(position-intent.from)>Math.max(3,duration*0.01))
    reviewSeekIntent=null;
}
event.on("mpv.playback-restart",()=>reviewSeekDestination("playback_restart"));
event.on("mpv.seeking.changed",()=>{
  try{
    if(mpv?.getFlag("seeking")===false)
      reviewSeekDestination("seeking_complete");
  }catch(_){}
});
event.on("mpv.time-pos.changed",()=>{
  const loaded=loadedPendingReview();
  // Only the currently loaded media can establish progress evidence; a
  // cleared URL is accepted by reviewEOF, never by this progress observer.
  if(!loaded || currentPlayerPath()!==reviewLastLoadedPath)return;
  const position=core.status?.position,duration=core.status?.duration;
  if(!Number.isFinite(position) || !Number.isFinite(duration) || duration<=0)return;
  const {token}=loaded;
  const previous=reviewProgressPrevious?.token===token?
    reviewProgressPrevious:null;
  const delta=previous?position-previous.position:0;
  const seekIntent=seekIntentForLoaded(loaded);
  const beganBeforeTail=seekIntent &&
    seekIntent.from<=duration-Math.max(4,duration*0.04);
  // Explicitly scrubbing a loaded Review video to its final seconds is a
  // Keep decision even when no native EOF is dispatched (also while paused).
  // Require a real jump from a prior observed position, not a resume at the
  // end, a tiny normal tick, or a seek into the middle of the timeline.
  const tailTolerance=Math.min(3,Math.max(2,duration*0.005));
  const minJump=Math.max(3,Math.min(15,duration*0.03));
  const movedFromEarlier=previous && previous.duration>0 &&
    Math.abs(previous.duration-duration)<=Math.max(1,duration*0.01) &&
    previous.position<=duration-Math.max(4,duration*0.04);
  if(((movedFromEarlier && delta>=minJump) ||
      (beganBeforeTail && position-seekIntent.from>=minJump)) &&
     position>=duration-tailTolerance && position<=duration+1 &&
     reviewLastEOFToken!==token && !reviewTextInputFocused){
    reviewLastEOFToken=token;
    debugLog.log("review.auto_keep.seek_tail",{cursor:loaded.index});
    if(keepAndAdvanceReview(loaded.index)){
      reviewSeekIntent=null;
      return;
    }
    reviewLastEOFToken="";
  }
  const paused=core.status?.paused===true;
  // Any forward sample inside the terminal region counts. Dragging to the end
  // produces one large jump rather than steady playback, and the exact
  // next-item transition is the independent proof that the item ended.
  if(previous && !paused && delta>0 &&
     position>=duration-Math.max(5,duration*0.01)){
    if(reviewTerminal?.token!==token)
      debugLog.log("review.terminal.observed",{
        source:"played",
        actualSeconds:Math.round(position*10)/10,
        targetSeconds:Math.round(duration*10)/10
      });
    reviewTerminal={token,at:Date.now(),position,duration,source:"played",
      seq:++reviewObservationSeq};
    reviewRetreatedToken="";
  }
  // Leaving the terminal region while playing invalidates the evidence. A
  // paused or zero-position sample from IINA's EOF unload must NOT, because
  // that is the normal last event of a genuinely finished video.
  const explicitRetreat=reviewTerminal?.token===token &&
    reviewSeekIntent?.token===token &&
    (reviewSeekIntent.seq||0)>(reviewTerminal.seq||0);
  if(previous && !paused && (position>0 || explicitRetreat) &&
     position<duration-Math.max(10,duration*0.02)){
    reviewTerminal=null;
    reviewRetreatedToken=token;
  }
  reviewProgressPrevious={token,position,duration,at:Date.now(),
    paused:core.status?.paused===true};
  // A real intermediate seek destination invalidates the terminal intent.
  // Ignore stale position ticks equal to the pre-seek position.
  if(seekIntent && position<duration-tailTolerance &&
     Math.abs(position-seekIntent.from)>Math.max(3,duration*0.01))
    reviewSeekIntent=null;
});
event.on("mpv.eof-reached.changed",()=>{
  try{
    if(mpv?.getFlag("eof-reached")===true)reviewEOF("mpv_eof");
  }catch(_){
    debugLog.log("review.auto_keep.unavailable",{reason:"eof_property_unavailable"},"warn");
  }
});
event.on("mpv.end-file",(data)=>{
  if(!data?.reason){
    debugLog.log("review.end_file.reason_unavailable");
    // IINA's callback has no end-file payload. Never assume unknown==EOF;
    // only use mpv's independent, explicitly true terminal property.
    try{
      if(mpv?.getFlag("eof-reached")===true)reviewEOF("mpv_eof");
    }catch(_){}
    reviewEndFilePositionProbe();
  }
  // stop, error, quit, redirect are never valid completion evidence.
  // The IINA event API may omit payload; eof-reached.changed is the
  // independent completion signal in those builds.
  if(data?.reason==="eof")reviewEOF("end_file_eof");
  else if(data?.reason && data.reason!=="eof"){
    reviewSeekIntent=null;
    reviewProgressPrevious=null;
    reviewTerminal=null;
  }
});
