"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Review=require("../src/review-core.cjs");
const Session=require("../src/review-session.cjs");
const root="/private/tmp/iina-nas-review-fixture-queue-only";
function queue(){
 const q=Review.createQueue(root,[
  {filename:"video2.mp4",path:"/video2.mp4",isDir:false},
  {filename:"video10.mp4",path:"/video10.mp4",isDir:false}
 ]);
 Review.keepAndAdvance(q);
 return q;
}
test("v4 saves queue, recursion mode, and no playback position or tracks",()=>{
 const raw=Session.encode(queue(),4,1700000000000);
 const json=JSON.parse(raw);
 assert.equal(json.version,4);
 assert.equal(json.recursive,false);
 assert.equal("playback" in json,false);
 assert.deepEqual(json.entries.map(x=>x.status),["KEEP","PENDING"]);
 const parsed=Session.parse(raw,1700000000000);
 assert.equal(parsed.cursor,1);
 assert.equal("playback" in parsed,false);
});
test("legacy version 1 playback-bearing checkpoint migrates KEEP and cursor but does not retain playback data",()=>{
 const legacy=JSON.stringify({
  version:1,identityProof:"unverified_list_only",root,
  revision:3,updatedAt:1700000000000,cursor:1,active:true,
  entries:[{name:"video2.mp4",status:"KEEP"},{name:"video10.mp4",status:"PENDING"}],
  playback:{positionSec:48.5,paused:true,audioTrack:2,subtitleTrack:1}
 });
 const parsed=Session.parse(legacy,1700000000000);
 assert.ok(parsed,"should not discard saved KEEP when migrating");
 assert.deepEqual(parsed.entries.map(e=>e.status),["KEEP","PENDING"]);
 assert.equal("playback" in parsed,false);
 const upgraded=JSON.parse(Session.encode(Session.reconcile(parsed,root,[
  {filename:"video2.mp4",path:"/video2.mp4",isDir:false},
  {filename:"video10.mp4",path:"/video10.mp4",isDir:false}
 ]),4,1700000000000));
 assert.equal(upgraded.version,4);
 assert.equal("playback" in upgraded,false);
});
