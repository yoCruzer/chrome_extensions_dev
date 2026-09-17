import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function testAdaptive({page,capture,waitFor,worker,PNG}) {
 const verify=async result=>{
  assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.parts,1);
  const png=PNG.sync.read(await readFile(result.result.filename));
  const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=900;c.height=document.getElementById('article').offsetHeight;
   const ctx=c.getContext('2d');let y=0;
   for(const element of document.getElementById('article').children){ctx.drawImage(element,0,y);y+=element.height}
   return c.toDataURL().split(',')[1];
  }),'base64'));
  assert.equal(png.width,ref.width);assert.equal(png.height,ref.height);
  for(let y=0;y<png.height;y++)assert.deepEqual(png.data.subarray(y*900*4,(y+1)*900*4),ref.data.subarray(y*900*4,(y+1)*900*4),`adaptive row ${y}`);
  assert.deepEqual(await page.evaluate(()=>[scrollX,scrollY]),[0,0]);
  assert.equal(result.diagnostics.bottomStableSamples,4);
  assert.equal(result.diagnostics.terminationReason,'BOTTOM_QUIESCENT');
 };
 for(const mode of ['static','once','multiple','reflow','repeated','infinite']){
  await page.reload();await capture('full','css');await waitFor(s=>s.state==='capturing'&&s.frames>=1);
  if(mode==='once')await page.evaluate(()=>setTimeout(grow,150));
  if(mode==='multiple')await page.evaluate(()=>{setTimeout(grow,150);armBottomGrowth(2)});
  if(mode==='infinite')await page.evaluate(()=>armBottomGrowth(100));
  if(mode==='reflow'||mode==='repeated')await page.evaluate(()=>appendBlock('INSERTED ABOVE',true));
  if(mode==='repeated')await page.evaluate(()=>appendBlock('SECOND REFLOW',true));
  const result=await waitFor(s=>!s.busy);
  if(['infinite','reflow','repeated'].includes(mode)){
   assert.equal(result.state,'failed',JSON.stringify(result));assert.equal(result.parts,0);assert.equal(result.result,undefined);
   assert.equal(result.reasonCode,mode==='infinite'?'FULL_GROWTH_LIMIT':'VISUAL_CONTINUITY_FAILED');
   assert.ok(result.diagnostics.fullPageRestarts<=1);
  }else{
   await verify(result);
   assert.equal(result.diagnostics.fullPageRestarts,0);
   assert.equal(result.metrics.retries,0);
   if(mode==='once'||mode==='multiple'){
    assert.ok(result.diagnostics.endExtensions>=(mode==='once'?1:3));
    assert.ok(result.diagnostics.maxObservedHeight>result.diagnostics.initialHeight);
   }
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS adaptive',mode,JSON.stringify(result.diagnostics));
 }
}
