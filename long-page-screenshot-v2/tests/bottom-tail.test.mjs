import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBottomTail, bottomTail, TERMINAL_GEOMETRY_EPSILON, terminalNear } from '../capture/bottom-tail.js';
import { drawGeometry } from '../capture/geometry.js';
for(const remaining of [1,44,228])test(`terminal ${remaining}px maps only novel rows`,()=>{
 const height=6384+remaining,view={y:height-912,clientHeight:912,height,x:0,clientWidth:900,innerWidth:900,innerHeight:912};
 const a=bottomTail(view,6384);
 assert.equal(a.canonicalY,height-912);assert.equal(a.novelTop,6384);assert.equal(a.novelPixels,remaining);
 const d=drawGeometry({x:0,y:0,width:900,height},view,{x:0,right:900,y:a.novelTop,bottom:height},{sourceX:1,sourceY:1,scaleX:1,scaleY:1},0);
 assert.equal(d.sy,912-remaining);assert.equal(d.sh,remaining);assert.equal(d.dy,6384);assert.equal(d.dh,remaining);
});
test('reject non-bottom, large gaps, stale extent, empty coverage and overlap overflow',()=>{
 const v={y:5516,clientHeight:912,height:6428};
 for(const [view,end,extent] of [[{...v,y:5472},6384,6428],[v,5928,6428],[v,6384,6500],[v,6428,6428],[v,0,6428],[v,6199,6428]])assert.equal(bottomTail(view,end,extent),null);
 assert.ok(bottomTail({...v,y:5515.999},6384));
 assert.equal(bottomTail({...v,y:5514.9},6384),null);
});
test('320px hard cap and clipped nested viewport',()=>{
 assert.ok(bottomTail({height:5000,y:3000,clientHeight:2000},4680));
 assert.equal(bottomTail({height:5000,y:3000,clientHeight:2000},4679),null);
 assert.equal(bottomTail({height:6428,y:5516,clientHeight:900},6384),null);
});

// Exercise the actual offscreen commit path: failed probes never draw, and a
// renewed visual match takes precedence even when an anchor is available.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { VISUAL, overlapCSS } from '../capture/visual.js';
const offscreen = (await readFile(new URL('../offscreen.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
for(const policy of ['robust','strict'])for(const result of ['failed','ambiguous','low-information','strict-coverage-failed','matched'])test(`offscreen ${policy} visual-first terminal ${result}`,async()=>{
 const draws=[];let closed=0;
 const context={assessBottomTail,VISUAL,overlapCSS,drawGeometry,
  matchVertical:()=>({result,matchedOffset:43,correction:-1}),
  chrome:{runtime:{onMessage:{addListener(){}}}},addEventListener(){},
  fetch:async()=>({blob:async()=>({})}),createImageBitmap:async()=>({width:900,height:912,close(){closed++}}),
  OffscreenCanvas:class{constructor(w,h){this.w=w;this.h=h}getContext(){return{drawImage(){},getImageData:()=>({data:new Uint8Array(this.w*this.h*4)})}}}
 };
 vm.runInNewContext(offscreen,context);
 context.draws=draws;
 vm.runInNewContext(`session={continuityPolicy:'${policy}',id:'a',bitmapWidth:900,bitmapHeight:912,region:{x:0,y:0,width:900,height:6428},scale:{sourceX:1,sourceY:1,scaleX:1,scaleY:1},context:{drawImage(...a){draws.push(a.slice(1))}},previous:{strip:{start:428},canonicalY:5472,documentY:5472,end:6384}}`,context);
 const m={type:'FULL_FRAME',id:'a',x:0,firstColumn:true,uncertain:true,dataUrl:'fresh',view:{x:0,y:5516,height:6428,clientWidth:900,clientHeight:912,innerWidth:900,innerHeight:912}};
 if(result!=='matched'){
  const rejected=await context.handle(m);assert.equal(rejected.accepted,false);assert.equal(rejected.canonicalEnd,6384);assert.equal(draws.length,0);
 }
 const accepted=await context.handle({...m,bottomExtent:6428});
 if(policy==='strict'&&result!=='matched'){assert.equal(accepted.accepted,false);assert.equal(draws.length,0);assert.equal(closed,2);return}
 assert.equal(accepted.accepted,true);
 if(result==='matched'){assert.equal(accepted.bottomTail,undefined);assert.equal(accepted.end,6427)}
 else{assert.equal(accepted.end,6428);assert.equal(accepted.bottomTail.novelPixels,44);assert.deepEqual(Array.from(draws[0]),[0,868,900,44,0,6384,900,44])}
 assert.equal(closed,result==='matched'?1:2);
});

const background=(await readFile(new URL('../background.js',import.meta.url),'utf8'));
const quiescence=background.slice(background.indexOf('async function bottomQuiescence'),background.indexOf('function recordVisual'));
test('terminal quiescence requires four ready samples and aborts growth or movement',async()=>{
 const view={height:6428,y:5516,clientHeight:912};
 for(const kind of ['ready','loading','growth','moved','pending-reflow','jitter']){
  const s={full:{end:6428},terminalExtent:kind==='jitter'?6428:undefined};let calls=0;
  const context={delay:async()=>{},ensureVisible:async()=>{},validateView(){},terminalNear,TERMINAL_GEOMETRY_EPSILON,
   request:async()=>{calls++;if(kind==='pending-reflow')throw {translation:true};
    if(kind==='jitter')return {...view,height:calls%2?6429:6428,y:calls%2?5516.5:5516,loading:false};
    return {...view,loading:kind==='loading'&&calls<=2,...(kind==='growth'?{height:6500}:kind==='moved'?{y:5400}:{})}},
   extendEnd:async(s,v)=>{if(Number.isFinite(s.terminalExtent)&&terminalNear(v.height,s.terminalExtent))return;s.full.end=v.height}
  };
  vm.runInNewContext(quiescence,context);
  const report={};
  assert.equal(await context.bottomQuiescence(s,view,report),['ready','loading','jitter'].includes(kind));
  assert.equal(calls,kind==='ready'||kind==='jitter'?4:kind==='loading'?6:1);
  if(kind==='moved')assert.equal(report.reason,'quiescence-drift');
  if(kind==='growth')assert.equal(report.reason,'quiescence-growth');
  if(kind==='pending-reflow')assert.equal(report.reason,'quiescence-translation');
 }
});

test('terminal geometry tolerates at most 1 CSS px of extent/bottom jitter and explains rejection',()=>{
 const base={y:5516.5,clientHeight:912,height:6429,x:0,clientWidth:900,innerWidth:900,innerHeight:912};
 const accepted=assessBottomTail(base,6384,6428);
 assert.ok(accepted.anchor,JSON.stringify(accepted));
 assert.equal(accepted.anchor.remainingTail,44);
 assert.equal(accepted.anchor.extentDelta,1);
 assert.equal(accepted.anchor.bottomDelta,0.5);
 assert.equal(accepted.anchor.epsilon,TERMINAL_GEOMETRY_EPSILON);
 assert.ok(terminalNear(6428.5,6428));assert.ok(!terminalNear(6429.01,6428));
 assert.equal(assessBottomTail({...base,height:6429.01},6384,6428).reason,'extent-mismatch');
 assert.equal(assessBottomTail({...base,height:6428,y:5517.01},6384,6428).reason,'not-physical-bottom');
 assert.equal(assessBottomTail({...base,height:6428,y:5516},5928,6428).reason,'tail-too-large');
 assert.equal(assessBottomTail({...base,height:6428,y:5516},6428,6428).reason,'no-novel-tail');
});

test('offscreen terminal anchor clamps a fractional physical bottom to the authoritative final extent',async()=>{
 const draws=[];let closed=0;
 const context={assessBottomTail,VISUAL,overlapCSS,drawGeometry,
  matchVertical:()=>({result:'failed',matchedOffset:null,correction:null}),
  chrome:{runtime:{onMessage:{addListener(){}}}},addEventListener(){},
  fetch:async()=>({blob:async()=>({})}),createImageBitmap:async()=>({width:900,height:912,close(){closed++}}),
  OffscreenCanvas:class{constructor(w,h){this.w=w;this.h=h}getContext(){return{drawImage(){},getImageData:()=>({data:new Uint8Array(this.w*this.h*4)})}}}
 };
 vm.runInNewContext(offscreen,context);context.draws=draws;
 vm.runInNewContext(`session={continuityPolicy:'robust',id:'j',bitmapWidth:900,bitmapHeight:912,region:{x:0,y:0,width:900,height:6428},scale:{sourceX:1,sourceY:1,scaleX:1,scaleY:1},context:{drawImage(...a){draws.push(a.slice(1))}},previous:{strip:{start:428},canonicalY:5472,documentY:5472,end:6384}}`,context);
 const result=await context.handle({type:'FULL_FRAME',id:'j',x:0,firstColumn:true,uncertain:true,dataUrl:'fresh',bottomExtent:6428,
  view:{x:0,y:5516.5,height:6429,clientWidth:900,clientHeight:912,innerWidth:900,innerHeight:912}});
 assert.equal(result.accepted,true);assert.equal(result.end,6428);assert.equal(result.bottomTail.remainingTail,44);
 assert.equal(result.bottomTail.extentDelta,1);assert.equal(result.bottomTail.bottomDelta,0.5);
 assert.deepEqual(Array.from(draws[0]),[0,868,900,44,0,6384,900,44]);assert.equal(closed,1);
});
