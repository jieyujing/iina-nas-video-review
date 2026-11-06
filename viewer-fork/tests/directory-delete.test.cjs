"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDirectoryDelete}=require("../src/directory-delete.cjs");
const root="/Volumes/Media/Review",parent=root;
const name="Season 1",target=parent+"/"+name;
function setup({mount=true,stale=false,symlink=false,confirmAt=0,
    unknown=false,fail=false,journalFail=false,playing="",reviewBusy=false,
    alteredRoot=false,changedContents=false,initialJournal=null}={}){
 const rows=new Map([[parent,[{filename:name,path:"/"+name,isDir:true}]],
   [target,[{filename:"episode.mkv",path:"/episode.mkv",isDir:false}]]]);
 const events=[],journal=[initialJournal],calls={rm:[],ask:[]};
 let selected={enabled:true,reviewBusy,root,parent,name,binding:"smb-source",epoch:1};
 const c=createDirectoryDelete({
  state:data=>({...selected,...data}),
  mountProbe:async()=>mount?{allowed:true,binding:"smb-source",mountPoint:"/Volumes/Media"}:
    {allowed:false},
  stat:async path=>({type:symlink&&path===target?"link":"dir",
    identity:(alteredRoot && path===target?"40755|77|777|3|2":"40755|77|123|3|2")}),
  list:path=>rows.get(path)||[],
  confirm:async q=>{calls.ask.push(q);if(confirmAt===calls.ask.length)return false;
    if(stale&&calls.ask.length===1)selected={...selected,name:"Season 2"};
    if(changedContents&&calls.ask.length===1)
      rows.get(target).push({filename:"new-file.mp4",path:"/new-file.mp4",isDir:false});
    return true;},
  journal:{read:async()=>journal[0],write:async row=>{
    if(journalFail)throw Error("simulated disk full");
    journal[0]=row;events.push(row.state);
  }},
  deleteTree:async path=>{
    calls.rm.push(path);
    if(unknown)return null;
    if(fail)return {status:1};
    rows.set(parent,[]);
    rows.delete(target);
    return {status:0};
  },
  playingPath:()=>playing
 });
 return {c,calls,events,journal,rows,selected:()=>selected};
}
test("directory deletion requires two independent native confirmations and journal",async()=>{
 const h=setup();
 const r=await h.c.request();
 assert.equal(r.status,"DELETED",r.reason);
 assert.equal(r.observedAbsent,true);
 assert.deepEqual(h.calls.rm,[target]);
 assert.deepEqual(h.calls.ask.map(x=>x.stage),["initial","final"]);
 assert.equal(h.calls.ask[0].childCount,1);
 assert.equal(h.calls.ask[0].path,target);
 assert.equal(h.calls.ask[1].path,target);
 assert.deepEqual(h.events,["INTENT","ISSUED","RM_EXIT_ZERO","DELETED_OBSERVED"]);
});
test("first or final cancel cannot remove directory",async()=>{
 for(const confirmAt of [1,2]){
  const h=setup({confirmAt});
  assert.equal((await h.c.request()).status,"CANCELLED");
  assert.deepEqual(h.calls.rm,[]);
  assert.deepEqual(h.events,[]);
 }
});
test("SMB mount, review checkpoint, symlink and current media deny recursive deletion",async()=>{
 for(const opts of [{mount:false},{reviewBusy:true},{symlink:true},
   {playing:target+"/episode.mkv"}]){
  const h=setup(opts);
  const result=await h.c.request();
  assert.equal(result.status,"REFUSED");
  assert.deepEqual(h.calls.rm,[]);
 }
});
test("untrusted paths may not delete root, mountpoint, parents or hidden folders",async()=>{
 for(const entry of [
  {root,parent,name:".."},
  {root,parent,name:".iina-nas-review"},
  {root,parent:root+"/../Other",name},
  {root:"/Volumes/Media",parent:"/Volumes",name},
  {root,parent,name:"Season/../Backups"},
  {root:"/tmp/Example",parent:"/tmp/Example",name}
 ]){
  const h=setup();
  const result=await h.c.request(entry);
  assert.equal(result.status,"REFUSED");
  assert.deepEqual(h.calls.rm,[]);
 }
});
test("source changes after confirmation fail closed",async()=>{
 const h=setup({stale:true});
 const r=await h.c.request();
 assert.equal(r.status,"REFUSED");
 assert.equal(r.reason,"SOURCE_CHANGED");
 assert.deepEqual(h.calls.rm,[]);
});
test("journal failures stop all destructive commands",async()=>{
 const h=setup({journalFail:true});
 assert.equal((await h.c.request()).reason,"JOURNAL_UNAVAILABLE");
 assert.deepEqual(h.calls.rm,[]);
});
test("indeterminate command is journaled UNKNOWN and cannot be retried",async()=>{
 const h=setup({unknown:true});
 assert.equal((await h.c.request()).status,"UNKNOWN");
 assert.equal(h.journal[0].state,"UNKNOWN");
 assert.equal((await h.c.request()).reason,"PREVIOUS_DELETE_UNKNOWN");
 assert.deepEqual(h.calls.rm,[target]);
});
test("nonzero recursive rm may be partial and is always UNKNOWN",async()=>{
 const h=setup({fail:true});
 const r=await h.c.request();
 assert.equal(r.status,"UNKNOWN");
 assert.equal(r.reason,"RM_EXIT_NONZERO_MAY_BE_PARTIAL");
 assert.equal(r.exitCode,1);
 assert.equal(h.journal[0].state,"UNKNOWN");
 assert.equal((await h.c.request()).reason,"PREVIOUS_DELETE_UNKNOWN");
 assert.deepEqual(h.calls.rm,[target]);
});
test("content added after the first confirmation prevents recursive deletion",async()=>{
 const h=setup({changedContents:true});
 const r=await h.c.request();
 assert.equal(r.reason,"DIRECTORY_CONTENTS_CHANGED");
 assert.deepEqual(h.calls.rm,[]);
 assert.deepEqual(h.events,[]);
});
test("missing-folder reconciliation refuses a replaced parent directory",async()=>{
 const h=setup({initialJournal:{id:"prior",state:"UNKNOWN",root,parent,name,
   mountIdentity:"smb-source",parentIdentity:"40755|77|999|3|2"}});
 h.rows.set(parent,[]);
 assert.equal((await h.c.reconcileMissing()).reason,"PARENT_IDENTITY_CHANGED");
 assert.deepEqual(h.calls.rm,[]);
});
test("missing-folder reconciliation refuses replacement symlinks with the same name",async()=>{
 const h=setup({initialJournal:{id:"prior",state:"UNKNOWN",root,parent,name,
   mountIdentity:"smb-source",parentIdentity:"40755|77|123|3|2"}});
 h.rows.set(parent,[{filename:name,path:"/"+name,isDir:false,isSymlink:true}]);
 assert.equal((await h.c.reconcileMissing()).reason,"DIRECTORY_STILL_PRESENT");
 assert.deepEqual(h.calls.rm,[]);
});
test("UNKNOWN reconciliation never deletes and requires verified absence",async()=>{
 const h=setup({initialJournal:{id:"prior",state:"UNKNOWN",
   root,parent,name,mountIdentity:"smb-source",parentIdentity:"40755|77|123|3|2"}});
 assert.equal((await h.c.reconcileMissing()).reason,"DIRECTORY_STILL_PRESENT");
 h.rows.set(parent,[]);
 assert.equal((await h.c.reconcileMissing()).status,"RECONCILED");
 assert.equal(h.journal[0].state,"RECONCILED_MISSING");
 assert.deepEqual(h.calls.rm,[]);
});
