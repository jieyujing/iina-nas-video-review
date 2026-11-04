"use strict";
// Read-only parser for IINA's native v2 thumbnail cache, adapted from the
// project's preserved MIT Thumbnails fork. No video decoding or file writes.
const MAX_CACHE_BYTES=16*1024*1024;
const MAX_JPEG_BYTES=2*1024*1024;
const MAX_RECORDS=2000;
const MAX_RENDER_BYTES=12*1024*1024;
const B64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(data){
  let text="";
  for(let i=0;i<data.length;i+=3){
    const a=data[i], b=i+1<data.length?data[i+1]:0, c=i+2<data.length?data[i+2]:0;
    const n=(a<<16)|(b<<8)|c;
    text+=B64[(n>>>18)&63]+B64[(n>>>12)&63]+
      (i+1<data.length?B64[(n>>>6)&63]:"=")+
      (i+2<data.length?B64[n&63]:"=");
  }
  return text;
}
function readU64(view,offset){
  const low=view.getUint32(offset,true), high=view.getUint32(offset+4,true);
  const value=high*4294967296+low;
  if(!Number.isSafeInteger(value))throw new Error("Cache integer outside safe range");
  return value;
}
function isSafeIndex(index,items){
  return Number.isInteger(index)&&index>=0&&Array.isArray(items)&&index<items.length;
}
function parseCache(bytes,{size,mtime,duration,count=20}={}){
  if(!Number.isInteger(count)||count<1||count>100)throw new Error("Invalid thumbnail count");
  if(!Number.isFinite(duration)||duration<=0||duration>86400)throw new Error("Invalid media duration");
  if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(mtime)||mtime<0)
    throw new Error("Invalid media metadata");
  if(!(bytes instanceof Uint8Array))throw new Error("Invalid cache bytes");
  if(bytes.byteLength>MAX_CACHE_BYTES)throw new Error("Cache too large");
  if(bytes.byteLength<17)throw new Error("Truncated cache header");
  if(bytes[0]!==2)throw new Error("Unsupported IINA thumbnail cache version");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const cacheSize=readU64(view,1),cacheMtime=readU64(view,9);
  if(cacheSize!==size || cacheMtime!==mtime)throw new Error("Stale IINA thumbnail cache");
  let pos=17;
  const records=[];
  while(pos<bytes.byteLength){
    if(records.length>=MAX_RECORDS)throw new Error("Too many thumbnail records");
    if(pos+16>bytes.byteLength)throw new Error("Truncated thumbnail header");
    const block=readU64(view,pos),time=view.getFloat64(pos+8,true);
    pos+=16;
    const length=block-8;
    if(block<8||length<4||length>MAX_JPEG_BYTES||pos+length>bytes.byteLength)
      throw new Error("Invalid thumbnail block length");
    const jpg=bytes.subarray(pos,pos+length);pos+=length;
    if(jpg[0]!==255||jpg[1]!==216||jpg[length-2]!==255||jpg[length-1]!==217)
      continue;
    if(Number.isFinite(time)&&time>=0&&time<=duration+2)
      records.push({time,image:"data:image/jpeg;base64,"+toBase64(jpg)});
  }
  if(!records.length)throw new Error("Cache contains no valid JPEG thumbnails");
  const selected=[];
  let outputBytes=0;
  for(let i=0;i<count;i++){
    const target=duration*(i+0.5)/count;
    let best=records[0],diff=Math.abs(best.time-target);
    for(let j=1;j<records.length;j++){
      const d=Math.abs(records[j].time-target);
      if(d<diff){best=records[j];diff=d;}
    }
    outputBytes+=best.image.length+100;
    if(outputBytes>MAX_RENDER_BYTES)throw new Error("Thumbnail render payload too large");
    selected.push({...best});
  }
  return selected;
}
module.exports={parseCache,isSafeIndex,toBase64,MAX_CACHE_BYTES};
