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
  else if(kind==='removed')await page.evaluate(()=>document.querySelector('#article > canvas').replaceWith(document.querySelector('#article > canvas').cloneNode(true)));
  else if(!['first-frame','first-shrink'].includes(kind))await page.evaluate(kind=>mutate(kind),kind);
  if(['repeated','removed'].includes(kind)){
   await waitFor(s=>s.attempt===2&&s.state==='capturing'&&s.frames>=3);
   await page.evaluate(kind=>kind==='repeated'?insert():document.querySelector('#article > canvas').remove(),kind);
  }
  const result=await waitFor(s=>!s.busy),d=result.diagnostics.fullProof;
  assert.ok(d.trace.filter(t=>t.frameCount===0).every(t=>t.committedEnd===0),'planned view never commits pixels');
  if(['repeated','removed'].includes(kind)){
   assert.equal(result.state,'failed');assert.equal(result.reasonCode,'FULL_REFLOW');assert.equal(result.result,undefined);
   assert.equal(d.trigger,kind==='removed'?'WITNESS_REMOVED':'WITNESS_MOVED');
   assert.equal(result.attempt,2);
  }else{
   await verify(result);assert.equal(result.metrics.retries,kind==='insert'?1:0);
   if(kind==='first-frame'){assert.equal(d.counters.baselineRebasesBeforeFirstFrame,1);assert.equal(result.attempt,1)}
   else if(kind==='first-shrink'){assert.equal(result.attempt,1);assert.equal(result.result.height,3900)}
   else if(kind==='insert'){
    assert.ok(d.trace.some(t=>t.trigger==='WITNESS_MOVED'&&t.delta.dy===200));
   }else{assert.ok(d.counters.dirtyMutations>0);assert.ok(d.counters.harmlessAfterGeometryCheck>0)}
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS proof',kind,'PNG rows/markers/seams or fail-closed verified',JSON.stringify(d.counters));
 }
}
