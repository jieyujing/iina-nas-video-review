"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {calculateSamplePlan}=require("../src/thumbnail-sampling.cjs");
test("duration determines count from minutes per sample (ceil and minimum one)",()=>{
 for(const [duration,minutes,expected] of [
  [60,10,1],[600,10,1],[601,10,2],
  [1800,10,3],[3600,10,6],[7200,10,12],
  [6600,5,22],[86400,60,24]
 ]){
  const plan=calculateSamplePlan(duration,minutes,true);
  assert.equal(plan.count,expected);
  assert.equal(plan.capped,false);
 }
});
test("NAS one-minute interval is not capped at 40, native cache stays bounded at 100",()=>{
 const nas=calculateSamplePlan(7200,1,true);
 assert.equal(nas.count,120);
 assert.equal(nas.requestedCount,120);
 assert.equal(nas.capped,false);
 assert.equal(nas.actualMinutes,1);
 const long=calculateSamplePlan(86400,1,true);
 assert.equal(long.count,1440);
 assert.equal(long.capped,false);
 const local=calculateSamplePlan(7200,1,false);
 assert.equal(local.count,100);
 assert.equal(local.capped,true);
 assert.equal(local.actualMinutes,1.2);
});
test("reject invalid duration and unsafe or nonintegral minute intervals",()=>{
 for(const duration of [0,-1,Infinity,NaN,86401]){
  assert.throws(()=>calculateSamplePlan(duration,10,true),/duration_unavailable/);
 }
 for(const minutes of [0,-1,61,1.5,NaN,Infinity,"10",null]){
  assert.throws(()=>calculateSamplePlan(600,minutes,true),/sample_interval_invalid/);
 }
});
