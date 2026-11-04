"use strict";
// Calculate a density-based timeline sample plan without touching media.
// NAS has no arbitrary total-frame cap; only one small page is decoded/rendered
// at a time. IINA's existing read-only native thumbnail cache limit is unchanged.
const DEFAULT_INTERVAL_MINUTES=10;
const NAS_PAGE_SIZE=35;
const MIN_INTERVAL_MINUTES=1,MAX_INTERVAL_MINUTES=60;
const NATIVE_MAX_SAMPLES=100;
function calculateSamplePlan(duration,intervalMinutes=DEFAULT_INTERVAL_MINUTES,isNas=true){
  if(!Number.isFinite(duration)||duration<=0||duration>86400)
    throw new Error("duration_unavailable");
  if(typeof intervalMinutes!=="number"||
     !Number.isInteger(intervalMinutes)||
     intervalMinutes<MIN_INTERVAL_MINUTES||
     intervalMinutes>MAX_INTERVAL_MINUTES)
    throw new Error("sample_interval_invalid");
  const requestedCount=Math.max(1,Math.ceil(duration/(intervalMinutes*60)));
  const maxSamples=isNas?null:NATIVE_MAX_SAMPLES;
  const count=isNas?requestedCount:Math.min(maxSamples,requestedCount);
  return {
    duration,intervalMinutes,count,requestedCount,maxSamples,
    capped:!isNas&&requestedCount>maxSamples,
    actualMinutes:duration/(60*count)
  };
}
module.exports={calculateSamplePlan,DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,MAX_INTERVAL_MINUTES,NATIVE_MAX_SAMPLES,NAS_PAGE_SIZE};
