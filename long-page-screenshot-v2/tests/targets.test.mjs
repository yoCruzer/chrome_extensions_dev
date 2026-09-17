import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../content.js',import.meta.url),'utf8');
function setup(){
 const body={style:{}},root={style:{}};
 const element=(parent,scrollable=false)=>({parentElement:parent,isConnected:true,
  clientLeft:2,clientTop:2,clientWidth:500,clientHeight:620,scrollWidth:500,scrollHeight:scrollable?4800:620,
  scrollLeft:0,scrollTop:2100,style:{visibility:'visible',overflowY:scrollable?'auto':'visible',overflowX:'visible'},
  closest(){return null},
  contains(other){for(let e=other;e;e=e.parentElement)if(e===this)return true;return false},
  getBoundingClientRect:()=>({left:78,top:38,width:504,height:624,right:582,bottom:662})});
 const outer=element(body,true),inner=element(outer,true),first=element(inner),second=element(inner);
 const context={document:{body,documentElement:root,querySelectorAll:()=>[outer,inner,first,second]},innerWidth:900,innerHeight:700,
  measure:()=>({x:0,y:0,width:900,height:700,clientHeight:700}),getComputedStyle:e=>e.style};
 vm.runInNewContext(source.slice(source.indexOf('  function targetView'),source.indexOf('  // Element references')),context);
 const s={anchors:{first:{element:first},second:{element:second}},targetScrolls:new Map()};
 return {context,s,outer,inner,second};
}
test('target selection chooses innermost common scrollable ancestor and preserves original scroll',()=>{
 const {context:c,s,inner,outer,second}=setup();c.detectTarget(s);assert.equal(s.target.element,inner);
 assert.equal(s.targetScrolls.get(inner).y,2100);inner.scrollTop=4000;c.detectTarget(s);assert.equal(s.targetScrolls.get(inner).y,2100);
 second.parentElement=outer;c.detectTarget(s);assert.equal(s.target.element,outer);
 outer.style.overflowY='visible';c.detectTarget(s);assert.equal(s.target,null);
});
test('target mapping includes client border, local scroll, and fails closed on detached target',()=>{
 const {context:c,s,inner}=setup();c.detectTarget(s);
 const view=c.targetView(s);assert.equal(view.viewportRect.left,80);assert.equal(view.viewportRect.top,40);
 const point=c.targetPoint(s,100,200);assert.equal(point.x,20);assert.equal(point.y,2260);
 inner.isConnected=false;assert.throws(()=>c.targetView(s),e=>e.reasonCode==='TARGET_UNRESOLVABLE');
});


test('Full Page prefers scrollable document, otherwise dominant visible vertical target',()=>{
 const {context:c,s,inner,outer}=setup();
 c.measure=()=>({height:4000,clientHeight:700});c.detectFullTarget(s);assert.equal(s.target,null);
 c.measure=()=>({height:700,clientHeight:700});c.detectFullTarget(s);assert.equal(s.target.element,outer);
 outer.style.overflowY='visible';c.detectFullTarget(s);assert.equal(s.target.element,inner);
 assert.equal(s.targetScrolls.get(inner).y,2100);
 inner.getBoundingClientRect=()=>({left:0,top:0,right:200,bottom:700,width:200,height:700});
 c.detectFullTarget(s);assert.equal(s.target,null,'small sidebar is ineligible');
});

test('Full Page rejects horizontal-only, clipped, and editor/menu targets',()=>{
 const {context:c,s,inner,outer}=setup();outer.style.overflowY='visible';
 inner.closest=()=>({});c.detectFullTarget(s);assert.equal(s.target,null);
 inner.closest=()=>null;inner.style.overflowY='visible';inner.style.overflowX='auto';inner.scrollWidth=900;
 c.detectFullTarget(s);assert.equal(s.target,null);
 inner.style.overflowY='auto';inner.getBoundingClientRect=()=>({left:1000,top:0,right:1500,bottom:620,width:500,height:620});
 c.detectFullTarget(s);assert.equal(s.target,null);
});
