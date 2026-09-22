import { clickPickerButton } from './picker.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testDynamicRegion({ page, worker, waitFor, capture, PNG }) {
  const reference = (await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => c.toDataURL().split(',')[1])))
    .map(data => PNG.sync.read(Buffer.from(data, 'base64')));
  const select = async (container = false) => {
    if (container) await page.evaluate(() => document.getElementById('target-article').style.paddingBottom = '20px');
    await capture('region','css');
    await clickPickerButton(page,'first');
    await page.mouse.click(80, 40);
    await page.evaluate(() => scrollTo(0, 1940));
    await clickPickerButton(page,'second');
    // Last pixel is deliberately inside the bottom DOM anchor.
    await page.mouse.click(579, container ? 509 : 499);
  };
  const start = () => clickPickerButton(page,'capture');
  const verify = async (result, container = false, grown = false, frozen = false) => {
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.equal(result.parts, 1);
    const png = PNG.sync.read(await readFile(result.result.filename));
    assert.equal(png.width, 499);assert.equal(png.height, (container ? 2409 : 2399) + (grown && !frozen ? 300 : 0));
    // Compare the entire output to immutable pre-selection canvas pixels,
    // including TOP/CHECKPOINT/BOTTOM text, both edges and every seam row.
    for(let y=0;y<png.height;y++) {
      if (y >= 2400 + (grown ? 300 : 0) || (grown && y >= 1920 && y < 2220)) {
        for (let x=0;x<png.width;x++) assert.deepEqual([...png.data.subarray((y*png.width+x)*4,(y*png.width+x+1)*4)], [224,0,224,255]);
        continue;
      }
      const row = grown && y >= 2220 ? y - 300 : y;
      const expected=reference[Math.floor(row/480)], source=(row%480)*expected.width*4;
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
    const resized = await waitFor(s => !s.busy);
    if (timing === 'committed') {
      assert.equal(resized.state, 'complete', JSON.stringify(resized));
      const png = PNG.sync.read(await readFile(resized.result.filename));
      assert.equal(png.width,499);assert.equal(png.height,2409);
    } else {
      await verify(resized, true, true, timing === 'bitmap');
    }
    assert.equal(resized.metrics.retries, 0);
    if (timing !== 'before') assert.ok(resized.diagnostics.regionDiagnostics.shapeChanges > 0, JSON.stringify(resized.diagnostics));
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), downloadsBefore + 1);
    console.log(`PASS article growth ${timing}: frozen Region Scope completes without resizing output`);
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
  assert.equal(resampled.metrics.frameRetries,0);assert.equal(resampled.metrics.retries,0);
  assert.ok(resampled.diagnostics.regionCaptureRebases > 0, JSON.stringify(resampled.diagnostics));
  console.log('PASS translation during bitmap acquisition uses post-capture rebase without discarding the frame');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>{
    const old=document.getElementById('CHECKPOINT_2'), replacement=old.cloneNode();
    replacement.getContext('2d').drawImage(old,0,0);old.replaceWith(replacement);
  });
  const restarted=await waitFor(s=>!s.busy);await verify(restarted);
  assert.equal(restarted.metrics.retries,0);
  console.log('PASS unrelated node replacement succeeds without scope fingerprint or restart');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>document.getElementById('BOTTOM_MARKER').remove());
  const lostDuringCapture=await waitFor(s=>!s.busy);
  assert.equal(lostDuringCapture.state,'complete',JSON.stringify(lostDuringCapture));
  const lostPNG=PNG.sync.read(await readFile(lostDuringCapture.result.filename));
  assert.equal(lostPNG.width,499);assert.equal(lostPNG.height,2399);
  assert.ok(lostDuringCapture.diagnostics.regionDiagnostics.anchorFallbacks > 0, JSON.stringify(lostDuringCapture.diagnostics));
  assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
  assert.deepEqual(await page.evaluate(()=>[scrollX,scrollY]),[0,0]);
  console.log('PASS anchor loss after Scope freeze falls back to last runtime region and completes');

  await reset();await select();
  await page.mouse.click(650,150);await page.keyboard.press('Meta+A');await page.keyboard.type('80');
  await page.evaluate(()=>changeBanner());await start();
  const numeric=await waitFor(s=>!s.busy);assert.equal(numeric.state,'complete',JSON.stringify(numeric));
  const numericPNG=PNG.sync.read(await readFile(numeric.result.filename));
  assert.equal(numericPNG.height,2399);
  assert.deepEqual([...numericPNG.data.subarray(0,3)],[255,0,0]);
  console.log('PASS manual numeric edit clears anchors and deliberately keeps document coordinates');

  await reset();await select(true);await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>growArticle());
  await page.waitForTimeout(250);
  await page.evaluate(()=>growArticle());
  const repeated=await waitFor(s=>!s.busy);
  assert.equal(repeated.state,'complete',JSON.stringify(repeated));
  const repeatedPNG=PNG.sync.read(await readFile(repeated.result.filename));
  assert.equal(repeatedPNG.width,499);assert.equal(repeatedPNG.height,2409);
  assert.equal(repeated.attempt,1);assert.equal(repeated.metrics.retries,0);
  assert.ok(repeated.diagnostics.regionDiagnostics.shapeChanges > 0, JSON.stringify(repeated.diagnostics));
  console.log('PASS repeated in-scope reflow: frozen visual Scope stays fixed and capture completes');

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
  const unstable=await waitFor(s=>!s.busy);await page.evaluate(()=>clearInterval(window.scopeTimer));
  assert.equal(unstable.state,'complete',JSON.stringify(unstable));
  const unstablePNG=PNG.sync.read(await readFile(unstable.result.filename));
  assert.equal(unstablePNG.width,499);assert.equal(unstablePNG.height,2399);
  assert.equal(unstable.metrics.retries,0);
  assert.ok(unstable.diagnostics.regionDiagnostics.shapeChanges > 0, JSON.stringify(unstable.diagnostics));
  console.log('PASS repeated region geometry changes remain advisory after Scope freeze');

  await reset();await select();await start();await waitFor(s=>s.state==='capturing');
  await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(tab.id,1.25)});
  const zoom=await waitFor(s=>!s.busy);assert.equal(zoom.state,'failed');assert.match(zoom.message,/CAPTURE_ENV_CHANGED/);
  console.log('PASS capture viewport/zoom changes rejected with diagnostics');
}
