"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const Nas=require("../src/nas-source.cjs");

const mounts=[
  "/dev/disk7s1 on /System/Volumes/Data (apfs, local, journaled)",
  "//alice@nas.local/Movies on /Volumes/Movies (smbfs, nodev, nosuid, mounted by alice)",
  "//alice@nas.local/Other on /Volumes/Other (smbfs, nodev, nosuid)"
].join("\n");

test("recognizes exactly an existing SMB mount and its selected subfolder",()=>{
 const r=Nas.probe("/Volumes/Movies/Series",mounts);
 assert.equal(r.allowed,true);
 assert.equal(r.mountPoint,"/Volumes/Movies");
 assert.equal(r.root,"/Volumes/Movies/Series");
 assert.match(r.binding,/^[a-f0-9]{8}$/);
 assert.equal(Nas.probe("/Volumes/Other",mounts).allowed,true);
 assert.notEqual(Nas.probe("/Volumes/Other",mounts).binding,r.binding);
});
test("NAS mount identity excludes user account and preserves change detection",()=>{
 const a=Nas.probe("/Volumes/Movies/Series",mounts);
 const next=mounts.replace("alice@nas.local/Movies","bob@nas.local/Movies");
 const changed=mounts.replace("alice@nas.local/Movies","bob@new-nas.local/Movies");
 assert.equal(Nas.probe("/Volumes/Movies/Series",next).binding,a.binding);
 assert.notEqual(Nas.probe("/Volumes/Movies/Series",changed).binding,a.binding);
 assert.equal(JSON.stringify(a).includes("alice"),false);
});
test("rejects paths and shares without a proven active smbfs mount",()=>{
 for(const path of [
   "/Volumes/Movies2","/Volumes/Unknown", "/Volumes/Data",
   "/Volumes/Movies/../Other", "/Volumes/Movies//Series",
   "/Volumes/Movies/./Series", "/Volumes/Movies\\foo",
   "/Volumes/Movies/%2e%2e/Other", "/private/tmp/test", "/Volumes",
   "/Volumes/Movies/\u0000bad", "/Volumes/.hidden"
 ]){
   assert.equal(Nas.probe(path,mounts).allowed,false,path);
 }
 assert.equal(Nas.probe("/Volumes/Movies",mounts.replace(/smbfs/g,"apfs")).allowed,false);
 assert.equal(Nas.probe("/Volumes/Movies","").allowed,false);
});
test("mount parser does not accept source path strings or fake mount type",()=>{
 const spoof="/dev/disk3 on /Volumes/Movies (apfs, local)\n";
 assert.equal(Nas.probe("/Volumes/Movies",spoof).allowed,false);
 assert.equal(Nas.probe("/Volumes/Movies","//u@host/share on /Volumes/Movies (webdav, nodev)").allowed,false);
 assert.equal(Nas.probe("smb://host/share",mounts).allowed,false);
});
