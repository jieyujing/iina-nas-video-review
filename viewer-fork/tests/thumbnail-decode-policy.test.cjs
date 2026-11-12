"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDecodePolicy}=require("../src/thumbnail-decode-policy.cjs");
test("auto policy selects CPU for H264 and VideoToolbox for HEVC",()=>{
 assert.equal(createDecodePolicy({mode:"auto",codec:"h264"}).hardware,false);
 assert.equal(createDecodePolicy({mode:"auto",codec:"hevc"}).hardware,true);
 assert.equal(createDecodePolicy({mode:"software",codec:"hevc"}).hardware,false);
});
test("a VideoToolbox failure trips page-level circuit breaker",()=>{
 const policy=createDecodePolicy({mode:"videotoolbox",codec:"hevc"});
 assert.equal(policy.hardware,true);
 assert.equal(policy.fallback(),true);
 assert.equal(policy.hardware,false);
 assert.equal(policy.fallback(),false);
});
