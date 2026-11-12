"use strict";
// Per-page Strategy + Circuit Breaker: one failed hardware decode changes
// the remainder of this page to software, rather than failing every frame.
function createDecodePolicy({mode="auto",codec=""}={}){
 let hardware=mode==="videotoolbox" ||
   (mode==="auto" && ["hevc","h265"].includes(codec));
 return {
   get hardware(){return hardware;},
   fallback(){if(!hardware)return false;hardware=false;return true;}
 };
}
module.exports={createDecodePolicy};
