import { clickPickerButton } from './picker.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testNested({page, worker, message, capture, waitFor, PNG, browserCDP}) {
  const position = () => page.evaluate(()=>[scrollY,document.getElementById('conversation').scrollTop]);
  const select = async cross => {
    const job=await capture('region','css');
    await clickPickerButton(page,'first');await page.mouse.click(80,40);
    if(cross) await page.evaluate(()=>document.getElementById('conversation').scrollTop=4180);
    await clickPickerButton(page,'second');await page.mouse.click(579,cross?659:439);
    assert.deepEqual(await position(),[0,cross?4180:0]);
    return job;
  };
  const start = () => clickPickerButton(page,'capture');
  for(const mode of ["same","cross","resize"]) {
    const cross=mode!=="same";
    await page.reload();await select(cross);await start();
    if(mode==="resize") {
      await waitFor(s=>s.state==="capturing");
      await page.evaluate(()=>document.getElementById("conversation").style.height="500px");
    }
    const result=await waitFor(s=>!s.busy);
    assert.equal(result.state,'complete',JSON.stringify(result));
    const png=PNG.sync.read(await readFile(result.result.filename));
    assert.equal(png.width,499);assert.equal(png.height,cross?4799:399);
    const references=(await page.evaluate(()=>[...document.querySelectorAll('canvas')].map(c=>c.toDataURL().split(',')[1])))
      .map(v=>PNG.sync.read(Buffer.from(v,'base64')));
    for(let y=0;y<png.height;y++) {
      const offset=y%480*500*4;
      assert.deepEqual(png.data.subarray(y*499*4,(y+1)*499*4),references[Math.floor(y/480)].data.subarray(offset,offset+499*4),`nested row ${y}`);
    }
    assert.deepEqual(await position(),[0,0]);
    assert.equal(result.diagnostics.environment.actual.targetKind,'element');
    assert.equal(result.metrics.retries,mode==='resize'?1:0);
    console.log('PASS nested',mode,'every pixel, markers, shell exclusion, scroll restoration');
  }
  for(const action of ['cancel','remove','replace']) {
    await page.reload();const job=await select(true);await start();await waitFor(s=>s.state==='capturing');
    if(action==='cancel') await message({type:'CANCEL',id:job.id});
    else await page.evaluate(action=>{
      const old=document.getElementById('conversation');
      if(action==='remove') old.remove();else old.replaceWith(old.cloneNode(true));
    },action);
    const result=await waitFor(s=>!s.busy);
    assert.equal(result.state,action==='cancel'?'cancelled':'failed',JSON.stringify(result));
    assert.equal(result.parts,0);assert.equal(result.result,undefined);
    if(action==='cancel') assert.deepEqual(await position(),[0,0]);
    else assert.equal(result.reasonCode,'TARGET_UNRESOLVABLE');
    assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
    console.log('PASS nested',action,'no PNG, offscreen cleanup');
  }
  await page.reload();await select(true);await start();await waitFor(s=>s.state==='capturing'&&s.frames>=2);
  const {targetInfos}=await browserCDP.send('Target.getTargets');
  const target=targetInfos.find(t=>t.type==='service_worker'&&t.url===worker.url());
  await browserCDP.send('Target.closeTarget',{targetId:target.targetId});
  const interrupted=await waitFor(s=>!s.busy);
  assert.equal(interrupted.state,'failed');assert.match(interrupted.message,/中断/);
  assert.deepEqual(await position(),[0,0]);
  worker=page.context().serviceWorkers()[0]||await page.context().waitForEvent('serviceworker');
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
  console.log('PASS nested worker interruption restores target and clears offscreen');

}
