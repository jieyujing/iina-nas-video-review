"use strict";
// User-requested durable SMB Review progress: informational KEEP/PENDING/
// DELETED/cursor only, never proof of source identity for destructive actions.
const Review=require("./review-core.cjs");
const Nas=require("./nas-source.cjs");
const VERSION=1,MAX_BYTES=1024*1024,MAX_ENTRIES=20000,MAX_AGE_MS=7*86400000;
function stableRootIdentity(value){
 if(typeof value!=="string")return null;
 const parts=value.split("|");
 return (parts.length===3||parts.length===5) &&
   parts.every(x=>/^\d+$/.test(x))?
   parts.slice(0,3).join("|"):null;
}
function valid(record){
 if(!record || record.version!==VERSION || Nas.normalize(record.root)!==record.root ||
    !/^[a-f0-9]{8}$/.test(record.mountBinding) ||
    record.rootIdentity!==stableRootIdentity(record.rootIdentity) ||
    typeof record.recursive!=="boolean" || !Number.isSafeInteger(record.revision) ||
    record.revision<1 || !Number.isSafeInteger(record.updatedAt) ||
    !Array.isArray(record.entries)||record.entries.length<1||
    record.entries.length>MAX_ENTRIES || !Number.isInteger(record.cursor)||
    record.cursor < -1 || record.cursor>=record.entries.length ||
    record.active!==(record.cursor>=0))return false;
 const source=record.entries.map(row=>({
   filename:row?.name,path:record.root+"/"+row?.name,isDir:false
 }));
 const seenNames=new Set();
 for(const row of record.entries){
   if(typeof row?.name!=="string"||seenNames.has(row.name))return false;
   seenNames.add(row.name);
 }
 let canonical;
 try{canonical=Review.createQueue(record.root,source,{
   recursive:record.recursive,nasReadOnly:true
 });}
 catch(_){return false;}
 if(canonical.entries.length!==record.entries.length)return false;
 for(let i=0;i<record.entries.length;i++){
   const item=record.entries[i];
   if(canonical.entries[i].name!==item.name ||
      !["PENDING","KEEP","DELETED","MISSING"].includes(item.status))return false;
   if(record.cursor<0 && item.status==="PENDING")return false;
 }
 return record.cursor<0||record.entries[record.cursor].status==="PENDING";
}
function encode(queue,revision=1,nowMs=Date.now()){
 const record={version:VERSION,sourceKind:"finder_smb_progress_only",
   root:queue?.root,mountBinding:queue?.nasBinding,
   rootIdentity:stableRootIdentity(queue?.nasRootIdentity),
   recursive:queue?.recursive===true,
   revision,updatedAt:nowMs,cursor:queue?.cursor,active:queue?.active,
   entries:queue?.entries?.map(({name,status})=>({name,status}))};
 if(!valid(record))throw Error("INVALID_SMB_CHECKPOINT");
 const raw=JSON.stringify(record);
 if(raw.length>MAX_BYTES)throw Error("SMB_CHECKPOINT_TOO_LARGE");
 return raw;
}
function parse(raw,nowMs=Date.now()){
 if(typeof raw!=="string"||raw.length<10||raw.length>MAX_BYTES)return null;
 try{
  const record=JSON.parse(raw);
  if(!valid(record)||record.sourceKind!=="finder_smb_progress_only"||
     record.updatedAt>nowMs+60000 || nowMs-record.updatedAt>MAX_AGE_MS)
    return null;
  return record;
 }catch(_){return null;}
}
function hasPending(record){return !!record&&record.active===true&&record.cursor>=0;}
function reconcile(record,{root,mountBinding,rootIdentity,listed}={}){
 if(!valid(record) || !hasPending(record) || root!==record.root ||
    mountBinding!==record.mountBinding ||
    stableRootIdentity(rootIdentity)!==record.rootIdentity)
   throw Error("SMB_SOURCE_CHANGED");
 const actual=Review.createQueue(root,listed,{
   recursive:record.recursive,nasReadOnly:true
 });
 // SMB is authoritative for current media availability. A saved PENDING or
 // legacy MISSING name that is absent from this same verified SMB folder is
 // treated as DELETED for Review navigation (not proof of who deleted it).
 // KEEP remains a saved user decision. Unexpected new names still block
 // automatic identity reconciliation.
 const oldNames=new Set(record.entries.filter(x=>x.status!=="DELETED")
   .map(x=>x.name));
 const actualNames=new Set(actual.entries.map(x=>x.name));
 if(actual.entries.some(x=>!oldNames.has(x.name)))
   throw Error("SMB_INVENTORY_ADDED");
 // Build the full previous queue, including DELETED entries no longer present
 // on disk. This allows the saved cursor to remain stable, and never reopens
 // a deleted media path.
 const original=record.entries.map(x=>({
   filename:x.name,path:root+"/"+x.name,isDir:false
 }));
 const queue=Review.createQueue(root,original,{
   recursive:record.recursive,nasReadOnly:true
 });
 for(let i=0;i<queue.entries.length;i++){
   const saved=record.entries[i];
   queue.entries[i].status=
     (saved.status==="PENDING" || saved.status==="MISSING") &&
       !actualNames.has(saved.name)?"DELETED":
     saved.status==="MISSING" && actualNames.has(saved.name)?"PENDING":
       saved.status;
 }
 let cursor=record.cursor;
 if(cursor>=0 && queue.entries[cursor].status!=="PENDING"){
   cursor=-1;
   for(let offset=1;offset<=queue.entries.length;offset++){
     const index=(record.cursor+offset)%queue.entries.length;
     if(queue.entries[index].status==="PENDING"){
       cursor=index;break;
     }
   }
   // All pending media may have been removed from the authoritative SMB
   // directory. A completed Review is valid; do not trap it in recovery.
 }
 queue.cursor=cursor;queue.active=cursor>=0;
 queue.nasReadOnly=true;queue.nasBinding=mountBinding;
 queue.nasRootIdentity=rootIdentity;
 if(!valid({...record,cursor:queue.cursor,active:queue.active,
   entries:queue.entries.map(({name,status})=>({name,status}))}))
   throw Error("SMB_RECOVERY_INVALID");
 return queue;
}
module.exports={VERSION,MAX_AGE_MS,MAX_ENTRIES,MAX_BYTES,stableRootIdentity,
  encode,parse,hasPending,reconcile};
