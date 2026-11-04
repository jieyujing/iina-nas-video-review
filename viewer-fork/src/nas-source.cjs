"use strict";
// Read-only identification of a Finder-mounted SMB share. This is NOT a
// cryptographic root or file-identity proof and MUST NOT authorize deletion.
const PREFIX="/Volumes/";
function normalize(root){
  if(typeof root!=="string" || root.length>2048)return null;
  let value=root;
  if(value.startsWith("file://"))value=value.slice(7);
  try{value=decodeURIComponent(value);}catch(_){return null;}
  if(!value.startsWith(PREFIX) || value.includes("\\") ||
     /[\u0000-\u001f\u007f]/.test(value) || value.includes("//"))return null;
  const segments=value.slice(PREFIX.length).split("/");
  if(segments.length<1 || segments.some(s=>s.length===0||s==="."||s===".."||
      s.startsWith(".")||s.length>255))return null;
  return value;
}
function hashIdentity(raw){
  // Short non-secret equality fingerprint for non-destructive session
  // reconnection only. NOT a collision-resistant security token.
  let h=0x811c9dc5;
  for(let i=0;i<raw.length;i++){
    h^=raw.charCodeAt(i);
    h=Math.imul(h,0x01000193)>>>0;
  }
  return h.toString(16).padStart(8,"0");
}
function probe(requested,mountOutput){
  const root=normalize(requested);
  if(!root || typeof mountOutput!=="string")
    return {allowed:false,reason:"invalid_nas_root"};
  let selected=null;
  for(const line of mountOutput.split("\n")){
    const marker=" (smbfs";
    const end=line.lastIndexOf(marker);
    if(end<0 || !/^\s*(?:,|\))/.test(line.slice(end+marker.length)))continue;
    const on=line.lastIndexOf(" on ",end);
    if(on<1)continue;
    const source=line.slice(0,on);
    const mountPoint=line.slice(on+4,end);
    if(!mountPoint.startsWith(PREFIX) ||
       (root!==mountPoint && !root.startsWith(mountPoint+"/")))continue;
    if(!source.startsWith("//"))continue;
    if(!selected || mountPoint.length>selected.mountPoint.length)
      selected={mountPoint,source};
  }
  if(!selected)return {allowed:false,reason:"not_mounted_smbfs"};
  // Ignore the mount account in the non-destructive comparison key; never
  // expose raw mount descriptors in logs or sidebar messages.
  const sanitized=selected.source.replace(/^\/\/[^@/]+@/,"//");
  return {
    allowed:true,root,mountPoint:selected.mountPoint,
    binding:hashIdentity(sanitized+"\n"+selected.mountPoint),
    reason:"mounted_smbfs_read_only"
  };
}
module.exports={normalize,probe};
