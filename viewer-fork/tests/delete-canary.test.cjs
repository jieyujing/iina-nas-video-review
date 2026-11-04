"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createDeleteCanary}=require("../src/delete-canary.cjs");

function fixture({rmFail=false,confirm=true,existingJournal=null,replaceBeforeRm=false}={}){
  const root="/Volumes/Media/review";
  const candidate=root+"/.iina-nas-review-delete-canary.ABC12345";
  let present=false,record=existingJournal,canaryStatCalls=0;
  const executions=[],changes=[];
  const api=createDeleteCanary({
    state:()=>({active:true,optIn:true,nasReadOnly:true,recursive:false,
      root,mountBinding:"share-1"}),
    mountProbe:async()=>({allowed:true,binding:"share-1",mountPoint:"/Volumes/Media"}),
    stat:async path=>path===root?
      {type:"dir",identity:"40755|18|23|80|1000"}:
      path===candidate&&present?{type:"file",identity:replaceBeforeRm&&++canaryStatCalls>1?
        "100644|18|51|0|1000":"100644|18|50|0|1000"}:null,
    confirm:async()=>confirm,
    exec:async (program,args)=>{
      executions.push([program,...args]);
      if(program==="/usr/bin/mktemp"){
        present=true;return {status:0,stdout:candidate+"\n"};
      }
      if(program==="/bin/rm"){
        if(rmFail)return {status:1,stdout:""};
        present=false;return {status:0,stdout:""};
      }
      throw Error("unexpected command");
    },
    exists:async path=>path===candidate&&present,
    journal:{read:async()=>record,write:async r=>{record=r;changes.push(r.state);}}
  });
  return {api,executions,changes,get record(){return record;},get present(){return present;},candidate};
}

test("a separate UNKNOWN media operation does not block a newly-created canary",async()=>{
  const f=fixture();
  assert.equal((await f.api.request()).status,"CANARY_DELETED");
  assert.deepEqual(f.executions.map(x=>x[0]),["/usr/bin/mktemp","/bin/rm"]);
  assert.deepEqual(f.executions[1],["/bin/rm","--",f.candidate]);
  assert.equal(f.present,false);
  assert.equal(f.record.state,"DELETED_OBSERVED");
});

test("no confirmation means no canary created and no delete attempted",async()=>{
  const f=fixture({confirm:false});
  assert.equal((await f.api.request()).status,"CANCELLED");
  assert.deepEqual(f.executions,[]);
});

test("a prior ambiguous canary attempt blocks any retry and preserves journal",async()=>{
  const existing={state:"UNKNOWN",id:"prior-canary"};
  const f=fixture({existingJournal:existing});
  assert.equal((await f.api.request()).reason,"CANARY_UNRESOLVED");
  assert.deepEqual(f.executions,[]);
  assert.deepEqual(f.record,existing);
});

test("failed rm becomes UNKNOWN without another delete or cleanup",async()=>{
  const f=fixture({rmFail:true});
  assert.equal((await f.api.request()).status,"UNKNOWN");
  assert.equal(f.record.state,"UNKNOWN");
  assert.equal(f.present,true);
  assert.equal((await f.api.request()).reason,"CANARY_UNRESOLVED");
  assert.equal(f.executions.filter(x=>x[0]==="/bin/rm").length,1);
});
test("canary replacement immediately before rm is refused without executing rm",async()=>{
  const f=fixture({replaceBeforeRm:true});
  assert.equal((await f.api.request()).status,"UNKNOWN");
  assert.equal(f.executions.filter(x=>x[0]==="/bin/rm").length,0);
  assert.equal(f.record.state,"UNKNOWN");
  assert.equal(f.present,true);
});
