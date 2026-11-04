"use strict";
// A separate, self-created tiny disposable SMB file tests IINA's actual
// process-exec + delete + absence-observation path. NEVER accepts media paths.
// A separate durable journal avoids overwriting an old ambiguous media delete.
function createDeleteCanary({state,mountProbe,stat,confirm,exec,exists,journal}){
  let busy=false;
  const refuse=reason=>({status:"REFUSED",reason});
  const sameRoot=(a,b)=>{
    if(a===b)return true;
    const parse=s=>typeof s==="string"&&s.split("|").length===5&&
      s.split("|").every(x=>/^\d+$/.test(x))?s.split("|").slice(0,3):null;
    const x=parse(a),y=parse(b);
    return !!x&&!!y&&x.every((v,i)=>v===y[i]);
  };
  const validMount=(s,m)=>m?.allowed===true&&m.binding===s.mountBinding&&
    typeof m.mountPoint==="string"&&
    (s.root===m.mountPoint||s.root.startsWith(m.mountPoint+"/"));
  async function request(){
    if(busy)return refuse("OPERATION_IN_PROGRESS");
    busy=true;
    try{
      const s=state();
      if(!s?.active||!s?.optIn||!s?.nasReadOnly||s?.recursive||
        typeof s.root!=="string"||!s.root.startsWith("/Volumes/")||
        s.root.includes("..")||s.root.includes("\u0000"))
        return refuse("TEST_MODE_DISABLED");
      let old;
      try{old=await journal.read();}
      catch(_){return refuse("CANARY_JOURNAL_UNAVAILABLE");}
      if(old&&old.state!=="DELETED_OBSERVED")return refuse("CANARY_UNRESOLVED");
      let mount,root;
      try{
        mount=await mountProbe(s.root);
        root=await stat(s.root);
        if(!validMount(s,mount)||root?.type!=="dir"||!root.identity)
          return refuse("SMB_SOURCE_UNVERIFIED");
      }catch(_){return refuse("SMB_SOURCE_UNAVAILABLE");}
      let approved=false;
      try{approved=(await confirm())===true;}
      catch(_){return refuse("CONFIRMATION_UNAVAILABLE");}
      if(!approved)return {status:"CANCELLED"};
      const fresh=state();
      if(fresh?.root!==s.root||fresh?.mountBinding!==s.mountBinding||
         !fresh?.active||!fresh?.optIn)return refuse("REVIEW_CHANGED");
      const id="delete-canary-"+Date.now()+"-"+Math.random().toString(36).slice(2,12);
      const base={id,state:"INTENT",rootIdentity:root.identity,
        mountIdentity:mount.binding};
      try{
        await journal.write(base);
        const persisted=await journal.read();
        if(persisted?.id!==id||persisted.state!=="INTENT")
          return refuse("CANARY_JOURNAL_UNAVAILABLE");
      }catch(_){return refuse("CANARY_JOURNAL_UNAVAILABLE");}
      const template=s.root+"/.iina-nas-review-delete-canary.XXXXXXXX";
      let candidate;
      try{
        const made=await exec("/usr/bin/mktemp",[template]);
        if(Number(made?.status)!==0)throw Error("mktemp failed");
        candidate=String(made.stdout||"").trim();
        const baseName=candidate.slice(s.root.length+1);
        if(!candidate.startsWith(s.root+"/")||
           !/^\.iina-nas-review-delete-canary\.[A-Za-z0-9]{8}$/.test(baseName))
          throw Error("unexpected mktemp path");
        const proof=await mountProbe(s.root);
        const observedRoot=await stat(s.root);
        const file=await stat(candidate);
        if(!validMount(s,proof)||observedRoot?.type!=="dir"||
           !sameRoot(root.identity,observedRoot.identity)||
           file?.type!=="file"||!file.identity)throw Error("candidate changed");
        await journal.write({...base,state:"ISSUED",fileIdentity:file.identity});
        const issued=await journal.read();
        if(issued?.id!==id||issued?.state!=="ISSUED"||
           issued?.fileIdentity!==file.identity)throw Error("journal unreadable");
        const beforeRemoveMount=await mountProbe(s.root);
        const beforeRemoveRoot=await stat(s.root);
        const beforeRemoveFile=await stat(candidate);
        if(!validMount(s,beforeRemoveMount)||
           beforeRemoveRoot?.type!=="dir"||
           !sameRoot(root.identity,beforeRemoveRoot.identity)||
           beforeRemoveFile?.type!=="file"||
           beforeRemoveFile.identity!==file.identity)
          throw Error("canary identity changed before delete");
        // The only path supplied to rm is the exact new path returned by
        // mktemp and validated above. Never use a Review media path here.
        const removed=await exec("/bin/rm",["--",candidate]);
        if(Number(removed?.status)!==0)throw Error("rm failed");
        const finalMount=await mountProbe(s.root);
        const finalRoot=await stat(s.root);
        if(!validMount(s,finalMount)||finalRoot?.type!=="dir"||
           !sameRoot(root.identity,finalRoot.identity)||
           await exists(candidate)!==false)throw Error("deletion unverified");
        await journal.write({...base,state:"DELETED_OBSERVED",fileIdentity:file.identity});
        return {status:"CANARY_DELETED"};
      }catch(_){
        try{await journal.write({...base,state:"UNKNOWN"});}catch(_ignored){}
        // No automatic rm retry, even if the prior command reported failure.
        return {status:"UNKNOWN",reason:"CANARY_DELETE_INDETERMINATE"};
      }
    }finally{busy=false;}
  }
  return {request};
}
module.exports={createDeleteCanary};
