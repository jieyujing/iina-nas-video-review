"use strict";

// Explicit allowlist: logging must never record media paths, filenames,
// credential material, raw exception messages, or user-entered values.
const ALLOWED_KEYS=new Set([
  "count","total","cursor","kept","active","allowed","enabled",
  "accepted","matched","focused","repeat","next","source","reason",
  "stage","status","outcome","errorName","hasBinding","success",
  "targetSeconds","actualSeconds","paused","attempt","nearEnd",
  "progressClass","sequence","loadedIndex","loadedStatus","awaitingLoad","canAttach"]);
const EVENT_CODE=/^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_STRING=/^[a-zA-Z0-9_. -]{1,64}$/;
function safeData(data){
  const result={};
  if(!data || typeof data!=="object" || Array.isArray(data))return result;
  for(const key of Object.keys(data).slice(0,24)){
    if(!ALLOWED_KEYS.has(key))continue;
    const value=data[key];
    if(typeof value==="boolean")result[key]=value;
    else if(typeof value==="number" && Number.isFinite(value))result[key]=value;
    else if(typeof value==="string" && SAFE_STRING.test(value) &&
      !value.includes("..") && !value.includes("  "))result[key]=value;
  }
  return result;
}
function createDebugLogger({limit=200,now=()=>new Date(),sink=null}={}){
  const max=Math.max(1,Math.min(200,Number.isInteger(limit)?limit:200));
  const entries=[];
  let sequence=0;
  const session=Math.floor(Date.now()).toString(36)+"-"+Math.random().toString(36).slice(2,9);
  function log(event,data={},level="info"){
    const name=typeof event==="string"&&EVENT_CODE.test(event)?event:"unknown.event";
    const normalizedLevel=["info","warn","error"].includes(level)?level:"info";
    let timestamp;
    try{timestamp=now().toISOString();}catch(_){timestamp=new Date().toISOString();}
    const entry={
      id:"backend-"+session+"-"+(++sequence),
      at:timestamp,source:"backend",level:normalizedLevel,event:name,
      data:safeData(data)
    };
    entries.push(entry);
    if(entries.length>max)entries.splice(0,entries.length-max);
    try{if(typeof sink==="function")sink(entry);}catch(_){/* never break player */}
    return entry;
  }
  return {
    log,
    snapshot:()=>entries.map(entry=>({...entry,data:{...entry.data}})),
    clear:()=>{entries.length=0;},
    setSink(next){sink=typeof next==="function"?next:null;}
  };
}
module.exports={createDebugLogger,safeData};
