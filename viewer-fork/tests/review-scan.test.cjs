"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Scan=require("../src/review-scan.cjs");
const Review=require("../src/review-core.cjs");
const root="/Volumes/Media/Films";
const rows={
 [root]:[
  {filename:"Z.mp4",path:"/Z.mp4",isDir:false},
  {filename:"Season 2",path:"/Season 2",isDir:true},
  {filename:"Season 1",path:"/Season 1",isDir:true},
  {filename:"redirect",path:"/redirect",isDir:true,isSymlink:true},
  {filename:"readme.txt",path:"/readme.txt",isDir:false}
 ],
 [root+"/Season 1"]:[
  {filename:"ep10.mkv",path:"/ep10.mkv",isDir:false},
  {filename:"ep2.mkv",path:"/ep2.mkv",isDir:false},
  {filename:"..",path:"/..",isDir:true},
  {filename:"nested",path:"/nested",isDir:true}
 ],
 [root+"/Season 1/nested"]:[
  {filename:"ep1.mp4",path:"/ep1.mp4",isDir:false}
 ],
 [root+"/Season 2"]:[
  {filename:"ep1.mp4",path:"/ep1.mp4",isDir:false},
  {filename:"shortcut.mp4",path:"/shortcut.mp4",isSymlink:true,isDir:false}
 ]
};
const list=(dir)=>{if(!Object.hasOwn(rows,dir))throw Error("unexpected path "+dir);return rows[dir];};
test("default nonrecursive scan visits only root and queues direct video",()=>{
 const calls=[];
 const result=Scan.scan(root,(p)=>{calls.push(p);return list(p);},{recursive:false});
 assert.deepEqual(calls,[root]);
 assert.deepEqual(result.map(x=>x.filename),["Z.mp4"]);
 assert.deepEqual(Review.createQueue(root,result,{nasReadOnly:true}).entries.map(x=>x.name),["Z.mp4"]);
});
test("recursive scan descends only direct child folders, stable natural sort and snapshots relative paths",()=>{
 const result=Scan.scan(root,list,{recursive:true});
 assert.deepEqual(result.map(x=>x.filename),[
   "Season 1/ep2.mkv","Season 1/ep10.mkv","Season 1/nested/ep1.mp4",
   "Season 2/ep1.mp4","Z.mp4"
 ]);
 const q=Review.createQueue(root,result,{nasReadOnly:true,recursive:true});
 assert.deepEqual(q.entries.map(x=>x.path),result.map(x=>x.path));
 assert.equal(q.entries[0].name,"Season 1/ep2.mkv");
 assert.equal(q.recursive,true);
});
test("rejects parent traversal, symlink dirs/files, disguised absolute paths, duplicate rows",()=>{
 const malicious=(dir)=>dir===root?[
   {filename:"../escape",path:"/../escape",isDir:true},
   {filename:"symlink",path:"/symlink",isDir:true,isSymlink:true},
   {filename:"foo.mp4",path:"/foo.mp4",isDir:false},
   {filename:"foo.mp4",path:"/foo.mp4",isDir:false},
   {filename:"foreign.mp4",path:"/Volumes/Other/foreign.mp4",isDir:false},
   {filename:".hidden.mp4",path:"/.hidden.mp4",isDir:false},
   {filename:"bar.mkv",path:"/bar.mkv",isDir:false,symlink:true}
 ]:[];
 const result=Scan.scan(root,malicious,{recursive:true});
 assert.deepEqual(result.map(x=>x.filename),["foo.mp4"]);
});
test("bounded scan refuses oversized trees and excessive depth without partial review queue",()=>{
 assert.throws(()=>Scan.scan(root,list,{recursive:true,maxFiles:2}),/scan_limit/i);
 assert.throws(()=>Scan.scan(root,list,{recursive:true,maxDirectories:2}),/scan_limit/i);
 assert.throws(()=>Scan.scan(root,list,{recursive:true,maxDepth:1}),/scan_limit/i);
});
test("large async scan yields, sends progress and can be cancelled without partial snapshot",async()=>{
 const root="/Volumes/Big";
 const listing={};
 listing[root]=Array.from({length:120},(_,i)=>({
   filename:"Dir "+i,path:"/Dir "+i,isDir:true
 }));
 for(let i=0;i<120;i++)
   listing[root+"/Dir "+i]=Array.from({length:80},(_,j)=>({
     filename:"video"+j+".mp4",path:"/video"+j+".mp4",isDir:false
   }));
 let progress=0;
 const result=await Scan.scanAsync(root,p=>listing[p],{
   recursive:true,maxFiles:20000,maxDirectories:5000,maxDepth:24,yieldEvery:4,
   onProgress:()=>{progress++;}
 });
 assert.equal(progress,121);
 assert.equal(result.length,9600);
 let stop=false;
 await assert.rejects(Scan.scanAsync(root,p=>listing[p],{
   recursive:true,maxFiles:20000,maxDirectories:5000,
   yieldEvery:1,onProgress:info=>{if(info.directories>=2)stop=true;},
   cancelled:()=>stop
 }),/SCAN_CANCELLED/);
});
