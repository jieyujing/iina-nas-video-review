"use strict";

/**
 * Development-only read/keep queue. No storage deletion or mutation methods.
 * File Viewer remains responsible for folder navigation and playback.
 */
const EXTENSIONS=new Set(["mp4","mkv","mov","avi","webm","m4v"]);
const FIXTURE_PREFIX="/private/tmp/iina-nas-review-fixture-";
const Nas=require("./nas-source.cjs");

function normalizeRoot(root) {
  if(typeof root!=="string")return null;
  let path=root.trim();
  // IINA's folder chooser can return a file URL, or macOS's /tmp symlink.
  if(path.startsWith("file://"))path=path.slice("file://".length);
  try { path=decodeURIComponent(path); } catch(_) { return null; }
  if(path.startsWith("/tmp/"))path="/private"+path;
  if(path.endsWith("/"))path=path.slice(0,-1);
  if(!path.startsWith(FIXTURE_PREFIX))return null;
  if(!/^[a-zA-Z0-9_-]+$/.test(path.slice(FIXTURE_PREFIX.length)))return null;
  return path;
}
function allowedRoot(root) {
  return normalizeRoot(root)!==null;
}
function basenameToPath(root, row, options={}) {
  const canonical=normalizeRoot(root)||
    (options.nasReadOnly===true?Nas.normalize(root):null);
  if(!canonical||!row||row.isDir||row.symlink||row.isSymlink)return null;
  const name=row.filename;
  if(typeof name!=="string"||!name||name.startsWith(".")||name===".."||
    (options.recursive!==true && name.includes("/"))||
    name.includes("\\")||name.includes("\u0000")||
    name.split("/").some(part=>!part||part==="."||part===".."||part.startsWith(".")||
      /[\u0000-\u001f\u007f]/.test(part)))return null;
  const ext=name.includes(".")?name.slice(name.lastIndexOf(".")+1).toLowerCase():"";
  if(!EXTENSIONS.has(ext))return null;
  // IINA's Swift JavascriptAPIFile.list() subtracts the directory path prefix
  // from the child's absolute path. This leaves a *leading slash* ("/name").
  // That is a direct-child marker, NOT permission to open an arbitrary absolute
  // path. Construct the resulting path solely from the verified fixture root
  // and safe basename; reject anything with another separator or mismatch.
  if(row.path!==name && row.path!=="/"+name &&
     row.path!==root+"/"+name && row.path!==canonical+"/"+name)return null;
  return {name,path:canonical+"/"+name,status:"PENDING"};
}
function createQueue(root,rows,options={}) {
  const canonical=normalizeRoot(root)||
    (options.nasReadOnly===true?Nas.normalize(root):null);
  if(!canonical)throw new Error("LOCAL_FIXTURE_REQUIRED");
  if(!Array.isArray(rows))throw new Error("INVALID_FILE_LIST");
  const entries=rows.map(row=>basenameToPath(canonical,row,options)).filter(Boolean);
  entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
  return {root:canonical,entries,cursor:entries.length?0:-1,active:entries.length>0,
    recursive:options.recursive===true};
}
function current(state) {
  return state.active && state.cursor>=0 ? state.entries[state.cursor]||null : null;
}
function select(state,index){
  if(!state?.active || !Number.isInteger(index)||index<0||
    index>=state.entries.length || state.entries[index].status!=="PENDING")
    return false;
  state.cursor=index;
  return true;
}
function advance(state,decision="KEEP") {
  if(!["KEEP","DELETED","MISSING"].includes(decision))throw new Error("INVALID_REVIEW_DECISION");
  const item=current(state);
  if(!item)return {changed:false,current:null};
  item.status=decision;
  let next=-1;
  for(let offset=1;offset<=state.entries.length;offset++){
    const i=(state.cursor+offset)%state.entries.length;
    if(state.entries[i].status==="PENDING"){next=i;break;}
  }
  state.cursor=next;
  state.active=state.cursor>=0;
  return {changed:true,current:current(state)};
}
function keepAndAdvance(state){return advance(state,"KEEP");}
module.exports={normalizeRoot,allowedRoot,basenameToPath,createQueue,current,select,keepAndAdvance,advance};
