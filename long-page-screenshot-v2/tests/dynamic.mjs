import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testDynamicRegion({ page, worker, message, waitFor, capture, selectRegion, PNG }) {
  const reference = (await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => c.toDataURL().split(',')[1])))
    .map(data => PNG.sync.read(Buffer.from(data, 'base64')));
  const select = async (container = false) => {
    if (container) await page.evaluate(() => document.getElementById('target-article').style.paddingBottom = '20px');
    await capture('region');
    await page.mouse.click(642, 245);
    await page.mouse.click(80, 40);
    await page.evaluate(() => scrollTo(0, 1940));
    await page.mouse.click(730, 245);
    // Last pixel is deliberately inside the bottom DOM anchor.
    await page.mouse.click(579, container ? 509 : 499);
  };
  const start = () => page.mouse.click(811, 245);
  const verify = async (result, container = false) => {
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.equal(result.parts, 1);
    const png = PNG.sync.read(await readFile(result.result.filename));
    assert.equal(png.width, 499);assert.equal(png.height, container ? 2409 : 2399);
    // Compare the entire output to immutable pre-selection canvas pixels,
    // including TOP/CHECKPOINT/BOTTOM text, both edges and every seam row.
    for(let y=0;y<png.height;y++) {
      if (y >= 2400) {
        for (let x=0;x<png.width;x++) assert.deepEqual([...png.data.subarray((y*png.width+x)*4,(y*png.width+x+1)*4)], [224,0,224,255]);
        continue;
      }
      const expected=reference[Math.floor(y/480)], source=(y%480)*expected.width*4;
      assert.deepEqual(png.data.subarray(y*png.width*4,(y+1)*png.width*4),
        expected.data.subarray(source,source+png.width*4), `content row ${y}`);
    }
  };
  const reset = async () => { await page.reload(); };
  await select(true);await page.evaluate(() => changeBanner());await start();
  await verify(await waitFor(s => !s.busy), true);
  console.log('PASS unchanged container anchor follows translation: all five markers and padding pixels');
  await reset();await select(true);
  await page.evaluate(() => {
    document.getElementById('dynamic-banner-zone').style.height = '0px';
    document.getElementById('bottom-zone').remove();
  });
  await start();await verify(await waitFor(s => !s.busy), true);
  console.log('PASS upward translation resolves anchors even when old numeric bottom exceeds document');
  // Both points use the real picker; the lower point hits article padding,
  // not the fixed-size BOTTOM canvas. Growth moves the marker past old dy.
  const assertResizeFailure = async result => {
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.match(result.message, /锚点尺寸已变化/);
    assert.equal(result.metrics.retries, 1);
    assert.equal(result.parts, 0);
    assert.equal(result.result, undefined);
    assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length, 0);
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [0, 0]);
  };
  for (const timing of ['before', 'committed', 'bitmap']) {
    await reset();await select(true);
    const downloadsBefore = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    if (timing === 'before') await page.evaluate(() => growArticle());
    if (timing === 'bitmap') await worker.evaluate(() => {
      const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      chrome.tabs.captureVisibleTab = async (...args) => {
        chrome.tabs.captureVisibleTab = original;
        const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
        await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>growArticle()});
        return original(...args);
      };
    });
    await start();
    if (timing === 'committed') {
      await waitFor(s => s.state === 'capturing');
      assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length, 1);
      await page.evaluate(() => growArticle());
    }
    await assertResizeFailure(await waitFor(s => !s.busy));
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), downloadsBefore);
    console.log(`PASS article padding anchor resize ${timing}: one retry, explicit failure, no downloaded PNG, canvas cleaned`);
  }
  await reset();await select();
  await page.evaluate(() => changeBanner());
  await start();await verify(await waitFor(s=>!s.busy));
  console.log('PASS dynamic selection-before-start translation: TOP, 3 checkpoints, BOTTOM and every row');

  await reset();await select();
  await page.evaluate(()=>{
    const probe=document.createElement('div');probe.id='prepare-probe';
    probe.style.cssText='position:fixed;top:0;left:0;width:100px;height:30px;z-index:10';
    document.body.append(probe);
    const style=document.createElement('style');
    style.textContent='body:has(#prepare-probe[style*="visibility: hidden"]) #dynamic-banner-zone{height:220px!important}';
    document.head.append(style);
  });
  await start();await verify(await waitFor(s=>!s.busy));
  assert.equal(await page.locator('#prepare-probe').evaluate(el=>el.style.visibility),'');
  console.log('PASS final region resolves after preparation changes layout; style restored');

  await reset();await select();await start();
  await waitFor(s=>s.state==='capturing');
  await page.evaluate(() => startBanners());
  const moving=await waitFor(s=>!s.busy);await page.evaluate(()=>stopBanners());
  await verify(moving);
  console.log('PASS continuously changing upper banner during capture', JSON.stringify(moving.metrics));

  await reset();await select();await start();
  await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>{document.getElementById('bottom-zone').style.width='1400px';window.bottomTimer=setInterval(growBottom,450)});
  await verify(await waitFor(s=>!s.busy));
  console.log('PASS outside bottom growth with content identity');

  await reset();await select();
  await worker.evaluate(()=>{
    const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab=async (...args)=>{
      chrome.tabs.captureVisibleTab=original;
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>changeBanner()});
      return original(...args);
    };
  });
  await start();const resampled=await waitFor(s=>!s.busy);await verify(resampled);
  assert.equal(resampled.metrics.frameRetries,1);assert.equal(resampled.metrics.retries,0);
  console.log('PASS translation during bitmap acquisition discards only uncommitted frame');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>{
    const old=document.getElementById('CHECKPOINT_2'), replacement=old.cloneNode();
    replacement.getContext('2d').drawImage(old,0,0);old.replaceWith(replacement);
  });
  const restarted=await waitFor(s=>!s.busy);await verify(restarted);
  assert.equal(restarted.metrics.retries,1);
  console.log('PASS local node replacement discards canvas and succeeds after one restart');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>document.getElementById('BOTTOM_MARKER').remove());
  const lostDuringCapture=await waitFor(s=>!s.busy);
  assert.equal(lostDuringCapture.state,'failed');assert.match(lostDuringCapture.message,/锚点已失效/);
  assert.equal(lostDuringCapture.parts,0);
  assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
  assert.deepEqual(await page.evaluate(()=>[scrollX,scrollY]),[0,0]);
  console.log('PASS anchor loss after committed frame fails without PNG and restores');

  await reset();await select();
  await page.mouse.click(650,150);await page.keyboard.press('Meta+A');await page.keyboard.type('80');
  await page.evaluate(()=>changeBanner());await start();
  const numeric=await waitFor(s=>!s.busy);assert.equal(numeric.state,'complete',JSON.stringify(numeric));
  const numericPNG=PNG.sync.read(await readFile(numeric.result.filename));
  assert.equal(numericPNG.height,2399);
  assert.deepEqual([...numericPNG.data.subarray(0,3)],[255,0,0]);
  console.log('PASS manual numeric edit clears anchors and deliberately keeps document coordinates');

  await reset();await select();
  await page.evaluate(()=>document.getElementById('TOP_MARKER').remove());
  await start();
  const removed=await waitFor(s=>!s.busy);
  assert.equal(removed.state,'failed');assert.match(removed.message,/锚点已失效/);assert.equal(removed.parts,0);
  console.log('PASS removed anchor fails closed');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>{let n=0;window.scopeTimer=setInterval(()=>{
    document.getElementById('CHECKPOINT_2').style.height=(++n%2?600:480)+'px';
  },150)});
  const unstable=await waitFor(s=>!s.busy);
  assert.equal(unstable.state,'failed',JSON.stringify(unstable));assert.match(unstable.message,/所选内容本身持续变化/);
  assert.equal(unstable.parts,0);assert.equal(unstable.metrics.retries,1);
  console.log('PASS scope changes exhaust one retry without output');

  await reset();await select();
  await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(tab.id,1.25)});
  // Submit via the real content context because UI coordinates changed with zoom.
  const state=await message({type:'STATUS'});
  await selectRegion(state,{left:80,top:40,right:579,bottom:2439},false);
  const zoom=await waitFor(s=>!s.busy);assert.equal(zoom.state,'failed');assert.match(zoom.message,/视口或缩放/);
  console.log('PASS selection viewport/zoom changes rejected');
}
