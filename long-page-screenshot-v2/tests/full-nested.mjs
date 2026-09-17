import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function testFullNested({page,worker,message,capture,waitFor,PNG,browserCDP}) {
 const setup=async()=>{
  await page.reload();
  await page.evaluate(()=>{
   const target=document.getElementById('conversation');target.scrollTop=317;
   window.fullScrolls=[];
   target.addEventListener('scroll',()=>fullScrolls.push({windowY:scrollY,targetY:target.scrollTop}));
  });
 };
 const position=()=>page.evaluate(()=>[scrollY,document.getElementById('conversation').scrollTop]);
 const insert=async(prepend=false)=>page.evaluate(prepend=>{
  const target=document.getElementById('conversation'),canvas=document.createElement('canvas');
  canvas.width=500;canvas.height=480;
  const ctx=canvas.getContext('2d');ctx.drawImage(target.querySelector('canvas'),0,0);
  ctx.fillStyle='white';ctx.font='20px monospace';ctx.fillText(prepend?'INSERTED ABOVE':'TAIL GROWTH',100,180);
  if(prepend)target.prepend(canvas);else target.append(canvas);
 },prepend);
 const verify=async result=>{
  assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.parts,1);
  const png=PNG.sync.read(await readFile(result.result.filename));
  const refs=(await page.evaluate(()=>[...document.querySelectorAll('#conversation canvas')].map(c=>c.toDataURL().split(',')[1])))
   .map(v=>PNG.sync.read(Buffer.from(v,'base64')));
  assert.equal(png.width,500);assert.equal(png.height,refs.length*480);
  for(let y=0;y<png.height;y++)assert.deepEqual(png.data.subarray(y*500*4,(y+1)*500*4),refs[Math.floor(y/480)].data.subarray(y%480*500*4,(y%480+1)*500*4),`full nested row ${y}`);
  assert.deepEqual(await position(),[0,317]);
  const moves=await page.evaluate(()=>fullScrolls);
  assert.ok(moves.length>3);assert.ok(moves.every(m=>m.windowY===0));
  assert.ok(moves.some(m=>m.targetY>=png.height-620));
  assert.equal(result.diagnostics.targetKind,'element');
  assert.equal(result.diagnostics.bottomStableSamples,4);
 };
 for(const mode of ['static','first-resize','growth','resize','reflow','repeated']){
  await setup();
  if(mode==='first-resize')await worker.evaluate(()=>{
   const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
   chrome.tabs.captureVisibleTab=async(...args)=>{
    chrome.tabs.captureVisibleTab=original;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>document.getElementById('conversation').style.height='500px'});
    return original(...args);
   };
  });
  await capture('full','css');
  await waitFor(s=>s.state==='capturing'&&s.frames>=2);
  if(mode==='growth')await insert();
  if(mode==='resize')await page.evaluate(()=>document.getElementById('conversation').style.height='500px');
  if(['reflow','repeated'].includes(mode))await insert(true);
  if(mode==='repeated'){
   await waitFor(s=>s.state==='capturing'&&s.attempt===2&&s.frames>=2);await insert(true);
  }
  const result=await waitFor(s=>!s.busy);
  if(mode==='repeated'){
   assert.equal(result.state,'failed');assert.equal(result.reasonCode,'FULL_REFLOW');assert.equal(result.result,undefined);
   assert.equal(result.diagnostics.fullProof.trigger,'WITNESS_MOVED');assert.deepEqual(await position(),[0,317]);
  }else{
   await verify(result);
   assert.equal(result.metrics.retries,['resize','reflow'].includes(mode)?1:0);
   if(mode==='first-resize')assert.equal(result.diagnostics.fullProof.counters.baselineRebasesBeforeFirstFrame,1);
   if(mode==='growth'){assert.equal(result.diagnostics.maxObservedHeight,5280);assert.equal(result.diagnostics.endExtensions,1)}
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS Full Page nested',mode,'target scroll/window fixed, every pixel, shell exclusion, restoration');
 }
 for(const action of ['cancel','remove','replace']){
  await setup();const job=await capture('full','css');await waitFor(s=>s.state==='capturing'&&s.frames>=2);
  if(action==='cancel')await message({type:'CANCEL',id:job.id});
  else await page.evaluate(action=>{
   const target=document.getElementById('conversation');
   if(action==='remove')target.remove();else target.replaceWith(target.cloneNode(true));
  },action);
  const result=await waitFor(s=>!s.busy);
  assert.equal(result.state,action==='cancel'?'cancelled':'failed');assert.equal(result.parts,0);assert.equal(result.result,undefined);
  if(action==='cancel')assert.deepEqual(await position(),[0,317]);else assert.equal(result.reasonCode,'TARGET_UNRESOLVABLE');
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS Full Page nested',action,'no PNG, restored/cleaned');
 }
 await setup();await capture('full','css');await waitFor(s=>s.state==='capturing'&&s.frames>=2);
 const {targetInfos}=await browserCDP.send('Target.getTargets');
 const target=targetInfos.find(t=>t.type==='service_worker'&&t.url===worker.url());
 await browserCDP.send('Target.closeTarget',{targetId:target.targetId});
 const interrupted=await waitFor(s=>!s.busy);
 assert.equal(interrupted.state,'failed');assert.match(interrupted.message,/中断/);assert.deepEqual(await position(),[0,317]);
 worker=page.context().serviceWorkers()[0]||await page.context().waitForEvent('serviceworker');
 assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
 console.log('PASS Full Page nested actual worker interruption restores original target scroll');
}
