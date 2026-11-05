"use strict";
// Opt-in SMB-side Review backup. This adapter has no right to delete or
// rename media: its only write targets are its dedicated hidden directory.
const Nas=require("./nas-source.cjs");
const DIR=".iina-nas-review";
const STATE="review-state.v1.json";
function fileType(result){
 if(result?.status!==0)return null;
 const mode=String(result.stdout||"").trim();
 if(!/^[0-7]+$/.test(mode))return null;
 return parseInt(mode,8)&0o170000;
}
function createDirectoryIO({root,proof,utils,file}={}){
 if(!Nas.normalize(root)||!proof?.allowed||
    typeof proof.mountPoint!=="string" ||
    (root!==proof.mountPoint&&!root.startsWith(proof.mountPoint+"/")) ||
    !/^[0-9a-f]{8}$/.test(proof.portableBinding||""))
   throw Error("sidecar_source_unverified");
 const folder=root+"/"+DIR,lock=folder+"/.write-lock",target=folder+"/"+STATE;
 async function exec(bin,args){
   if(typeof utils?.exec!=="function")throw Error("sidecar_exec_unavailable");
   const out=await utils.exec(bin,args);
   if(!Number.isInteger(out?.status))throw Error("sidecar_exec_unknown");
   return out;
 }
 async function checked(){
   const mount=await exec("/sbin/mount",[]);
   const current=mount.status===0?Nas.probe(root,mount.stdout||""):{allowed:false};
   if(!current.allowed || current.binding!==proof.binding ||
      current.portableBinding!==proof.portableBinding)
     throw Error("sidecar_mount_changed");
   const stat=await exec("/usr/bin/stat",["-f","%p",root]);
   if(fileType(stat)!==0o040000)throw Error("sidecar_root_unverified");
 }
 async function ensureFolder(create=false){
   await checked();
   let st=await exec("/usr/bin/stat",["-f","%p",folder]);
   if(st.status!==0){
     if(!create)return false;
     if((await exec("/bin/mkdir",["-m","0700","--",folder])).status!==0)
       throw Error("sidecar_directory_create_failed");
     st=await exec("/usr/bin/stat",["-f","%p",folder]);
   }
   if(fileType(st)!==0o040000)throw Error("sidecar_directory_unverified");
   return true;
 }
 async function load(){
   if(!await ensureFolder(false))return null;
   if(typeof file?.exists!=="function"||typeof file?.read!=="function")
     throw Error("sidecar_read_api_unavailable");
   if(!file.exists(target))return null;
   const st=await exec("/usr/bin/stat",["-f","%p",target]);
   if(fileType(st)!==0o100000)throw Error("sidecar_file_unverified");
   const value=file.read(target,{});
   if(typeof value!=="string"||value.length>1048576)
     throw Error("sidecar_read_invalid");
   return value;
 }
 async function save(raw,expected){
   if(typeof raw!=="string"||raw.length>1048576 ||
      typeof file?.write!=="function"||typeof file?.read!=="function")
     throw Error("sidecar_write_invalid");
   await ensureFolder(true);
   if((await exec("/bin/mkdir",["-m","0700","--",lock])).status!==0)
     throw Error("sidecar_lock_unavailable");
   let tmp=null;
   try{
     await ensureFolder(false);
     const current=await load();
     if(current!==(expected||null))throw Error("sidecar_conflicting_write");
     const name=".state-"+Date.now().toString(36)+"-"+
       Math.random().toString(36).slice(2,12)+".tmp";
     tmp=folder+"/"+name;
     if(file.exists(tmp))throw Error("sidecar_temp_exists");
     file.write(tmp,raw);
     if(file.read(tmp,{})!==raw)throw Error("sidecar_write_verify_failed");
     await checked();
     if((await exec("/bin/mv",["-f","--",tmp,target])).status!==0)
       throw Error("sidecar_atomic_replace_failed");
     tmp=null;
   }finally{
     // Cleanup only our own temp and own lock under the verified metadata
     // folder; never rm a media path or silently clear somebody else's lock.
     if(tmp)try{await exec("/bin/rm",["--",tmp]);}catch(_){}
     try{await exec("/bin/rmdir",["--",lock]);}catch(_){}
   }
 }
 return {root,folder,target,load,save};
}
module.exports={createDirectoryIO,DIR,STATE};
