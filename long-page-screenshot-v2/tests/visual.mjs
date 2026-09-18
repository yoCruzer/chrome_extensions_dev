import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export async function testVisual({page,worker,capture,waitFor,PNG}) {
 for(const kind of ['static','github','github-recovery','sidebar','ad','islands','global','transient','unrelated','ambiguous','low']) {
  await page.setViewportSize({width:900,height:kind==='github-recovery'?912:700});
  await page.goto(new URL('?kind='+(kind==='github-recovery'?'github':kind),page.url()).href);
  const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference),'base64'));
  if(['transient','github-recovery'].includes(kind))await worker.evaluate(last=>{
   const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);let calls=0;
   chrome.tabs.captureVisibleTab=async(...args)=>{
    calls++;
    if(calls===2||calls===last){
     const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
     await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async seed=>{paint(seed);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))},args:[calls===2?987654:0]});
    }
    if(calls===last)chrome.tabs.captureVisibleTab=original;
    return original(...args);
   };
  },kind==='github-recovery'?4:3);
  await capture('full','css');
  const result=await waitFor(s=>!s.busy),v=result.diagnostics.visual;
  assert.equal(v.bottomTailAccepted,0,`${kind} must remain visual-only`);
  if(['unrelated','ambiguous','low'].includes(kind)) {
   assert.equal(result.state,'failed',JSON.stringify(result));assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');
   assert.equal(result.parts,0);assert.equal(result.result,undefined);assert.equal(v.visualRecoveryRetries,2);assert.equal(v.visualFailures,1);
   if(kind==='low')assert.ok(v.lowInformationRejects>0);
   if(kind==='ambiguous')assert.ok(v.ambiguousMatches>0);
  } else {
   assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.attempt,1);assert.equal(result.parts,1);
   const png=PNG.sync.read(await readFile(result.result.filename));assert.equal(png.width,900);assert.equal(png.height,3200);
   const left=['github','github-recovery','sidebar','ad','islands'].includes(kind)?270:0,right=kind==='islands'?790:900;
   for(let y=0;y<3200;y++)assert.deepEqual(png.data.subarray((y*900+left)*4,(y*900+right)*4),ref.data.subarray((y*900+left)*4,(y*900+right)*4),`${kind} row ${y}`);
   if(kind==='github-recovery')assert.ok(v.trace.some(t=>t.expectedOffset===456&&t.matchedOffset===411&&t.correction===-45),JSON.stringify(v));
   if(['github','github-recovery','global'].includes(kind))assert.ok(v.trace.some(t=>t.correction===-(kind.startsWith('github')?45:80)),JSON.stringify(v));
   else assert.ok(v.trace.filter(t=>t.result==='matched').every(t=>t.correction===0));
   if(kind==='transient'){assert.equal(v.visualRecoveryRetries,1);assert.equal(v.visualFailures,0)}
   if(['github','github-recovery','sidebar'].includes(kind))assert.ok(result.diagnostics.fullProof.trace.some(t=>t.trigger==='WITNESS_MOVED'&&Math.abs(t.delta.dy-(kind.startsWith('github')?45:20.617))<0.1));
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  assert.equal(await page.evaluate(()=>scrollY),0);
  console.log('PASS visual',kind,JSON.stringify(v));
 }
}
