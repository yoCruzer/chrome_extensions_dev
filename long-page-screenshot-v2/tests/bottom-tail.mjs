import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  await capture('full','css');
  const result=await waitFor(s=>!s.busy),v=result.diagnostics.visual;
  if(['not-bottom','large','middle'].includes(kind)) {
   assert.equal(result.state,'failed',JSON.stringify(result));
   assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');assert.equal(result.parts,0);
   assert.equal(v.bottomTailAccepted,0);assert.ok(v.bottomTailRejected>0);
   assert.equal(v.visualRecoveryRetries,2);
   if(kind==='middle')assert.ok(v.ambiguousMatches>0);
   if(kind!=='middle')assert.equal(result.diagnostics.fullProof.trace.at(-1).committedEnd,6384);
  } else {
   assert.equal(result.state,'complete',JSON.stringify(result));
   const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference),'base64'));
   const png=PNG.sync.read(await readFile(result.result.filename));
   assert.equal(png.width,ref.width);assert.equal(png.height,ref.height);
   for(let y=0;y<ref.height;y++)assert.deepEqual(png.data.subarray(y*ref.width*4,(y+1)*ref.width*4),ref.data.subarray(y*ref.width*4,(y+1)*ref.width*4),`${kind} row ${y}`);
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
}
