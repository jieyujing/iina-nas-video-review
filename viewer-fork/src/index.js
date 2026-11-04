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
const Nas = require("./nas-source.cjs");
const Scan = require("./review-scan.cjs");
const {createDeleteCoordinator}=require("./delete-coordinator.cjs");
const {createExperimentalDelete}=require("./experimental-delete.cjs");
const {createThumbnailOverlay}=require("./thumbnail-overlay.cjs");
const {createThumbnailGenerator}=require("./thumbnail-generator.cjs");
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
let reviewProgressPrevious=null;
let reviewProgressWitness="";
const CHECKPOINT_KEY="nasReviewCheckpointV1";
const SMB_CHECKPOINT_KEY="nasSMBReviewCheckpointV1";
const SMB_RECOVERY_BACKUP_KEY="nasSMBReviewRecoveryBackupV1";
const UNKNOWN_RECOVERY_BACKUP_KEY="nasDeleteUnknownRecoveryBackupV1";
const DELETE_JOURNAL_KEY="nasDeleteJournalV1";
const TEST_DELETE_JOURNAL_KEY="nasExperimentalDeleteJournalV1";
// Keep the established journal key so UNKNOWN transactions survive upgrades.
const deleteProcessNonce=String(Date.now())+"-"+Math.random().toString(36).slice(2);
let checkpointRecord=null;
let checkpointRevision=0;
let smbCheckpointRecord=null;
let smbCheckpointRevision=0;
let startupResumeAttempted=false;
let reviewResumePending=false;
let nasProbePending=false;
let nasProbeRevision=0;
// Snapshot the actual playing Review item only for the duration of an
// explicitly requested D transaction. A successful rm can unload its player.
let activeDeleteRequest=null;
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

const previewGenerator=createThumbnailGenerator({
  utils,file,log:(event,data,level)=>debugLog.log(event,data,level)
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
  let deleteRecoveryPending=false;
  try{
    const raw=preferences?.get(TEST_DELETE_JOURNAL_KEY);
    deleteRecoveryPending=!!raw &&
      ["UNKNOWN","ISSUED"].includes(JSON.parse(raw)?.state);
  }catch(_){/* Do not expose malformed storage records in the sidebar. */}
  const queue=reviewQueue;
  const identity=inspectReviewPlayback();
  const totalCount=queue?.entries?.length||0;
  // Presentation only: point the sidebar at the media IINA is displaying,
  // even when it differs from the pending Review cursor (e.g. replayed KEEP).
  // This does not change the queue cursor, KEEP or delete authorization.
  const displayedPath=currentPlayerPath();
  const playingPosition=displayedPath&&queue?.entries?.length?
    queue.entries.findIndex(entry=>entry.path===displayedPath):-1;
  const keptCount=queue?.entries?.filter(e=>e.status==="KEEP").length||0;
  const deletedCount=queue?.entries?.filter(e=>e.status==="DELETED").length||0;
  const missingCount=queue?.entries?.filter(e=>e.status==="MISSING").length||0;
  // A full NAS queue may contain many thousands of files. Center the window
  // on IINA's actual video, falling back to the pending Review cursor; never
  // send all 20k filenames or mutate the queue just to scroll the UI.
  const windowSize=queue?.nasReadOnly===true?120:totalCount;
  const windowAnchor=playingPosition>=0?playingPosition:Math.max(0,queue?.cursor??0);
  const windowStart=totalCount>windowSize?
    Math.max(0,Math.min(windowAnchor-Math.floor(windowSize/2),
      totalCount-windowSize)):0;
  sidebar.postMessage("review-state", {
    phase:reviewPhase(error,queue),
    playbackMatched:identity.matched && !reviewAwaitingLoad,
    deletePlaybackReady:!!playingReviewDeleteTarget(),
    playbackStatus:reviewAwaitingLoad && identity.matched?
      "awaiting_file_loaded":identity.reason,
    root:queue?.root || "",
    cursor:queue?.cursor ?? -1,
    playingPosition,
    active:!!queue?.active,
    nasReadOnly:queue?.nasReadOnly===true,
    recursive:queue?.recursive===true,
    deletionSupported:queue?.active===true && queue?.nasReadOnly===true,
    deleteRecoveryPending,
    totalCount,keptCount,deletedCount,missingCount,windowStart,
    entries:queue?.entries?.slice(windowStart,windowStart+windowSize)
      .map(({name,status},i)=>({name,status,position:windowStart+i})) || [],
    kShortcutEnabled:reviewKShortcutEnabled,
    kRegistration:reviewKRegistration,
    kInputEvents:reviewKInputEvents,
    lastKResult:reviewLastKResult,
    resumeAvailable:hasPendingCheckpoint(),
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
  if(index<0)return false;
  const next={...reviewQueue,entries:reviewQueue.entries.map(x=>({...x}))};
  if(!Review.select(next,index) || !persistQueue(next))return false;
  reviewQueue=next;
  thumbnails.close();
  reviewProgressPrevious=null;
  reviewProgressWitness="";
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
  reviewAwaitingLoad=!!current;
  thumbnails.close();
  debugLog.log("review.delete.verified",{cursor:reviewQueue.cursor});
  reportReview();
  if(current){
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
  if(!reviewQueue?.active || reviewQueue.nasReadOnly!==true ||
     reviewQueue.root!==current?.root ||
     Review.current(reviewQueue)?.path!==path ||
     Review.current(reviewQueue)?.status!=="PENDING")return false;
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
  const current=Review.current(reviewQueue);
  if(!reviewQueue?.active || !current || current.path!==path ||
     current.status!=="PENDING" || reviewQueue.cursor!==cursor)
    throw Error("ReviewChanged");
  const candidate={...reviewQueue,entries:reviewQueue.entries.map(e=>({...e}))};
  const {changed}=Review.advance(candidate,"DELETED");
  if(!changed || !persistQueue(candidate))
    throw Error("MissingProgressNotPersisted");
  reviewQueue=candidate;
  reviewAwaitingLoad=false;
  thumbnails.close();
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
    const playing=playingReviewDeleteTarget();
    const selected=activeDeleteRequest||playing;
    const item=selected?reviewQueue?.entries?.[selected.index]:
      reviewQueue&&Review.current(reviewQueue);
    return {root:reviewQueue?.root,path:item?.path,
      cursor:selected?.index??reviewQueue?.cursor,
      queueCursor:reviewQueue?.cursor,queueRevision:smbCheckpointRevision,
      active:reviewQueue?.active===true,
      matched:!!playing && !!selected && playing.path===selected.path &&
        playing.index===selected.index,
      nasReadOnly:reviewQueue?.nasReadOnly===true,recursive:reviewQueue?.recursive===true,
      mountBinding:reviewQueue?.nasBinding,
      queueId:deleteProcessNonce+":"+reviewSessionEpoch};
  },
  mountProbe:testMountProbe,
  stat:testStat,
  confirm:({name})=>utils.ask(
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
  deletePath:async path=>{
    // utils.exec uses executable + argv (no shell). The coordinator has
    // already verified SMB mount, each target path component, file identity, native
    // per-file confirmation and persisted the ISSUED journal. This is still
    // non-atomic pathname deletion, not an identity-conditional SMB2 unlink.
    if(typeof utils?.exec!=="function")throw new Error("DeleteExecUnavailable");
    let outcome;
    try{outcome=await utils.exec("/bin/rm",["--",path]);}
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
  onDeleted:onReviewDeleted
});
function reviewStart(data){
  debugLog.log("review.start.request");
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
  const candidate={
    ...reviewQueue,entries:reviewQueue.entries.map(item=>({...item}))
  };
  const {current}=Review.keepAndAdvance(candidate);
  // Persist the KEEP decision before opening the next video. No in-memory
  // decision is committed if IINA's preferences sync fails.
  if(!persistQueue(candidate)){
    reportReview("Could not save KEEP. The current review item was not changed.");
    return false;
  }
  reviewQueue=candidate;
  reviewAwaitingLoad=!!current;
  thumbnails.close();
  debugLog.log("review.keep.accepted",{
    kept:reviewQueue.entries.filter(entry=>entry.status==="KEEP").length,
    next:!!current
  });
  if(!current)debugLog.log("review.completed",{
    kept:reviewQueue.entries.filter(x=>x.status==="KEEP").length
  });
  reportReview();
  if(current){
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
function reviewEOF(source){
  const item=reviewQueue&&Review.current(reviewQueue);
  if(!item || !isCurrentReviewPlayback())return false;
  const duration=core.status?.duration;
  const position=core.status?.position;
  if(!Number.isFinite(duration) || duration<=0 ||
     !Number.isFinite(position) || position<duration-Math.max(0.5,duration*0.005)){
    debugLog.log("review.auto_keep.ignored",{reason:"not_near_end"});
    return false;
  }
  const token=reviewSessionEpoch+":"+reviewQueue.cursor+":"+item.name;
  // The eof-reached property also changes after seek-to-end. Require
  // recently observed steady playback when the event has no EOF reason.
  if(source==="mpv_eof" && reviewProgressWitness!==token){
    debugLog.log("review.auto_keep.ignored",{reason:"natural_progress_unverified"});
    return false;
  }
  if(reviewLastEOFToken===token)return false;
  reviewLastEOFToken=token;
  debugLog.log("review.auto_keep.eof",{source});
  const accepted=reviewKeep();
  if(!accepted)reviewLastEOFToken="";
  return accepted;
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
    if(nas)activeDeleteRequest=null;
  }
}
async function reviewAcknowledgeUnknown(){
  const result=await smbDelete.acknowledgeUnknown();
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
function reviewResume(data){
  debugLog.log("review.resume.request");
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
        if(!persistQueue(recovered)){
          reportReview("Resume blocked: cannot save the verified SMB Review.");
          return;
        }
        reviewQueue=recovered;
        reviewSessionEpoch++;
        reviewTextInputFocused=false;
        await recoverPreviousUnknownBySMB(record,recovered,proof,listed);
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
    isCurrentReviewPlayback();
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
  const enabled=!!playingReviewDeleteTarget();
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
  sidebar.onMessage("review-play",reviewPlay);
  sidebar.onMessage("review-delete",reviewDelete);
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
    if(!startupResumeAttempted && hasPendingCheckpoint() && !reviewQueue?.active){
      startupResumeAttempted=true;
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
  thumbnails.onFileLoaded();
  reviewProgressPrevious=null;
  reviewProgressWitness="";
  reviewLastLoadedPath=currentPlayerPath()||"";
  const identity=inspectReviewPlayback();
  if(reviewQueue?.active && reviewAwaitingLoad && identity.matched){
    reviewAwaitingLoad=false;
    debugLog.log("review.playback.ready",{cursor:reviewQueue.cursor});
  }
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
event.on("mpv.time-pos.changed",()=>{
  if(!reviewQueue?.active || !isCurrentReviewPlayback() ||
     core.status?.paused===true)return;
  const item=Review.current(reviewQueue);
  const position=core.status?.position,duration=core.status?.duration;
  if(!item || !Number.isFinite(position) || !Number.isFinite(duration) ||
     duration<=0)return;
  const token=reviewSessionEpoch+":"+reviewQueue.cursor+":"+item.name;
  if(reviewProgressPrevious?.token===token){
    const delta=position-reviewProgressPrevious.position;
    if(delta>0 && delta<=Math.max(3,duration*0.005) &&
       position>=duration-Math.max(5,duration*0.01))
      reviewProgressWitness=token;
    if(delta<0 || delta>Math.max(3,duration*0.005))
      reviewProgressWitness="";
  }
  reviewProgressPrevious={token,position};
});
event.on("mpv.eof-reached.changed",()=>{
  try{
    if(mpv?.getFlag("eof-reached")===true)reviewEOF("mpv_eof");
  }catch(_){
    debugLog.log("review.auto_keep.unavailable",{reason:"eof_property_unavailable"},"warn");
  }
});
event.on("mpv.end-file",(data)=>{
  // stop, error, quit, redirect are never valid completion evidence.
  // The IINA event API may omit payload; eof-reached.changed is the
  // independent completion signal in those builds.
  if(data?.reason==="eof")reviewEOF("end_file_eof");
});
