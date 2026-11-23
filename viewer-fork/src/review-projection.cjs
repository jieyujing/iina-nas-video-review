"use strict";
const ACTIVE_DELETE_STATES=new Set(["QUEUED","RUNNING","PAUSED","UNKNOWN"]);
const COUNTED_JOB_STATES=["RUNNING","QUEUED","PAUSED","UNKNOWN","DELETED",
  "FAILED","RECONCILED","CANCELLED"];
function indexJobs(root,jobs,counts=null,legacyQueueId=null){
  const jobsByIndex=new Map();let legacyQueueRunning=false;
  for(const job of jobs||[]){
    if(counts&&Object.prototype.hasOwnProperty.call(counts,job.status))
      counts[job.status]++;
    if(job.status==="RUNNING"&&job.id===legacyQueueId)legacyQueueRunning=true;
    if(job.root!==root||!ACTIVE_DELETE_STATES.has(job.status))continue;
    let paths=jobsByIndex.get(job.index);
    if(!paths){paths=new Map();jobsByIndex.set(job.index,paths);}
    if(!paths.has(job.path))paths.set(job.path,job);
  }
  return {jobsByIndex,legacyQueueRunning};
}
function projectWindow(queue,start,size,jobs){
  const entries=queue?.entries||[],{jobsByIndex}=indexJobs(queue?.root,jobs);
  return entries.slice(start,start+size).map((entry,i)=>{
    const index=start+i,job=jobsByIndex.get(index)?.get(entry.path);
    return {name:entry.name,status:job?job.status:entry.status,position:index};
  });
}
function project(queue,jobs,{playingPath=null,windowSize=0,cursor=-1,
  legacyQueueId=null}={}){
  const entries=queue?.entries||[];
  const counts=Object.create(null);
  for(const status of COUNTED_JOB_STATES)counts[status]=0;
  const {jobsByIndex,legacyQueueRunning}=indexJobs(queue?.root,jobs,counts,legacyQueueId);
  let playingPosition=-1,keptCount=0,deletedCount=0,missingCount=0;
  for(let index=0;index<entries.length;index++){
    const entry=entries[index];
    if(entry.status==="KEEP")keptCount++;
    else if(entry.status==="DELETED")deletedCount++;
    else if(entry.status==="MISSING")missingCount++;
    if(playingPath!==null&&playingPosition<0&&entry.path===playingPath)
      playingPosition=index;
  }
  const anchor=playingPosition>=0?playingPosition:Math.max(0,cursor);
  const windowStart=entries.length>windowSize?
    Math.max(0,Math.min(anchor-Math.floor(windowSize/2),entries.length-windowSize)):0;
  const projected=entries.slice(windowStart,windowStart+windowSize).map((entry,i)=>{
    const index=windowStart+i;
    const job=jobsByIndex.get(index)?.get(entry.path);
    return {name:entry.name,status:job?job.status:entry.status,position:index};
  });
  return {playingPosition,keptCount,deletedCount,missingCount,counts,
    hasUnknown:counts.UNKNOWN>0,legacyQueueRunning,windowStart,entries:projected};
}
module.exports={project,projectWindow};
