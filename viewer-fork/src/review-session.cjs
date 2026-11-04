"use strict";
/**
 * Read-only development checkpoint. Never use this evidence to authorize
 * destructive actions, source identity, or media-file replacement decisions.
 */
const Review=require("./review-core.cjs");
const VERSION=4;
const LEGACY_VERSION=1;
const QUEUE_ONLY_V2=2;
const QUEUE_ONLY_V3=3;
const MAX_BYTES=256000;
const MAX_ENTRIES=1000;
const MAX_AGE_MS=7*86400000;
function validLegacyPlayback(p){
  return !!p && typeof p==="object" &&
    typeof p.positionSec==="number" && Number.isFinite(p.positionSec) &&
    p.positionSec>=0 && p.positionSec<=86400 &&
    typeof p.paused==="boolean" &&
    (p.audioTrack===null||(Number.isInteger(p.audioTrack)&&p.audioTrack>=0&&p.audioTrack<65536)) &&
    (p.subtitleTrack===null||(Number.isInteger(p.subtitleTrack)&&p.subtitleTrack>=0&&p.subtitleTrack<65536));
}
function validEntries(root,entries,cursor,active,recursive=false,allowSparse=false){
  if(!Array.isArray(entries)||entries.length<1||entries.length>MAX_ENTRIES)return false;
  if(!Number.isInteger(cursor)||cursor < -1||cursor>=entries.length)return false;
  if(active!==(cursor>=0))return false;
  const generated=Review.createQueue(root,entries.map(x=>({
    filename:x.name,path:"/"+x.name,isDir:false
  })),{recursive});
  if(generated.entries.length!==entries.length)return false;
  for(let i=0;i<entries.length;i++){
    const row=entries[i];
    if(!row || row.name!==generated.entries[i].name ||
      !["PENDING","KEEP","DELETED"].includes(row.status))return false;
    if(allowSparse){
      if(cursor<0 && row.status==="PENDING")return false;
    }else if((cursor>=0 && i<cursor && !["KEEP","DELETED"].includes(row.status))||
       (cursor>=0 && i>=cursor && row.status!=="PENDING")||
       (cursor<0 && !["KEEP","DELETED"].includes(row.status)))return false;
  }
  return cursor<0 || entries[cursor].status==="PENDING";
}
function encode(queue,revision=1,nowMs=Date.now()){
  const root=Review.normalizeRoot(queue?.root);
  if(!root||!Number.isSafeInteger(revision)||revision<1||
     !Number.isSafeInteger(nowMs)||
     !validEntries(root,queue.entries,queue.cursor,queue.active,queue?.recursive===true,true))
    throw new Error("INVALID_CHECKPOINT");
  const value={
    version:VERSION,identityProof:"unverified_list_only",
    root,revision,updatedAt:nowMs,recursive:queue.recursive===true,
    entries:queue.entries.map(x=>({name:x.name,status:x.status})),
    cursor:queue.cursor,active:queue.active
  };
  const raw=JSON.stringify(value);
  if(raw.length>MAX_BYTES)throw new Error("CHECKPOINT_TOO_LARGE");
  return raw;
}
function parse(raw,nowMs=Date.now()){
  if(typeof raw!=="string"||raw.length===0||raw.length>MAX_BYTES)return null;
  try{
    const value=JSON.parse(raw);
    if(!value||![VERSION,LEGACY_VERSION,QUEUE_ONLY_V2,QUEUE_ONLY_V3].includes(value.version)||
       value.identityProof!=="unverified_list_only")return null;
    const root=Review.normalizeRoot(value.root);
    const recursive=value.version>=QUEUE_ONLY_V3 && value.recursive===true;
    if(value.version>=QUEUE_ONLY_V3 && typeof value.recursive!=="boolean")return null;
    if(!root||root!==value.root||!Number.isSafeInteger(value.revision)||value.revision<1||
      !Number.isSafeInteger(value.updatedAt)||
      value.updatedAt>nowMs+60000||nowMs-value.updatedAt>MAX_AGE_MS||
      !validEntries(root,value.entries,value.cursor,value.active,recursive,value.version===VERSION))return null;
    // Old v1 checkpoints are accepted for KEEP/cursor migration only.
    // Discard their playback data; media position, pause and tracks belong
    // exclusively to IINA native history.
    if(value.version===LEGACY_VERSION && !validLegacyPlayback(value.playback))
      return null;
    if(value.version!==LEGACY_VERSION && Object.hasOwn(value,"playback"))
      return null;
    const {playback:ignored,...queueOnly}=value;
    return {...queueOnly,recursive};
  }catch(_){return null;}
}
function hasPending(record){return !!record && record.active===true&&record.cursor>=0;}
function reconcile(record,requestedRoot,listed){
  if(!record||!Review.allowedRoot(requestedRoot)||
    Review.normalizeRoot(requestedRoot)!==record.root)
    throw new Error("SOURCE_MISMATCH");
  const fresh=Review.createQueue(record.root,listed,{recursive:record.recursive===true});
  if(fresh.entries.length!==record.entries.length ||
    fresh.entries.some((entry,i)=>entry.name!==record.entries[i].name))
    throw new Error("SNAPSHOT_MISMATCH");
  for(let i=0;i<fresh.entries.length;i++)fresh.entries[i].status=record.entries[i].status;
  fresh.cursor=record.cursor;
  fresh.active=record.active;
  if(!validEntries(fresh.root,fresh.entries,fresh.cursor,fresh.active,record.recursive===true,true))
    throw new Error("CHECKPOINT_STATE_INVALID");
  return fresh;
}
module.exports={VERSION,LEGACY_VERSION,MAX_BYTES,MAX_ENTRIES,MAX_AGE_MS,encode,parse,reconcile,hasPending};
