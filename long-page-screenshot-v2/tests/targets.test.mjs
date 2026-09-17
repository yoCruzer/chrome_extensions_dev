import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../content.js',import.meta.url),'utf8');
function setup(){
 const body={},root={};
 const element=(parent,scrollable=false)=>({parentElement:parent,isConnected:true,
  clientLeft:2,clientTop:2,clientWidth:500,clientHeight:620,scrollWidth:500,scrollHeight:scrollable?4800:620,
  scrollLeft:0,scrollTop:2100,style:{visibility:'visible',overflowY:scrollable?'auto':'visible',overflowX:'visible'},
  contains(other){for(let e=other;e;e=e.parentElement)if(e===this)return true;return false},
  getBoundingClientRect:()=>({left:78,top:38,width:504,height:624})});
 const outer=element(body,true),inner=element(outer,true),first=element(inner),second=element(inner);
 const context={document:{body,documentElement:root},innerWidth:900,innerHeight:700,
  measure:()=>({x:0,y:0,width:900,height:700}),getComputedStyle:e=>e.style};
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
