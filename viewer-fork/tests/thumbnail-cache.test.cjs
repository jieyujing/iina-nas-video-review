"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const Cache=require("../src/thumbnail-cache.cjs");
function fixture({size=1234,mtime=1700000000,times=[5,15,25,35],invalid=false}={}){
 const header=Buffer.alloc(17);
 header[0]=2;header.writeBigUInt64LE(BigInt(size),1);header.writeBigInt64LE(BigInt(mtime),9);
 const rows=times.map((t,i)=>{
  const jpeg=Buffer.from(invalid?[0,0,i,0]:[0xff,0xd8,i,0xff,0xd9]);
  const row=Buffer.alloc(16);
  row.writeBigInt64LE(BigInt(jpeg.length+8),0);row.writeDoubleLE(t,8);
  return Buffer.concat([row,jpeg]);
 });
 return new Uint8Array(Buffer.concat([header,...rows]));
}
test("reads IINA v2 cache in read-only byte parser, selecting timeline by duration",()=>{
 const all=Cache.parseCache(fixture(),{size:1234,mtime:1700000000,duration:40,count:4});
 assert.equal(all.length,4);
 assert.deepEqual(all.map(x=>x.time),[5,15,25,35]);
 assert.ok(all.every(x=>x.image.startsWith("data:image/jpeg;base64,")));
});
test("cache cannot silently load replaced video or unsupported cache version",()=>{
 assert.throws(()=>Cache.parseCache(fixture(),{size:999,mtime:1700000000,duration:40,count:4}),/stale/i);
 assert.throws(()=>Cache.parseCache(fixture(),{size:1234,mtime:1,duration:40,count:4}),/stale/i);
 const bad=fixture();bad[0]=3;
 assert.throws(()=>Cache.parseCache(bad,{size:1234,mtime:1700000000,duration:40,count:4}),/version/i);
});
test("rejects corrupt blocks, fake JPEGs, unbounded caches and malformed metadata",()=>{
 assert.throws(()=>Cache.parseCache(fixture({invalid:true}),{size:1234,mtime:1700000000,duration:40,count:4}),/jpeg|thumbnail/i);
 const tiny=fixture().slice(0,20);
 assert.throws(()=>Cache.parseCache(tiny,{size:1234,mtime:1700000000,duration:40,count:4}),/truncated/i);
 assert.throws(()=>Cache.parseCache(new Uint8Array(16*1024*1024+1),{size:1234,mtime:1,duration:40,count:4}),/large/i);
 assert.throws(()=>Cache.parseCache(fixture(),{size:1234,mtime:1700000000,duration:Infinity,count:4}),/duration/i);
});
test("supports 10 to 100 read-only thumbnails and clamps indices safely",()=>{
 const images=Cache.parseCache(fixture(),{size:1234,mtime:1700000000,duration:40,count:20});
 assert.equal(images.length,20);
 assert.equal(Cache.isSafeIndex(0,images),true);
 assert.equal(Cache.isSafeIndex(20,images),false);
 assert.equal(Cache.isSafeIndex("0",images),false);
 assert.equal(Cache.isSafeIndex(-1,images),false);
 assert.throws(()=>Cache.parseCache(fixture(),{size:1234,mtime:1700000000,duration:40,count:101}),/count/i);
});
test("repeated native JPEG sampling has a bounded overlay payload",()=>{
 const header=Buffer.alloc(17);header[0]=2;
 header.writeBigUInt64LE(1234n,1);header.writeBigInt64LE(1700000000n,9);
 const jpeg=Buffer.alloc(180000);jpeg[0]=255;jpeg[1]=216;
 jpeg[jpeg.length-2]=255;jpeg[jpeg.length-1]=217;
 const block=Buffer.alloc(16);
 block.writeBigUInt64LE(BigInt(jpeg.length+8),0);
 block.writeDoubleLE(10,8);
 const raw=new Uint8Array(Buffer.concat([header,block,jpeg]));
 assert.throws(()=>Cache.parseCache(raw,{size:1234,mtime:1700000000,duration:40,count:100}),/payload|large|budget/i);
});
