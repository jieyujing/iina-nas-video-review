"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createQueue,allowedRoot,current,keepAndAdvance}=require("../src/review-core.cjs");
const root="/private/tmp/iina-nas-review-fixture-demo";
test("out-of-order select never marks skipped videos KEEP; next wraps to earliest pending",()=>{
 const Review=require("../src/review-core.cjs");
 const q=createQueue(root,["a.mp4","b.mp4","c.mp4"].map(filename=>({
   filename,path:"/"+filename,isDir:false
 })));
 assert.equal(Review.select(q,2),true);
 assert.equal(q.cursor,2);
 assert.deepEqual(q.entries.map(e=>e.status),["PENDING","PENDING","PENDING"]);
 keepAndAdvance(q);
 assert.equal(q.cursor,0);
 assert.deepEqual(q.entries.map(e=>e.status),["PENDING","PENDING","KEEP"]);
 keepAndAdvance(q);
 assert.equal(q.cursor,1);
 keepAndAdvance(q);
 assert.equal(q.active,false);
 assert.equal(Review.select(q,0),false);
});
test("only disposable local fixtures accepted; no NAS paths",()=>{
 assert.equal(allowedRoot(root),true);
 for(const p of ["/Volumes/NAS","/private/tmp/iina-nas-review-fixture-demo/../NAS",
   "/private/tmp/iina-nas-review-fixture-demo/sub"])
   assert.equal(allowedRoot(p),false,p);
});
test("IINA relative file rows become deterministic local queue",()=>{
 const q=createQueue(root,[{filename:"video10.mp4",path:"video10.mp4",isDir:false},
 {filename:"video2.mkv",path:"video2.mkv",isDir:false},
 {filename:".hidden.mp4",path:".hidden.mp4"},
 {filename:"subdir",path:"subdir",isDir:true}]);
 assert.deepEqual(q.entries.map(e=>e.name),["video2.mkv","video10.mp4"]);
 assert.equal(current(q).path,root+"/video2.mkv");
});
test("IINA Swift file.list rows use a leading slash even for direct children",()=>{
 const rows=[
   {filename:"02_K_TEST_B_ORANGE_60s.mp4",path:"/02_K_TEST_B_ORANGE_60s.mp4",isDir:false},
   {filename:"01_K_TEST_A_BLUE_60s.mp4",path:"/01_K_TEST_A_BLUE_60s.mp4",isDir:false}
 ];
 const queue=createQueue(root,rows);
 assert.deepEqual(queue.entries.map(row=>row.name),[
  "01_K_TEST_A_BLUE_60s.mp4","02_K_TEST_B_ORANGE_60s.mp4"
 ]);
 assert.equal(queue.entries[0].path,root+"/01_K_TEST_A_BLUE_60s.mp4");
 assert.equal(queue.active,true);
});
test("absolute matched file row is accepted; nested and traversal rejected",()=>{
 const q=createQueue(root,[{filename:"good.mp4",path:root+"/good.mp4"},
 {filename:"escape.mp4",path:"../escape.mp4"},
 {filename:"nested.mp4",path:"nested/nested.mp4"},
 {filename:"link.mp4",path:"link.mp4",symlink:true},
 {filename:"x.mp4",path:"x.mp4",isDir:true}]);
 assert.deepEqual(q.entries.map(e=>e.name),["good.mp4"]);
});
test("IINA slash-prefixed direct child is accepted, arbitrary absolute paths remain rejected",()=>{
 const queue=createQueue(root,[
  {filename:"ok.mp4",path:"/ok.mp4",isDir:false},
  {filename:"unsafe.mp4",path:"/Volumes/NAS/unsafe.mp4",isDir:false},
  {filename:"nested.mp4",path:"/subdir/nested.mp4",isDir:false},
  {filename:"traverse.mp4",path:"/../traverse.mp4",isDir:false},
  {filename:"wrong.mp4",path:"/other.mp4",isDir:false},
  {filename:"link.mp4",path:"/link.mp4",isDir:false,isSymlink:true}
 ]);
 assert.deepEqual(queue.entries.map(e=>e.name),["ok.mp4"]);
 assert.equal(queue.entries[0].path,root+"/ok.mp4");
});
test("KEEP transitions to next item and completes without wrapping",()=>{
 const q=createQueue(root,[{filename:"2.mp4",path:"2.mp4"},{filename:"1.mp4",path:"1.mp4"}]);
 assert.equal(current(q).name,"1.mp4");
 assert.equal(keepAndAdvance(q).current.name,"2.mp4");
 assert.equal(q.entries[0].status,"KEEP");
 assert.equal(keepAndAdvance(q).current,null);
 assert.equal(q.active,false);
 assert.equal(keepAndAdvance(q).changed,false);
});
test("read-only queue API never exposes deletion operations",()=>{
 const core=require("../src/review-core.cjs");
 assert.equal(Object.keys(core).some(name=>/delete|remove|unlink/i.test(name)),false);
});
test("macOS local test path aliases and trailing slash resolve to one fixture root",()=>{
 const exact="/private/tmp/iina-nas-review-fixture-mbkl7evt";
 for(const path of [exact,exact+"/", "/tmp/iina-nas-review-fixture-mbkl7evt",
   "file:///private/tmp/iina-nas-review-fixture-mbkl7evt"]){
   assert.equal(allowedRoot(path),true,path+" must identify disposable local fixture");
   const queue=createQueue(path,[{filename:"video2.mp4",path:"video2.mp4",isDir:false}]);
   assert.equal(queue.root,exact);
   assert.equal(current(queue).path,exact+"/video2.mp4");
 }
});
test("path normalization never authorizes non-fixture or nested roots",()=>{
 for(const path of ["/Volumes/NAS/iina-nas-review-fixture-mbkl7evt",
   "/tmp/iina-nas-review-fixture-mbkl7evt/../NAS",
   "/private/tmp/iina-nas-review-fixture-mbkl7evt/subfolder",
   "file:///Volumes/NAS", "/tmp/not-a-fixture", "/tmp/iina-nas-review-fixture-"]){
   assert.equal(allowedRoot(path),false,path);
 }
});
