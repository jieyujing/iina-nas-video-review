"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDebugLogger}=require("../src/debug-log.cjs");
test("bounded logger preserves order and stable session-prefixed IDs",()=>{
 const logger=createDebugLogger({limit:3,now:()=>new Date("2026-11-03T05:00:00Z")});
 for(let i=0;i<5;i++)logger.log("review.start",{count:i});
 const rows=logger.snapshot();
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(x=>x.data.count),[2,3,4]);
 assert.equal(new Set(rows.map(x=>x.id)).size,3);
 assert.equal(rows[0].at,"2026-11-03T05:00:00.000Z");
});
test("log data never exposes media paths, secrets or arbitrary error messages",()=>{
 const logger=createDebugLogger();
 logger.log("review.test",{
  root:"/Volumes/Family/secret.mov",user:"link@example.com",
  token:"abc123",code:"OK",count:2,allowed:true,
  error:"permission denied /Volumes/NAS/private.mkv",
  detail:"some long freeform text with /tmp/home video"
 });
 const serialized=JSON.stringify(logger.snapshot());
 for(const secret of ["/Volumes","private.mkv","secret.mov","link@example.com","abc123","/tmp/home"])
  assert.equal(serialized.includes(secret),false,secret);
 assert.match(serialized,/"count":2/);
 assert.match(serialized,/"allowed":true/);
});
test("log event streaming, bounded snapshot and clearing operate without file IO",()=>{
 const published=[];
 const logger=createDebugLogger({sink:entry=>published.push(entry)});
 logger.log("input.k.registered",{enabled:true});
 assert.equal(published.length,1);
 assert.equal(logger.snapshot().length,1);
 logger.clear();
 assert.equal(logger.snapshot().length,0);
 logger.log("input.k.received",{source:"player"});
 assert.equal(logger.snapshot().length,1);
});
test("logging survives a failing UI bridge sink without throwing to IINA",()=>{
 const logger=createDebugLogger({sink(){throw new Error("bridge unavailable")}});
 assert.doesNotThrow(()=>logger.log("plugin.start"));
 assert.equal(logger.snapshot().length,1);
});
