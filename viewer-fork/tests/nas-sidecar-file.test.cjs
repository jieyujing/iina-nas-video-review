"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDirectoryIO}=require("../src/nas-sidecar-file.cjs");
const root="/Volumes/Movies/Review",dir=root+"/.iina-nas-review";
const mount="//user@nas.local/Movies on /Volumes/Movies (smbfs, nodev)";
const Nas=require("../src/nas-source.cjs");
function fixture({unmounted=false,linkDir=false,denyWrite=false}={}){
 const entries=new Map([[root,{mode:"40755"}]]);
 const calls=[],proof=Nas.probe(root,mount);
 let online=!unmounted;
 const file={
   exists:path=>entries.has(path),
   read:path=>entries.get(path)?.content,
   write(path,value){
     assert.ok(path.startsWith(dir+"/.state-"));
     if(denyWrite)throw Error("SMB_UNAVAILABLE");
     entries.set(path,{mode:"100644",content:value});
   }
 };
 const utils={exec:async(bin,args)=>{
   calls.push([bin,...args]);
   if(bin==="/sbin/mount")return {status:0,stdout:online?mount:""};
   if(bin==="/usr/bin/stat"){
     const e=entries.get(args[2]);
     return e?{status:0,stdout:e.mode}:{status:1};
   }
   if(bin==="/bin/mkdir"){
     const path=args[3];
     if(entries.has(path))return {status:1};
     if(path===dir && linkDir)entries.set(path,{mode:"120777"});
     else entries.set(path,{mode:"40700"});
     return {status:0};
   }
   if(bin==="/bin/mv"){
     const src=args[2],dst=args[3];
     if(!entries.has(src))return {status:1};
     assert.equal(dst,dir+"/review-state.v1.json");
     entries.set(dst,entries.get(src));entries.delete(src);
     return {status:0};
   }
   if(bin==="/bin/rmdir"){
     entries.delete(args[1]);return {status:0};
   }
   if(bin==="/bin/rm"){
     assert.ok(args[1].startsWith(dir+"/.state-"));
     entries.delete(args[1]);return {status:0};
   }
   throw Error("unexpected command: "+bin);
 }};
 const io=createDirectoryIO({root,proof,file,utils});
 return {io,entries,calls,setOnline:v=>online=v};
}
test("SMB metadata adapter writes only hidden Review state through verified temp and rename",async()=>{
 const h=fixture();
 assert.equal(await h.io.load(),null);
 await h.io.save('{"revision":1}',null);
 assert.equal(await h.io.load(),'{"revision":1}');
 assert.equal(h.entries.has(dir+"/.write-lock"),false);
 assert.ok(h.calls.some(x=>x[0]==="/bin/mv"));
 assert.equal(h.calls.filter(x=>x[0]==="/bin/rm").length,0);
 await h.io.save('{"revision":2}','{"revision":1}');
 assert.equal(await h.io.load(),'{"revision":2}');
 assert.equal(h.entries.has(dir+"/.write-lock"),false);
});
test("SMB adapter rejects a symlink metadata folder without touching state",async()=>{
 const h=fixture({linkDir:true});
 await assert.rejects(h.io.save("snapshot",null),/sidecar_directory_unverified/);
 assert.equal(h.calls.some(x=>x[0]==="/bin/mv"),false);
});
test("SMB adapter fails closed on mount loss and conflicting expected snapshot",async()=>{
 const h=fixture();
 await h.io.save("original",null);
 await assert.rejects(h.io.save("replacement","wrong"),/sidecar_conflicting_write/);
 assert.equal(await h.io.load(),"original");
 h.setOnline(false);
 await assert.rejects(h.io.save("replacement","original"),/sidecar_mount_changed/);
 assert.equal(h.entries.get(dir+"/review-state.v1.json").content,"original");
});
test("SMB write failure does not replace previous snapshot or abandon lock",async()=>{
 const h=fixture({denyWrite:true});
 await assert.rejects(h.io.save("snapshot",null),/SMB_UNAVAILABLE/);
 assert.equal(h.entries.has(dir+"/.write-lock"),false);
 assert.equal(h.entries.has(dir+"/review-state.v1.json"),false);
});
