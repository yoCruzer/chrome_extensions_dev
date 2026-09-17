import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveEnd, MAX_END_EXTENSIONS} from '../capture/planner.js';
const state=()=>({initialHeight:2400,maxObservedHeight:2400,end:2400,endExtensions:0,bottomStableSamples:4});
test('adaptive end retains stable end and admits multiple bounded extensions',()=>{
 const s=state();assert.equal(adaptiveEnd(s,2400,700),false);
 for(const height of [2800,3200,3600])assert.equal(adaptiveEnd(s,height,700),true);
 assert.equal(s.end,3600);assert.equal(s.maxObservedHeight,3600);assert.equal(s.endExtensions,3);assert.equal(s.bottomStableSamples,0);
});
test('adaptive end bounds growth and permits shrink for visual verification',()=>{
 assert.throws(()=>adaptiveEnd(state(),5300,700),e=>e.reasonCode==='FULL_GROWTH_LIMIT');
 const s=state();for(let i=1;i<=MAX_END_EXTENSIONS;i++)adaptiveEnd(s,2400+i,700);
 assert.throws(()=>adaptiveEnd(s,2500,700),e=>e.reasonCode==='FULL_GROWTH_LIMIT');
 const shrinking=state();assert.equal(adaptiveEnd(shrinking,2399,700),true);assert.equal(shrinking.end,2399);assert.equal(shrinking.endExtensions,0);
});
