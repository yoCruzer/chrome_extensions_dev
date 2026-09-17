import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
function fixture() {
  let callback;
  class Element {
    tagName = 'DIV'; id = 'private-token'; isConnected = true; children = [];
    rect = { left: 10, top: 20, width: 100, height: 50, right: 110, bottom: 70 };
    getBoundingClientRect() { return this.rect; }
    getAttribute() { return 'https://private.test/?token=secret'; }
    get textContent() { throw new Error('must not read text'); }
    get innerHTML() { throw new Error('must not read HTML'); }
  }
  const c = { scrollX: 0, scrollY: 0, innerHeight: 700, innerWidth: 900,
    measure: () => ({height: 2400}), targetView: () => ({clientWidth:900,clientHeight:700,viewportRect:{left:0,top:0}}),
    targetPoint: (s,x,y) => ({x,y}), progress: null, HTMLElement: Element,
    getComputedStyle: () => ({visibility:'visible',position:'static'}),
    document: { createElement: () => ({}), documentElement: {append() {}}, querySelectorAll: () => [] },
    adjustElement() {}, MutationObserver: class { constructor(fn) { callback = fn; } observe() {} } };
  vm.runInNewContext(source.slice(source.indexOf('  function serializeDiagnostics'), source.indexOf('  function regionView')), c);
  vm.runInNewContext(source.slice(source.indexOf('  function establishLayout'), source.indexOf('  async function settle')), c);
  const element = new Element();
  const s = { mode:'full', fullProof:{nodes:new Map([[element,[10,20,100,50]]]),committedEnd:700,pending:new Map(),dirty:0}, diagnosticAttempt:1, diagnosticFrames:2 };
  c.establishLayout(s);
  return {c,s,element,mutate: records => callback(records)};
}

test('trace keeps latest 150 entries across attempts; serialization excludes private payloads', () => {
  const {c,s,element} = fixture();
  for (let i=0;i<220;i++) c.proofTrace(s,'sample',{index:i,descriptor:c.descriptor(element)});
  s.diagnosticAttempt=2;c.proofTrace(s,'attempt-start');
  assert.equal(s.proofDiagnostics.trace.length,150);
  assert.equal(s.proofDiagnostics.trace[0].index,71);
  for (const state of ['complete','failed']) {
    const json=c.serializeDiagnostics({state,reasonCode:state==='failed'?'FULL_REFLOW':undefined,attempt:2,
      message:'private-token',url:'https://private.test/?token=secret',result:{filename:'private-token'},
      metrics:{captures:3,secret:'private-token'}, diagnostics:{initialHeight:2400,fullProof:s.proofDiagnostics,html:'private-token'}});
    assert.doesNotMatch(json,/private|secret|https|filename|html/);
    const report=JSON.parse(json);
    assert.equal(report.state,state);assert.equal(report.attempt,2);
    assert.equal(report.metrics.captures,3);assert.equal(report.diagnostics.fullProof.trace.length,150);
    assert.equal(report.diagnostics.fullProof.trace.at(-1).attempt,2);
    assert.ok(json.includes('\n  "state"'));
  }
});

test('mutations are bounded dirty evidence; unchanged committed geometry continues', () => {
  const {c,s,element,mutate} = fixture();
  const record=(type,target=element)=>({type,target,addedNodes:[],attributeName:type==='attributes'?'src':null});
  for(let i=0;i<250;i++) mutate([record('attributes'),record('characterData',{nodeType:3,parentElement:element}),record('childList')]);
  const d=s.proofDiagnostics;
  assert.equal(d.counters.mutations,750);assert.equal(d.counters.dirtyMutations,750);
  assert.equal(s.fullProof.dirty,750);assert.equal(d.trace.length,150);
  assert.doesNotThrow(()=>c.fullProof(s));
  assert.equal(s.fullProof.dirty,0);assert.equal(d.trigger,null);
  assert.equal(d.counters.harmlessAfterGeometryCheck,750);
  assert.equal(d.trace.at(-1).event,'dirty-verified-harmless');
});

test('planned witnesses do not advance coverage; first-frame reflow rebases without FULL_REFLOW',()=>{
  const {c,s,element}=fixture();
  s.fullProof={nodes:new Map(),pending:new Map([[element,[10,20,100,50]]]),committedEnd:0,dirty:1};
  element.rect.top+=200;
  assert.throws(()=>c.fullProof(s),e=>e.translation && !e.layout && e.reasonCode==='FRAME_MOVED');
  assert.equal(s.fullProof.committedEnd,0);assert.equal(s.fullProof.pending.size,0);
  assert.equal(s.proofDiagnostics.counters.baselineRebasesBeforeFirstFrame,1);
  assert.equal(s.proofDiagnostics.trigger,null);
  assert.doesNotThrow(()=>c.fullProof(s));
});

test('commit promotes only intersecting pre-bitmap witnesses and detects drawing-time shift',()=>{
  const {c,s,element}=fixture();
  s.fullProof={nodes:new Map(),pending:new Map([[element,[10,20,100,50]]]),committedEnd:0,dirty:0};
  element.rect.top+=200;
  assert.doesNotThrow(()=>c.commitFullProof(s,{x:0,y:0,right:900,bottom:700}));
  assert.equal(s.fullProof.committedEnd,700);
  assert.equal(s.proofDiagnostics.trigger,'WITNESS_MOVED');
});

for (const kind of ['moved','resized','removed','unchanged','at-threshold']) {
  test(`witness ${kind}: original threshold and visual warning semantics, detailed geometry`, () => {
    const {c,s,element}=fixture();
    if(kind==='moved')element.rect.top+=0.51;
    if(kind==='resized')element.rect.height+=1;
    if(kind==='at-threshold')element.rect.top+=0.5;
    if(kind==='removed')element.isConnected=false;
    if(kind==='unchanged'||kind==='at-threshold') {
      assert.doesNotThrow(()=>c.fullProof(s));assert.equal(s.proofDiagnostics.trigger,null);
    } else {
      assert.doesNotThrow(()=>c.fullProof(s));
      const entry=s.proofDiagnostics.trace.at(-1);
      assert.equal(entry.trigger,kind==='moved'?'WITNESS_MOVED':kind==='resized'?'WITNESS_RESIZED':'WITNESS_REMOVED');
      assert.equal(entry.connected,kind!=='removed');assert.equal(entry.before.y,20);
      assert.equal(entry.delta.dy,entry.current.y-entry.before.y);
      assert.equal(entry.proofEnd,700);assert.equal(entry.frameCount,2);
    }
    assert.equal(s.proofDiagnostics.counters.witnessVerifications,1);
  });
}
