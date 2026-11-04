"use strict";
// Bounded, deterministic scan of IINA file.list direct children.
// This is for Review only, not proof of SMB file identity or delete safety.
const VIDEO=new Set(["mp4","mkv","mov","avi","webm","m4v"]);
function validPart(name){
  return typeof name==="string" && name.length>0 && name.length<=255 &&
    !name.startsWith(".") && !name.includes("/") && !name.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(name) && name!==".." && name!==".";
}
function directChild(dir,row){
  if(!row||!validPart(row.filename)||row.isSymlink===true||
    row.symlink===true||row.isSymbolicLink===true)return false;
  const n=row.filename;
  return row.path===n || row.path==="/"+n || row.path===dir+"/"+n;
}
function natural(a,b){return a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"});}
function* traverse(root,list,opts={}){
  if(typeof root!=="string" || !root.startsWith("/") || typeof list!=="function")
    throw Error("INVALID_SCAN_ROOT");
  const recursive=opts.recursive===true;
  const maxFiles=Number.isInteger(opts.maxFiles)?opts.maxFiles:1000;
  const maxDirectories=Number.isInteger(opts.maxDirectories)?opts.maxDirectories:1000;
  const maxDepth=Number.isInteger(opts.maxDepth)?opts.maxDepth:12;
  if(maxFiles<1||maxFiles>20000||maxDirectories<1||maxDirectories>5000||
     maxDepth<0||maxDepth>24)throw Error("SCAN_LIMIT_CONFIG");
  const pending=[{dir:root,rel:"",depth:0}],results=[],seen=new Set();
  let directories=0;
  while(pending.length){
    if(typeof opts.cancelled==="function" && opts.cancelled())
      throw Error("SCAN_CANCELLED");
    const {dir,rel,depth}=pending.pop();
    if(++directories>maxDirectories)throw Error("SCAN_LIMIT_DIRECTORIES");
    const listed=list(dir);
    if(!Array.isArray(listed))throw Error("INVALID_SCAN_RESULT");
    // Count all rows, not merely accepted videos, to bound memory/time.
    if(listed.length>10000)throw Error("SCAN_LIMIT_ROWS");
    const safe=listed.filter(row=>directChild(dir,row)).sort((a,b)=>natural(a.filename,b.filename));
    const folders=[];
    for(const row of safe){
      const nextName=rel?rel+"/"+row.filename:row.filename;
      if(row.isDir===true){
        if(recursive){
          if(depth>=maxDepth)throw Error("SCAN_LIMIT_DEPTH");
          folders.push({dir:dir+"/"+row.filename,rel:nextName,depth:depth+1});
        }
        continue;
      }
      const ext=row.filename.includes(".")?row.filename.slice(row.filename.lastIndexOf(".")+1).toLowerCase():"";
      if(!VIDEO.has(ext)||seen.has(nextName))continue;
      seen.add(nextName);
      if(results.length>=maxFiles)throw Error("SCAN_LIMIT_FILES");
      results.push({filename:nextName,path:root+"/"+nextName,isDir:false});
    }
    for(let i=folders.length-1;i>=0;i--)pending.push(folders[i]);
    yield {directories,files:results.length,pending:pending.length};
  }
  results.sort((a,b)=>natural(a.filename,b.filename));
  return results;
}
function scan(root,list,opts={}){
  const iterator=traverse(root,list,opts);
  let next;
  while(!(next=iterator.next()).done){}
  return next.value;
}
async function scanAsync(root,list,opts={}){
  const iterator=traverse(root,list,opts);
  const yieldEvery=Number.isInteger(opts.yieldEvery)&&opts.yieldEvery>0?
    Math.min(16,opts.yieldEvery):4;
  let next;
  while(!(next=iterator.next()).done){
    if(typeof opts.onProgress==="function")opts.onProgress(next.value);
    if(next.value.directories%yieldEvery===0)
      await new Promise(resolve=>setTimeout(resolve,0));
  }
  return next.value;
}
module.exports={scan,scanAsync,directChild,validPart};
