"use strict";
const Native=require("./thumbnail-cache.cjs");
const Nas=require("./nas-source.cjs");
const Sampling=require("./thumbnail-sampling.cjs");
const NAS_PAGE_SIZE=Sampling.NAS_PAGE_SIZE;
// Local fixtures read IINA's native cache; SMB Review sources use local
// FFmpeg JPEG cache only, never write to the source NAS folder.
function stamp(sec){
  const x=Math.max(0,Math.floor(sec));
  const h=Math.floor(x/3600),m=Math.floor(x%3600/60),s=x%60;
  return h?String(h)+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0"):
    String(m)+":"+String(s).padStart(2,"0");
}
function createThumbnailOverlay({overlay,core,file,utils,input,preferences,getCurrentPath,
  generatePreviewFrames=null,log=()=>{}}={}){
  let visible=false,ready=false,target="",images=[],generation=0,loadPromise=Promise.resolve();
  let intervalMinutes=Sampling.DEFAULT_INTERVAL_MINUTES;
  let page=0;
  let mode="auto";
  let prefetch=null,prefetchPromise=Promise.resolve();
  try{
    const stored=preferences?.get("thumbnail_interval_minutes");
    const minutes=Number(stored);
    if(stored!==null&&stored!==undefined&&
       Number.isInteger(minutes)&&minutes>=Sampling.MIN_INTERVAL_MINUTES&&
       minutes<=Sampling.MAX_INTERVAL_MINUTES)intervalMinutes=minutes;
  }catch(_){}
  try{
    const stored=preferences?.get("thumbnail_decode_mode");
    if(["auto","videotoolbox","software"].includes(stored))mode=stored;
  }catch(_){}
  function isNas(path){return typeof path==="string"&&!!Nas.normalize(path);}
  function sameMedia(){
    return visible && target && getCurrentPath?.()===target;
  }
  function invalidatePrefetch(){
    if(prefetch)prefetch.active=false;
    prefetch=null;
  }
  function close({keepPrefetch=false}={}){
    ++generation;
    if(!keepPrefetch)invalidatePrefetch();
    const wasVisible=visible;
    visible=false;target="";images=[];page=0;
    if(ready && wasVisible){
      try{overlay.hide();overlay.setClickable(false);}catch(_){}
    }
    if(wasVisible)log("thumbnail.closed",{});
  }
  function render(message){
    if(!ready||!visible)return;
    const nas=isNas(target);
    let plan=null;
    try{
      plan=Sampling.calculateSamplePlan(Number(core?.status?.duration),intervalMinutes,nas);
    }catch(_){}
    const pageCount=nas&&plan?Math.ceil(plan.count/NAS_PAGE_SIZE):1;
    const currentPage=Math.min(page,pageCount-1);
    const tiles=images.map((x,i)=>
      '<button data-clickable class="tile" type="button" onclick="iina.postMessage(\'thumbnail-seek\','+
      i+')" aria-label="Jump to '+stamp(x.time)+'">'+
      '<img alt="" draggable="false" src="'+x.image+'">'+
      '<span>'+stamp(x.time)+'</span></button>').join("");
    const body=images.length?
      '<div class="grid">'+tiles+'</div>':
      '<p class="status">'+(message||"Loading cached thumbnails…")+'</p>';
    overlay.setContent(
      '<div class="shade"></div><section class="panel">'+
      '<div class="header"><strong>REVIEW · TIMELINE</strong>'+
      '<span>'+(nas?("Local preview generation"+(message?" · "+message:"")+" · NAS read-only"):
        "Native IINA cache only")+'</span>'+
      '<label>Interval <input data-clickable type="number" min="1" max="60" step="1" value="'+
      intervalMinutes+'" style="width:58px" onchange="iina.postMessage(\'thumbnail-interval\',Number(this.value))"> min/sample</label>'+
      (plan?'<span>'+plan.count+' samples'+
        (plan.capped?' (max '+plan.maxSamples+
          '; effective '+plan.actualMinutes.toFixed(1)+' min/sample)':
          ' · ~'+plan.actualMinutes.toFixed(1)+' min/sample')+'</span>':"")+
      (nas&&plan?
        '<button data-clickable type="button" '+(currentPage<=0?'disabled ':'')+
          'onclick="iina.postMessage(\'thumbnail-page\',-1)">Previous</button>'+
        '<span>Page '+(currentPage+1)+' / '+pageCount+'</span>'+
        '<button data-clickable type="button" '+(currentPage>=pageCount-1?'disabled ':'')+
          'onclick="iina.postMessage(\'thumbnail-page\',1)">Next</button>':"")+
      (nas?'<label>Decoder <select data-clickable onchange="iina.postMessage(\'thumbnail-mode\',this.value)">'+
        [["auto","Auto"],["videotoolbox","VideoToolbox"],["software","Software"]]
          .map(([key,label])=>'<option value="'+key+'"'+(mode===key?' selected':'')+'>'+label+'</option>').join("")+
        '</select></label>':"")+
      '<button data-clickable type="button" onclick="iina.postMessage(\'thumbnail-retry\',null)">Refresh</button>'+
      '<button data-clickable type="button" onclick="iina.postMessage(\'thumbnail-close\',null)">Close</button></div>'+
      body+'</section>'
    );
  }
  function setup(){
    if(ready)return true;
    if(!overlay||typeof overlay.simpleMode!=="function" ||
       typeof overlay.setContent!=="function"||
       typeof overlay.setClickable!=="function"||
       typeof overlay.onMessage!=="function"||
       typeof overlay.setStyle!=="function")return false;
    overlay.simpleMode();
    overlay.setStyle(
      "*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#fff;font:12px -apple-system,BlinkMacSystemFont,sans-serif}"+
      ".shade{position:fixed;inset:0;background:rgba(0,0,0,.66);pointer-events:none}"+
      ".panel{position:fixed;inset:6% 4%;display:flex;flex-direction:column;gap:12px;min-width:0}"+
      ".header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:rgba(20,24,29,.93);border-radius:9px;padding:9px 12px}"+
      ".header span{opacity:.75;flex:1}.header button,.header select,.header input{border:1px solid #61646b;border-radius:6px;color:#fff;background:#333;padding:7px 11px;cursor:pointer}"+
      ".grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:9px;overflow:auto}"+
      ".tile{position:relative;padding:0;border:1px solid #6d7078;border-radius:8px;overflow:hidden;background:#17191c;color:white;cursor:pointer;min-width:0;min-height:0}"+
      ".tile:hover,.tile:focus{outline:2px solid #e6bc57}.tile img{width:100%;height:100%;display:block;object-fit:cover}"+
      ".tile span{position:absolute;left:7px;bottom:7px;padding:3px 5px;border-radius:4px;background:rgba(0,0,0,.7)}"+
      ".tile img,.tile span{pointer-events:none}"+
      ".status{padding:22px;background:#252831;border-radius:8px;text-align:center;align-self:center}"
    );
    overlay.onMessage("thumbnail-seek",index=>{
      // Separately log bridge receipt and guarded Seek outcome. Until
      // IINA delivers this event, no diagnostic can prove a tile was clicked.
      // These reason codes never include video paths or user-entered text.
      log("thumbnail.click.received",{});
      if(!visible){
        log("thumbnail.seek.rejected",{reason:"overlay_not_visible"},"warn");
        return;
      }
      if(!sameMedia()){
        log("thumbnail.seek.rejected",{reason:"media_mismatch"},"warn");
        close();
        return;
      }
      if(!Native.isSafeIndex(index,images)){
        log("thumbnail.seek.rejected",{reason:"invalid_index"},"warn");
        return;
      }
      const seek=images[index].time;
      if(!Number.isFinite(seek)||seek<0){
        log("thumbnail.seek.rejected",{reason:"invalid_time"},"warn");
        return;
      }
      try{
        core.seekTo(seek);
        log("thumbnail.seek.accepted",{targetSeconds:seek});
      }catch(_){log("thumbnail.seek.rejected",{reason:"seek_failed"},"warn");}
      close({keepPrefetch:true});
    });
    overlay.onMessage("thumbnail-close",()=>{
      log("thumbnail.control.received",{reason:"close"});
      close({keepPrefetch:true});
    });
    overlay.onMessage("thumbnail-retry",()=>{
      log("thumbnail.control.received",{reason:"refresh"});
      if(!sameMedia())return;
      invalidatePrefetch();
      beginLoad(target);
    });
    overlay.onMessage("thumbnail-page",delta=>{
      if(!isNas(target)||!sameMedia()||!Number.isInteger(delta)||
         ![-1,1].includes(delta))return;
      let plan;
      try{
        plan=Sampling.calculateSamplePlan(
          Number(core?.status?.duration),intervalMinutes,true);
      }catch(_){return;}
      const lastPage=Math.ceil(plan.count/NAS_PAGE_SIZE)-1;
      const nextPage=page+delta;
      if(nextPage<0||nextPage>lastPage)return;
      page=nextPage;
      beginLoad(target);
    });
    overlay.onMessage("thumbnail-interval",value=>{
      log("thumbnail.control.received",{reason:"sample_interval"});
      const n=Number(value);
      if(!Number.isInteger(n)||n<Sampling.MIN_INTERVAL_MINUTES||
         n>Sampling.MAX_INTERVAL_MINUTES||!sameMedia())return;
      intervalMinutes=n;
      page=0;
      invalidatePrefetch();
      try{
        preferences?.set("thumbnail_interval_minutes",n);
        preferences?.sync();
      }catch(_){log("thumbnail.interval.save_failed",{},"warn");}
      beginLoad(target);
    });
    overlay.onMessage("thumbnail-mode",value=>{
      if(!isNas(target)||!sameMedia()||
        !["auto","videotoolbox","software"].includes(value))return;
      mode=value;
      invalidatePrefetch();
      try{
        preferences?.set("thumbnail_decode_mode",mode);
        preferences?.sync();
      }catch(_){log("thumbnail.mode.save_failed",{},"warn");}
      beginLoad(target);
    });
    ready=true;
    return true;
  }
  async function loadCached(path,token,plan){
    const {duration,count}=plan;
    if(!utils?.exec||!utils?.resolvePath||!file?.exists||!file?.handle)
      throw new Error("file_api_unavailable");
    // Work only on the explicitly authorized disposable local Review item.
    if(!path.startsWith("/private/tmp/iina-nas-review-fixture-"))
      throw new Error("source_not_allowed");
    const video=await utils.exec("/usr/bin/stat",["-f","%z %m",path]);
    if(video?.status!==0)throw new Error("video_stat_failed");
    const m=String(video.stdout||"").trim().match(/^(\d+)\s+(\d+)$/);
    if(!m)throw new Error("video_metadata_invalid");
    const size=Number(m[1]),mtime=Number(m[2]);
    const hash=await utils.exec("/sbin/md5",["-qs",path]);
    if(hash?.status!==0)throw new Error("cache_hash_failed");
    const name=String(hash.stdout||"").trim().toLowerCase();
    if(!/^[0-9a-f]{32}$/.test(name))throw new Error("cache_name_invalid");
    const dir=String(utils.resolvePath("~/Library/Caches/com.colliderli.iina/thumb_cache")||"");
    if(!dir.startsWith("/")||dir.includes(".."))throw new Error("cache_dir_invalid");
    const cachedPath=dir.replace(/\/$/,"")+"/"+name;
    if(!file.exists(cachedPath))throw new Error("cache_unavailable");
    const info=await utils.exec("/usr/bin/stat",["-f","%z",cachedPath]);
    if(info?.status!==0)throw new Error("cache_stat_failed");
    const length=Number(String(info.stdout||"").trim());
    if(!Number.isSafeInteger(length)||length<17||length>Native.MAX_CACHE_BYTES)
      throw new Error("cache_size_invalid");
    if(token!==generation||!sameMedia()||path!==target)return [];
    const handle=file.handle(cachedPath,"read");
    let raw;
    try{raw=handle.readToEnd();}finally{handle.close();}
    if(raw.byteLength!==length)throw new Error("cache_size_changed");
    return Native.parseCache(raw,{size,mtime,duration,count});
  }
  function prefetchValid(state){
    return state?.active===true && getCurrentPath?.()===state.path &&
      prefetch===state;
  }
  function cachePage(state,index,data){
    // Retain first page for instant 0 and one other page only. The generator
    // persists all pages to local JPEG cache, so long videos stay memory-safe.
    state.pages.set(index,data);
    for(const key of state.pages.keys())
      if(key!==0 && key!==index)state.pages.delete(key);
  }
  function requestPage(state,index){
    if(!prefetchValid(state))return Promise.resolve([]);
    if(state.pages.has(index))return Promise.resolve(state.pages.get(index));
    if(state.jobs.has(index))return state.jobs.get(index);
    let execution;
    try{execution=generatePreviewFrames(state.path,{
      duration:state.plan.duration,count:state.plan.count,mode:state.mode,
      startIndex:index*NAS_PAGE_SIZE,pageSize:NAS_PAGE_SIZE,
      isCancelled:()=>!prefetchValid(state),
      onProgress:progress=>{
        if(!prefetchValid(state))return;
        state.partials.set(index,progress.images);
        if(visible && target===state.path && page===index){
          images=progress.images;
          render("Generated "+progress.completed+"/"+progress.total);
        }
      }
    });}catch(error){execution=Promise.reject(error);}
    const task=Promise.resolve(execution).then(result=>{
      if(!prefetchValid(state))return [];
      cachePage(state,index,result);
      state.partials.delete(index);
      return result;
    }).finally(()=>state.jobs.delete(index));
    state.jobs.set(index,task);
    return task;
  }
  function startPrefetch(path){
    if(!isNas(path) || getCurrentPath?.()!==path ||
       typeof generatePreviewFrames!=="function")return null;
    let plan;
    try{
      plan=Sampling.calculateSamplePlan(
        Number(core?.status?.duration),intervalMinutes,true);
    }catch(_){return null;}
    if(prefetchValid(prefetch)&&prefetch.mode===mode &&
       prefetch.interval===intervalMinutes &&
       prefetch.plan.duration===plan.duration)return prefetch;
    invalidatePrefetch();
    const state={path,plan,mode,interval:intervalMinutes,active:true,
      pages:new Map(),jobs:new Map(),partials:new Map()};
    prefetch=state;
    // Generate one page at a time, honoring the existing serial decoder.
    // Interactive page requests can join an in-flight generation.
    prefetchPromise=(async()=>{
      const total=Math.ceil(plan.count/NAS_PAGE_SIZE);
      for(let index=0;index<total&&prefetchValid(state);index++){
        try{await requestPage(state,index);}
        catch(_){
          if(prefetchValid(state))
            log("thumbnail.prefetch.failed",{reason:"page_unavailable"},"warn");
          return;
        }
      }
      if(prefetchValid(state))log("thumbnail.prefetch.finished",{pages:total});
    })();
    log("thumbnail.prefetch.started",{pages:Math.ceil(plan.count/NAS_PAGE_SIZE)});
    return state;
  }
  function prefetchCurrent(){
    const path=getCurrentPath?.();
    if(isNas(path))startPrefetch(path);
    return prefetchPromise;
  }
  function beginLoad(path){
    const token=++generation;
    const nas=isNas(path);
    const state=nas?startPrefetch(path):null;
    images=state?(state.pages.get(page)||state.partials.get(page)||[]):[];
    render(nas?"Preparing previews in background…":"Loading cached thumbnails…");
    loadPromise=(async()=>{
      try{
        const plan=Sampling.calculateSamplePlan(
          Number(core?.status?.duration),intervalMinutes,nas);
        if(nas&&typeof generatePreviewFrames!=="function")
          throw new Error("preview_generator_unavailable");
        const data=nas?
          await (state?requestPage(state,page):Promise.reject(
            Error("duration_unavailable"))):
          await loadCached(path,token,plan);
        if(token!==generation||!sameMedia()||path!==target)return;
        images=data;
        render();
        log(nas?"thumbnail.generated.ready":"thumbnail.cache.ready",{count:images.length});
      }catch(error){
        if(token!==generation||!sameMedia())return;
        images=[];
        const reason=String(error?.message||"cache_unavailable");
        log(nas?"thumbnail.generate.failed":"thumbnail.cache.unavailable",{
          reason:/^[a-z_]{3,40}$/.test(reason)?reason:"cache_invalid"
        },"warn");
        render(nas?
          "Preview generation unavailable. Verify FFmpeg, SMB connectivity and duration; then Refresh.":
          "Native IINA thumbnail cache unavailable. Play video, wait for IINA thumbnails, then Refresh.");
      }
    })();
  }
  async function toggle(){
    if(visible){close({keepPrefetch:true});return true;}
    const path=getCurrentPath?.();
    if(typeof path!=="string"||
      !(path.startsWith("/private/tmp/iina-nas-review-fixture-")||
        (isNas(path)&&typeof generatePreviewFrames==="function")))return false;
    try{
      if(!setup()){log("thumbnail.unavailable",{reason:"overlay_api_unavailable"},"warn");return false;}
      visible=true;target=path;page=0;
      overlay.setClickable(true);
      overlay.show();
      log("thumbnail.opened");
      beginLoad(path);
      return true;
    }catch(_){close();log("thumbnail.unavailable",{reason:"overlay_setup_failed"},"warn");return false;}
  }
  function register(){
    if(!setup())return false;
    if(!input?.normalizeKeyCode||!input?.getAllKeyBindings||!input?.onKeyDown)return false;
    try{
      const key=input.normalizeKeyCode("0");
      const bindings=input.getAllKeyBindings();
      if(!key || !bindings || Object.prototype.hasOwnProperty.call(bindings,key)){
        log("thumbnail.key.unavailable",{reason:"binding_conflict"},"warn");return false;
      }
      input.onKeyDown("0",({isRepeat}={})=>{
        if(isRepeat||!getCurrentPath?.())return false;
        void toggle();
        return true;
      },input.PRIORITY_HIGH);
      log("thumbnail.key.registered",{enabled:true});
      return true;
    }catch(_){log("thumbnail.key.unavailable",{reason:"registration_failed"},"warn");return false;}
  }
  function onFileLoaded(){
    close();
    void prefetchCurrent();
  }
  return {toggle,close,register,onFileLoaded,prefetchCurrent,
    waitForLoad:()=>loadPromise,waitForPrefetch:()=>prefetchPromise};
}
module.exports={createThumbnailOverlay};
