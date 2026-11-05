"use strict";
// Portable, non-authoritative Review progress backup. No absolute media
// paths, no delete authorization, no filesystem activity inside this module.
const Scan=require("./review-scan.cjs");
const Nas=require("./nas-source.cjs");
const VERSION=1,MAX_BYTES=1024*1024,MAX_ENTRIES=20000;
function hash(text){
 let h=0x811c9dc5;
 for(let i=0;i<text.length;i++){
   h^=text.charCodeAt(i);
   h=Math.imul(h,0x01000193)>>>0;
 }
 return h.toString(16).padStart(8,"0");
}
function validRelative(value){
 return typeof value==="string"&&value.length>0&&value.length<=2048 &&
   value.split("/").every(Scan.validPart);
}
function valid(record){
 if(!record || record.schemaVersion!==VERSION ||
    record.kind!=="iina_nas_review_portable_backup" ||
    !/^[0-9a-f]{8}$/.test(record.sourceId) ||
    !(record.relativeRoot===""||validRelative(record.relativeRoot)) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(record.writerId) ||
    typeof record.recursive!=="boolean" ||
    !Number.isSafeInteger(record.localRevision)||record.localRevision<1||
    !Number.isSafeInteger(record.updatedAt)||record.updatedAt<1||
    !Number.isInteger(record.cursor)||record.cursor< -1 ||
    record.active!==(record.cursor>=0) ||
    !Array.isArray(record.entries)||record.entries.length<1 ||
    record.entries.length>MAX_ENTRIES||record.cursor>=record.entries.length)
   return false;
 const names=new Set();
 for(const row of record.entries){
   if(!row||!validRelative(row.path)||names.has(row.path)||
      !["PENDING","KEEP","DELETED","MISSING"].includes(row.status))
     return false;
   names.add(row.path);
 }
 if(record.cursor<0 && record.entries.some(row=>row.status==="PENDING"))
   return false;
 if(record.cursor>=0 && record.entries[record.cursor].status!=="PENDING")
   return false;
 return record.checksum===hash(JSON.stringify({
   schemaVersion:record.schemaVersion,kind:record.kind,
   sourceId:record.sourceId,relativeRoot:record.relativeRoot,
   writerId:record.writerId,localRevision:record.localRevision,
   recursive:record.recursive,
   updatedAt:record.updatedAt,cursor:record.cursor,active:record.active,
   entries:record.entries
 }));
}
function encode(local,identity,writerId){
 if(!local || !identity?.allowed ||
    !/^[0-9a-f]{8}$/.test(identity.portableBinding||"") ||
    !Nas.normalize(local.root) ||
    typeof identity.mountPoint!=="string"||
    (local.root!==identity.mountPoint &&
      !local.root.startsWith(identity.mountPoint+"/"))||
    !Number.isSafeInteger(local.revision)||local.revision<1 ||
    !Array.isArray(local.entries))throw Error("portable_source_invalid");
 const candidate={
   schemaVersion:VERSION,kind:"iina_nas_review_portable_backup",
   sourceId:identity.portableBinding,
   relativeRoot:local.root===identity.mountPoint?"":local.root.slice(identity.mountPoint.length+1),
   writerId,localRevision:local.revision,
   recursive:local.recursive===true,
   updatedAt:local.updatedAt,cursor:local.cursor,active:local.active,
   entries:local.entries.map(row=>({path:row.name,status:row.status}))
 };
 candidate.checksum=hash(JSON.stringify(candidate));
 if(!valid(candidate))throw Error("portable_snapshot_invalid");
 const raw=JSON.stringify(candidate);
 if(raw.length>MAX_BYTES)throw Error("portable_snapshot_oversized");
 return raw;
}
function parse(raw){
 if(typeof raw!=="string"||raw.length<10||raw.length>MAX_BYTES)return null;
 try{
   const x=JSON.parse(raw);
   if(!valid(x))return null;
   return x;
 }catch(_){return null;}
}
// Own only serialized publication state. The filesystem adapter receives a
// fully encoded, validated record; it must implement atomic guarded write.
function createMirror({load,save,log=()=>{}}={}){
 let tail=Promise.resolve();
 function publish(local,identity,writerId){
   const task=tail.then(async()=>{
     let raw;
     try{
       raw=encode(local,identity,writerId);
       if(typeof load!=="function"||typeof save!=="function")
         throw Error("portable_io_unavailable");
       const currentRaw=await load();
       if(currentRaw){
         const current=parse(currentRaw);
         if(!current || current.writerId!==writerId ||
            current.sourceId!==identity.portableBinding ||
            current.relativeRoot!==parse(raw).relativeRoot ||
            current.localRevision>local.revision){
           log("nas.sidecar.conflict",{},"warn");
           return {status:"conflict"};
         }
         if(current.localRevision===local.revision){
           const proposed=parse(raw);
           if(current.cursor!==proposed.cursor ||
              current.active!==proposed.active ||
              current.recursive!==proposed.recursive ||
              JSON.stringify(current.entries)!==JSON.stringify(proposed.entries))
             return {status:"conflict"};
           return {status:"synced"};
         }
       }
       await save(raw,currentRaw||null);
       return {status:"synced"};
     }catch(_){
       log("nas.sidecar.pending_retry",{},"warn");
       return {status:"pending"};
     }
   });
   tail=task.then(()=>{});
   return task;
 }
 return {publish};
}
module.exports={VERSION,MAX_BYTES,MAX_ENTRIES,validRelative,
  encode,parse,createMirror};
