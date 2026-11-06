"use strict";
// Explicit directory-mode recursive deletion. This is pathname-based SMB
// deletion, NOT an atomic identity-conditional operation. Never call it
// without an individually selected child and two native confirmations.
// All filesystem effects are injected to make tests non-destructive.
const {validPart,directChild}=require("./review-scan.cjs");
const Nas=require("./nas-source.cjs");

function createDirectoryDelete({state,mountProbe,stat,list,confirm,journal,deleteTree,playingPath=()=>""}){
 let busy=false,sequence=0;
 const refused=reason=>({status:"REFUSED",reason});
 const valid=s=>{
   if(!s || s.enabled!==true || s.reviewBusy===true ||
      typeof s.root!=="string" || typeof s.parent!=="string" ||
      typeof s.name!=="string" || !validPart(s.name))return false;
   if(!Nas.normalize(s.root) || Nas.normalize(s.root)!==s.root ||
      !Nas.normalize(s.parent) || Nas.normalize(s.parent)!==s.parent ||
      (s.parent!==s.root && !s.parent.startsWith(s.root+"/")))return false;
   return s.name!==".iina-nas-review" && s.name!=="..";
 };
 const target=s=>s.parent+"/"+s.name;
 const same=(a,b)=>valid(b) && a.root===b.root &&
   a.parent===b.parent && a.name===b.name && a.binding===b.binding &&
   a.epoch===b.epoch && b.reviewBusy!==true && b.playingUnknown!==true;
 const validMount=(s,p)=>p?.allowed===true && typeof p.binding==="string" &&
   typeof p.mountPoint==="string" &&
   (s.root===p.mountPoint||s.root.startsWith(p.mountPoint+"/")) &&
   (s.parent===p.mountPoint||s.parent.startsWith(p.mountPoint+"/")) &&
   (s.binding===undefined||s.binding===p.binding);
 const stableId=value=>{
   if(typeof value!=="string")return null;
   const parts=value.split("|");
   return parts.length===5 && parts.every(p=>/^[0-9]+$/.test(p))?
     parts.slice(0,3).join("|"):null;
 };
 async function verifyPath(s,proof,end=target(s)){
   if(!validMount(s,proof))throw Error("MOUNT_CHANGED");
   let path=proof.mountPoint;
   const folders=[path];
   for(const part of end.slice(path.length+1).split("/").filter(Boolean)){
     if(!validPart(part))throw Error("INVALID_PATH_PART");
     path+="/"+part;folders.push(path);
   }
   const evidence=[];
   for(const folder of folders){
     const row=await stat(folder);
     if(row?.type!=="dir" || !stableId(row.identity))
       throw Error("SYMLINK_OR_NON_DIRECTORY");
     evidence.push({path:folder,identity:row.identity});
   }
   return evidence;
 }
 function sameEvidence(a,b){
   return a.length===b.length && a.every((row,i)=>
     row.path===b[i].path && stableId(row.identity)===stableId(b[i].identity));
 }
 function selectedChild(s){
   const rows=list(s.parent);
   if(!Array.isArray(rows)||rows.length>10000)throw Error("INVALID_PARENT_LIST");
   return rows.find(row=>row.filename===s.name && directChild(s.parent,row));
 }
 const childPresent=s=>selectedChild(s)?.isDir===true;
 function anyChild(s){
   const rows=list(s.parent);
   if(!Array.isArray(rows)||rows.length>10000)throw Error("INVALID_PARENT_LIST");
   // A symlink or file at the former directory name is not observed absence.
   return rows.some(row=>row?.filename===s.name);
 }
 function immediateSnapshot(s){
   const rows=list(target(s));
   if(!Array.isArray(rows)||rows.length>10000)throw Error("INVALID_DIRECTORY_LIST");
   return rows.map(row=>[row?.filename,row?.isDir===true]).sort((a,b)=>
     String(a[0]).localeCompare(String(b[0])));
 }
 async function request(data){
   if(busy)return refused("OPERATION_IN_PROGRESS");
   busy=true;
   try{
     const s=state(data);
     if(!valid(s))return refused("INVALID_DIRECTORY_SELECTION");
     if(s.playingUnknown===true)return refused("PLAYER_IDENTITY_UNAVAILABLE");
     const path=target(s);
     const playing=playingPath();
     if(typeof playing==="string" && playing &&
       (playing===path||playing.startsWith(path+"/")))
       return refused("CURRENT_MEDIA_INSIDE_DIRECTORY");
     let old;
     try{old=await journal.read();}
     catch(_){return refused("JOURNAL_UNAVAILABLE");}
     if(old && !["DELETED_OBSERVED","RM_EXIT_ZERO","RECONCILED_MISSING"].includes(old.state))
       return refused("PREVIOUS_DELETE_UNKNOWN");
     let first,proof,childCount;
     try{
       proof=await mountProbe(s.root);
       if(!validMount(s,proof))return refused("SMB_MOUNT_UNVERIFIED");
       first=await verifyPath(s,proof);
       if(!childPresent(s))return refused("DIRECTORY_NOT_LISTED");
       const children=immediateSnapshot(s);
       childCount=children.length;
       first.children=children;
     }catch(_){return refused("SOURCE_UNAVAILABLE");}
     const name=s.name;
     try{
       if(await confirm({
         stage:"initial",name,path,childCount
       })!==true)return {status:"CANCELLED"};
       if(await confirm({
         stage:"final",name,path,childCount
       })!==true)return {status:"CANCELLED"};
     }catch(_){return refused("CONFIRMATION_UNAVAILABLE");}
     if(!same(s,state(data)))return refused("SOURCE_CHANGED");
     if(typeof playingPath()==="string" && playingPath() &&
       (playingPath()===path || playingPath().startsWith(path+"/")))
       return refused("CURRENT_MEDIA_INSIDE_DIRECTORY");
     try{
       const again=await mountProbe(s.root);
       if(!validMount(s,again) || again.binding!==proof.binding)
         return refused("SMB_MOUNT_CHANGED");
       const next=await verifyPath(s,again);
       if(!sameEvidence(first,next))return refused("DIRECTORY_IDENTITY_CHANGED");
       if(!childPresent(s))return refused("DIRECTORY_NOT_LISTED");
       if(JSON.stringify(first.children)!==JSON.stringify(immediateSnapshot(s)))
         return refused("DIRECTORY_CONTENTS_CHANGED");
     }catch(_){return refused("SOURCE_CHANGED");}
     const record={id:"dir-delete-"+Date.now()+"-"+(++sequence),
       state:"INTENT",root:s.root,parent:s.parent,name:s.name,
       mountIdentity:proof.binding,targetIdentity:first[first.length-1].identity,
       parentIdentity:first[first.length-2].identity};
     try{
       await journal.write(record);
       await journal.write({...record,state:"ISSUED"});
       const durable=await journal.read();
       if(durable?.id!==record.id || durable?.state!=="ISSUED" ||
          durable.targetIdentity!==record.targetIdentity ||
          durable.parentIdentity!==record.parentIdentity ||
          durable.mountIdentity!==record.mountIdentity)
         return refused("JOURNAL_UNAVAILABLE");
     }catch(_){return refused("JOURNAL_UNAVAILABLE");}
     let result;
     try{result=await deleteTree(path);}
     catch(_){result=null;}
     if(result?.status===0){
       try{
         await journal.write({...record,state:"RM_EXIT_ZERO"});
       }catch(_){return {status:"UNKNOWN",reason:"JOURNAL_SAVE_FAILED"};}
       let observedAbsent=false;
       try{
         const after=await mountProbe(s.root);
         if(validMount(s,after)&&after.binding===proof.binding){
           const parents=await verifyPath(s,after,s.parent);
           if(sameEvidence(first.slice(0,-1),parents) && !anyChild(s)){
             await journal.write({...record,state:"DELETED_OBSERVED"});
             observedAbsent=true;
           }
         }
       }catch(_){/* SMB listings may be stale; rm exit 0 remains known. */}
       return {status:"DELETED",observedAbsent};
     }
     // A recursive rm nonzero exit may have already deleted some descendants.
     // The remaining directory inode cannot prove that no files changed.
     // Never treat it as a confirmed failure or permit an automatic retry.
     try{await journal.write({...record,state:"UNKNOWN"});}catch(_){}
     const nonzero=Number.isInteger(result?.status)&&result.status!==0;
     return {status:"UNKNOWN",
       reason:nonzero?"RM_EXIT_NONZERO_MAY_BE_PARTIAL":"DIRECTORY_DELETE_INDETERMINATE",
       ...(nonzero?{exitCode:result.status}:{})};
   }finally{busy=false;}
 }
 async function reconcileMissing(){
   if(busy)return refused("OPERATION_IN_PROGRESS");
   busy=true;
   try{
     const old=await journal.read();
     if(!old || !["ISSUED","INTENT","UNKNOWN"].includes(old.state))
       return refused("NOTHING_TO_RECONCILE");
     const s=state({root:old.root,parent:old.parent,name:old.name});
     if(!valid(s))return refused("SOURCE_UNAVAILABLE");
     const proof=await mountProbe(old.root);
     if(!validMount(s,proof)||proof.binding!==old.mountIdentity)
       return refused("SMB_MOUNT_CHANGED");
     if(!old.parentIdentity)return refused("PARENT_IDENTITY_UNAVAILABLE");
     const parents=await verifyPath(s,proof,s.parent);
     if(stableId(parents[parents.length-1].identity)!==stableId(old.parentIdentity))
       return refused("PARENT_IDENTITY_CHANGED");
     if(anyChild(s))return refused("DIRECTORY_STILL_PRESENT");
     if(await confirm({stage:"reconcile",name:old.name,path:old.parent+"/"+old.name})!==true)
       return {status:"CANCELLED"};
     if(anyChild(s))return refused("DIRECTORY_STILL_PRESENT");
     await journal.write({...old,state:"RECONCILED_MISSING"});
     return {status:"RECONCILED"};
   }catch(_){return refused("RECONCILIATION_UNAVAILABLE");}
   finally{busy=false;}
 }
 return {request,reconcileMissing};
}
module.exports={createDirectoryDelete};
