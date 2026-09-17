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
    measure: () => ({height: 2400}), progress: null, HTMLElement: Element,
    getComputedStyle: () => ({visibility:'visible',position:'static'}),
    document: { createElement: () => ({}), documentElement: {append() {}}, querySelectorAll: () => [] },
    adjustElement() {}, MutationObserver: class { constructor(fn) { callback = fn; } observe() {} } };
  vm.runInNewContext(source.slice(source.indexOf('  function serializeDiagnostics'), source.indexOf('  function regionView')), c);
  vm.runInNewContext(source.slice(source.indexOf('  function establishLayout'), source.indexOf('  async function settle')), c);
  const element = new Element();
  const s = { mode:'full', fullProof:{nodes:new Map([[element,[10,20,100,50]]]),end:700,invalid:false}, diagnosticAttempt:1, diagnosticFrames:2 };
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

test('mutation counters count records once, preserving invalidation predicates and safe reasons', () => {
  const {c,s,element,mutate} = fixture();
  const record=(type,target=element,addedNodes=[])=>({type,target,addedNodes,attributeName:type==='attributes'?'src':null});
  const outside=new element.constructor();outside.rect={...element.rect,top:800};
  mutate([record('attributes',outside)]);
  assert.equal(s.fullProof.invalid,false);
  mutate([record('attributes'),record('characterData',{nodeType:3,parentElement:element}),record('childList',element,[element])]);
  const d=s.proofDiagnostics;
  assert.equal(d.counters.mutations,4);assert.equal(d.counters.ignoredMutations,1);assert.equal(d.counters.capturedPrefixMutations,3);
  assert.deepEqual(Array.from(d.trace,t=>t.reason),['attribute-change-inside-captured-prefix','character-data-inside-captured-prefix','existing-witness-mutated','added-node-inside-captured-prefix']);
  assert.equal(d.trace[0].attributeName,'src');assert.equal(d.trace[0].current.y,20);
  assert.throws(()=>c.fullProof(s),e=>e.layout && e.reasonCode==='FULL_REFLOW');
  assert.equal(d.trigger,'MUTATION_INVALIDATION');
});

for (const kind of ['moved','removed','unchanged','at-threshold']) {
  test(`witness ${kind}: original threshold and FULL_REFLOW semantics, detailed geometry`, () => {
    const {c,s,element}=fixture();
    if(kind==='moved')element.rect.top+=0.51;
    if(kind==='at-threshold')element.rect.top+=0.5;
    if(kind==='removed')element.isConnected=false;
    if(kind==='unchanged'||kind==='at-threshold') {
      assert.doesNotThrow(()=>c.fullProof(s));assert.equal(s.proofDiagnostics.trigger,null);
    } else {
      assert.throws(()=>c.fullProof(s),e=>e.layout && e.reasonCode==='FULL_REFLOW');
      const entry=s.proofDiagnostics.trace.at(-1);
      assert.equal(entry.trigger,kind==='moved'?'WITNESS_MOVED':'WITNESS_REMOVED');
      assert.equal(entry.connected,kind!=='removed');assert.equal(entry.before.y,20);
      assert.equal(entry.delta.dy,entry.current.y-entry.before.y);
      assert.equal(entry.proofEnd,700);assert.equal(entry.frameCount,2);
    }
    assert.equal(s.proofDiagnostics.counters.witnessVerifications,1);
  });
}
