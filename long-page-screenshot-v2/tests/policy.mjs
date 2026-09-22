import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installVisualMutation } from './visual-hooks.mjs';
export async function testPolicy({page,worker,control,context,id,waitFor,capture,selectRegion,PNG}) {
 for(const [kind,policy] of [['ad','robust'],['ad','strict'],['clean-shift','strict']]){
  await page.goto(new URL('?kind='+kind,page.url()).href);
  const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference),'base64'));
  await installVisualMutation(worker);
  await capture('full','css',policy);
  const result=await waitFor(s=>!s.busy),v=result.diagnostics.visual;
  assert.equal(await page.evaluate(()=>visualMutationStatus().changed),true,'mutation must occur during capture');
  assert.equal(result.diagnostics.continuityPolicy,policy);assert.equal(v.continuityPolicy,policy);
  assert.equal(v.bottomTailAccepted,0);
  if(kind==='ad'&&policy==='strict'){
   assert.equal(result.state,'failed',JSON.stringify(result));assert.equal(result.reasonCode,'VISUAL_CONTINUITY_FAILED');
   assert.equal(result.parts,0);assert.equal(result.result,undefined);assert.equal(v.visualRecoveryRetries,2);
   assert.equal(v.strictCoverageFailures,3);assert.match(result.message,/智能容错/);
   assert.ok(v.trace.every(t=>t.zones.left.pass===false));
  }else{
   assert.equal(result.state,'complete',JSON.stringify(result));
   const png=PNG.sync.read(await readFile(result.result.filename));
   assert.equal(png.width,900);assert.equal(png.height,3200);
   for(let y=0;y<3200;y++)assert.deepEqual(png.data.subarray((y*900+(kind==='ad'?270:0))*4,(y+1)*900*4),ref.data.subarray((y*900+(kind==='ad'?270:0))*4,(y+1)*900*4));
   if(policy==='strict'){assert.ok(v.strictCoverageChecks>0);assert.equal(v.strictCoverageFailures,0);assert.ok(v.trace.some(t=>t.correction===-45))}
  }
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  assert.equal(await page.evaluate(()=>scrollY),0);
  console.log('PASS policy',kind,policy);
 }
 const reopen=async()=>{await page.bringToFront();await control.reload();await control.evaluate(()=>preferencesReady)};
 await reopen();
 assert.equal(await control.locator('#robust').isChecked(),true);
 assert.equal(await control.locator('#remember').isChecked(),false);
 await control.locator('#strict').check();await control.locator('#remember').check();
 await control.evaluate(()=>preferenceWrites);
 assert.deepEqual(await worker.evaluate(async()=> (await chrome.storage.local.get('continuitySitePoliciesV1')).continuitySitePoliciesV1),{'127.0.0.1':'strict'});
 await reopen();assert.equal(await control.locator('#strict').isChecked(),true);assert.equal(await control.locator('#remember').isChecked(),true);
 await control.locator('#remember').uncheck();await control.evaluate(()=>preferenceWrites);
 assert.deepEqual(await worker.evaluate(async()=> (await chrome.storage.local.get('continuitySitePoliciesV1')).continuitySitePoliciesV1),{});
 assert.equal(await control.locator('#strict').isChecked(),true);
 await reopen();assert.equal(await control.locator('#robust').isChecked(),true);assert.equal(await control.locator('#remember').isChecked(),false);
 await control.evaluate(()=>{chrome.runtime.sendMessage=async message=>{globalThis.sent=message;return {ok:false,error:'test intercept'}};chrome.storage.local.set=async()=>{throw Error('storage unavailable')}});
 await control.locator('#strict').check();await control.locator('#remember').check();await control.evaluate(()=>preferenceWrites);
 assert.match(await control.locator('#preference-status').textContent(),/未保存/);
 await control.locator('#full').click();
 assert.equal(await control.evaluate(()=>sent.continuityPolicy),'strict');
 await reopen();
 console.log('PASS popup defaults, persistence, removal, storage failure and START policy');
 await page.goto(new URL('?kind=static',page.url()).href);
 const ref=PNG.sync.read(Buffer.from(await page.evaluate(()=>reference),'base64'));
 const job=await capture('region','css','strict');
 await selectRegion(job,{left:200,top:100,right:700,bottom:1700});
 const result=await waitFor(s=>!s.busy);
 assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.diagnostics.continuityPolicy,undefined);
 const png=PNG.sync.read(await readFile(result.result.filename));assert.equal(png.width,500);assert.equal(png.height,1600);
 for(let y=0;y<1600;y++)assert.deepEqual(png.data.subarray(y*500*4,(y+1)*500*4),ref.data.subarray(((y+100)*900+200)*4,((y+100)*900+700)*4));
 console.log('PASS basic Region smoke with Strict ignored');
}
