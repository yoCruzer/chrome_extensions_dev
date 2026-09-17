import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function testProof({page,worker,capture,waitFor,PNG}) {
 const verify=async result=>{
  assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.parts,1);
  const png=PNG.sync.read(await readFile(result.result.filename));
  const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference()),'base64'));
  assert.equal(png.width,ref.width);assert.equal(png.height,ref.height);
  for(let y=0;y<png.height;y++)assert.deepEqual(png.data.subarray(y*900*4,(y+1)*900*4),ref.data.subarray(y*900*4,(y+1)*900*4),`proof row ${y}`);
 };
 for(const kind of ['class','style','src','text','overlay','carousel','sidebar','first-frame','first-shrink','insert','repeated','removed']) {
  await page.reload();
  if(['first-frame','first-shrink'].includes(kind))await worker.evaluate(kind=>{
   const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
   chrome.tabs.captureVisibleTab=async(...args)=>{
    chrome.tabs.captureVisibleTab=original;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:kind=>kind==='first-frame'?insert():document.querySelector('#article > canvas:last-child').remove(),args:[kind]});
    return original(...args);
   };
  },kind);
  await capture('full','css');
  await waitFor(s=>s.state==='capturing'&&s.frames>=3);
  if(['insert','repeated'].includes(kind))await page.evaluate(()=>insert());
  else if(kind==='removed')await page.evaluate(()=>{const old=document.querySelector('#article > canvas'),copy=old.cloneNode(true);copy.getContext('2d').drawImage(old,0,0);old.replaceWith(copy)});
  else if(!['first-frame','first-shrink'].includes(kind))await page.evaluate(kind=>mutate(kind),kind);
  if(kind==='repeated')await page.evaluate(()=>insert());
  const result=await waitFor(s=>!s.busy),d=result.diagnostics.fullProof;
  assert.ok(d.trace.filter(t=>t.frameCount===0).every(t=>t.committedEnd===0),'planned view never commits pixels');
  if(['insert','repeated'].includes(kind)){
   assert.equal(result.state,'failed');assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');assert.equal(result.result,undefined);
   assert.equal(d.trigger,'WITNESS_MOVED');
   assert.equal(result.attempt,1);
  }else{
   await verify(result);assert.equal(result.metrics.retries,0);
   if(kind==='first-frame'){assert.equal(d.counters.baselineRebasesBeforeFirstFrame,1);assert.equal(result.attempt,1)}
   else if(kind==='first-shrink'){assert.equal(result.attempt,1);assert.equal(result.result.height,3900)}
   else if(kind==='removed'){assert.ok(d.counters.witnessRemoved>0);assert.equal(result.attempt,1)}
   else{assert.ok(d.counters.dirtyMutations>0);assert.ok(d.counters.harmlessAfterGeometryCheck>0)}
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS proof',kind,'PNG rows/markers/seams or fail-closed verified',JSON.stringify(d.counters));
 }
}
