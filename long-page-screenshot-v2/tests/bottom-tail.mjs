import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { armAfterFirstBitmap } from './visual-hooks.mjs';
export async function testBottomTail({page,worker,capture,waitFor,PNG}) {
 for(const kind of ['44','1','upper','not-bottom','growing','late-growing','large','middle','nested']) {
  await page.setViewportSize({width:900,height:kind==='nested'?1000:912});
  await page.goto(new URL('?kind='+kind,page.url()).href);
  if(kind==='growing')await worker.evaluate(()=>{
   const original=chrome.tabs.sendMessage.bind(chrome.tabs);
   chrome.tabs.sendMessage=async(id,m,...args)=>{
    if(m.type==='BOTTOM'){
     chrome.tabs.sendMessage=original;
     await chrome.scripting.executeScript({target:{tabId:id},world:'MAIN',func:()=>paint(6500)});
    }
    return original(id,m,...args);
   };
  });
  if(kind==='late-growing')await worker.evaluate(()=>{
   const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);let calls=0;
   chrome.tabs.captureVisibleTab=async(...args)=>{
    if(++calls===11){
     chrome.tabs.captureVisibleTab=original;
     const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
     await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async()=>{
      paint(6500);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
     }});
    }
    return original(...args);
   };
  });
  await armAfterFirstBitmap(worker,'armTailMutation');
  await capture('full','css');
  const result=await waitFor(s=>!s.busy),v=result.diagnostics.visual;
  console.log('TAIL_RESULT',JSON.stringify({kind,state:result.state,diagnostics:result.diagnostics}));
  if(kind==='not-bottom') {
   assert.equal(result.state,'failed',JSON.stringify(result));
   assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');assert.equal(result.parts,0);
   assert.equal(v.bottomTailAccepted,0);assert.ok(v.bottomTailRejected>0);
   assert.equal(v.visualRecoveryRetries,2);
   assert.equal(result.diagnostics.fullProof.trace.at(-1).committedEnd,6384);
  } else {
   assert.equal(result.state,'complete',JSON.stringify(result));
   const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference),'base64'));
   const png=PNG.sync.read(await readFile(result.result.filename));
   assert.equal(png.width,ref.width);assert.equal(png.height,ref.height);
   for(let y=0;y<ref.height;y++)assert.deepEqual(png.data.subarray(y*ref.width*4,(y+1)*ref.width*4),ref.data.subarray(y*ref.width*4,(y+1)*ref.width*4),`${kind} row ${y}`);
   if(['large','middle'].includes(kind)){
    // Robust explicitly supports uncertain geometry placement on coherent
    // low-information/repetitive content. This is not a terminal-tail bypass.
    assert.ok(v.probablePlacements>0,JSON.stringify(v));
    assert.ok(v.geometryFallbacks>0,JSON.stringify(v));
    assert.equal(v.visualFailures,0);
    if(kind==='middle')assert.ok(v.ambiguousMatches>0);
   }else{
   assert.equal(v.bottomTailAccepted,1);
   const tail=v.trace.find(t=>t.event==='bottom-tail-anchored');
   assert.equal(tail.result,'BOTTOM_ANCHORED_TAIL');assert.ok(['failed','ambiguous','low-information'].includes(tail.visualResult));
   assert.equal(tail.finalExtent,ref.height);assert.equal(tail.canonicalEndBefore,6384);
   assert.equal(tail.novelPixels,ref.height-6384);
   assert.equal(tail.actualTargetScrollY+tail.viewportHeight,ref.height);
   assert.ok(v.trace.filter(t=>t.result==='matched').every(t=>t.correction===0));
   if(kind==='44'){assert.equal(result.diagnostics.initialHeight,6364);assert.equal(result.diagnostics.endExtensions,1);assert.equal(tail.novelPixels,44);assert.ok(v.trace.some(t=>t.expectedOffset===44&&t.result==='low-information'));assert.equal(v.trace.filter(t=>t.result==='matched').length,8)}
   if(['growing','late-growing'].includes(kind)){assert.equal(ref.height,6500);assert.equal(result.diagnostics.endExtensions,1)}
   }
  }
  if(kind==='44'){
   await page.locator('#long-screenshot-v2-progress').getByRole('button',{name:'复制诊断信息'}).click();
   await page.waitForFunction(()=>document.querySelector('#long-screenshot-v2-progress').shadowRoot.querySelector('#diagnostics').textContent==='已复制诊断信息');
   await page.context().grantPermissions(['clipboard-read'],{origin:new URL(page.url()).origin});
   const report=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
   assert.deepEqual(report.diagnostics.visual,v);assert.equal(report.reasonCode,null);
   await page.context().clearPermissions();
  }
  assert.equal(await page.evaluate(()=>scrollY),0);
  if(kind==='nested'){
   assert.equal(await page.evaluate(()=>target.scrollTop),317);
   assert.ok(await page.evaluate(()=>positions.every(p=>p.windowY===0)));
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS terminal-tail',kind,JSON.stringify(v));
 }
 // Strict must not take Robust's geometry fallback on the same ambiguous or
 // low-information fixtures. Keep explicit no-output fail-closed coverage.
 for(const kind of ['large','middle']){
  await page.setViewportSize({width:900,height:912});
  await page.goto(new URL('?kind='+kind,page.url()).href);
  await armAfterFirstBitmap(worker,'armTailMutation');
  await capture('full','css','strict');
  const result=await waitFor(s=>!s.busy),v=result.diagnostics.visual;
  assert.equal(result.state,'failed',JSON.stringify(result));
  assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');
  assert.equal(result.parts,0);assert.equal(result.result,undefined);
  assert.equal(v.bottomTailAccepted,0);assert.equal(v.probablePlacements,0);
  assert.equal(v.geometryFallbacks,0);assert.equal(v.visualRecoveryRetries,2);
  assert.equal(await page.evaluate(()=>scrollY),0);
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS terminal-tail strict fail-closed',kind);
 }
}
