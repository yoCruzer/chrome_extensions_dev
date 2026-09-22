import { clickPickerButton, fillPickerField } from './picker.mjs';
import { installRegionOracle, verifyRegionOracle } from './region-oracle.mjs';
import assert from 'node:assert/strict';

export async function testDynamicRegion({ page, worker, waitFor, capture, PNG }) {
  const reference = (await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => c.toDataURL().split(',')[1])))
    .map(data => PNG.sync.read(Buffer.from(data, 'base64')));
  let edges;
  const select = async (container = false) => {
    if (container) await page.evaluate(() => document.getElementById('target-article').style.paddingBottom = '20px');
    await capture('region', 'css');
    await clickPickerButton(page, 'first'); await page.mouse.click(80, 40);
    await page.evaluate(() => scrollTo(0, 1940));
    await clickPickerButton(page, 'second'); await page.mouse.click(579, container ? 509 : 499);
    edges = { left: 80, top: 40, right: 579, bottom: container ? 2449 : 2439 };
    await installRegionOracle(worker);
  };
  const start = () => clickPickerButton(page, 'capture');
  const reset = () => page.reload();
  const committed = () => waitFor(s => s.state === 'capturing' && s.frames >= 1);
  const verify = async (result, stable = false) => {
    const png = await verifyRegionOracle(worker, result, edges, PNG);
    assert.equal(result.metrics.retries, 0);
    if (stable) for (let y = 0; y < png.height; y++) {
      const expected = reference[Math.floor(y / 480)], source = (y % 480) * 500 * 4;
      assert.deepEqual(png.data.subarray(y * 499 * 4, (y + 1) * 499 * 4),
        expected.data.subarray(source, source + 499 * 4), `immutable content row ${y}`);
    }
    return png;
  };
  const fail = async pattern => {
    const result = await waitFor(s => !s.busy);
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.match(result.message, pattern); assert.equal(result.parts, 0); assert.equal(result.result, undefined);
    assert.deepEqual(await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })), []);
    return result;
  };

  // Phase 2.2: the four displayed UI values, not subsequently resolved anchors,
  // are authoritative even if content moves before the Start click.
  await select(true); await page.evaluate(() => changeBanner()); await start();
  const before = await waitFor(s => !s.busy), beforePNG = await verify(before);
  assert.deepEqual([...beforePNG.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.ok(before.diagnostics.regionDiagnostics.anchorTranslations > 0);
  console.log('PASS pre-start translation preserves four UI edges; all pixels match frozen scope, not moved anchors');

  await reset(); await select(true);
  await page.evaluate(() => {
    document.getElementById('dynamic-banner-zone').style.height = '0px';
    document.getElementById('bottom-zone').remove();
  });
  await start(); await fail(/选区无效/);
  console.log('PASS upward shrink rejects now-out-of-bounds numeric bottom instead of silently moving the scope');

  for (const timing of ['before', 'committed', 'bitmap']) {
    await reset(); await select(true);
    const downloadsBefore = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    if (timing === 'before') await page.evaluate(() => growArticle());
    if (timing === 'bitmap') await worker.evaluate(() => {
      const original = chrome.tabs.captureVisibleTab;
      chrome.tabs.captureVisibleTab = async function (...args) {
        chrome.tabs.captureVisibleTab = original;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => growArticle() });
        return original.apply(this, args);
      };
    });
    await start();
    if (timing === 'committed') { await committed(); await page.evaluate(() => growArticle()); }
    const result = await waitFor(s => !s.busy); await verify(result);
    assert.ok(result.diagnostics.regionDiagnostics.shapeChanges > 0, JSON.stringify(result.diagnostics));
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), downloadsBefore + 1);
    console.log(`PASS article growth ${timing}: exact fixed 499x2409 crop and every row, no automatic expansion`);
  }

  await reset(); await select(); await page.evaluate(() => changeBanner()); await start();
  await verify(await waitFor(s => !s.busy));
  console.log('PASS fixed-size canvas anchors also remain advisory before Start');

  await reset(); await select();
  await page.evaluate(() => {
    const probe = document.createElement('div'); probe.id = 'prepare-probe';
    probe.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:30px;z-index:10';
    document.body.append(probe);
    const style = document.createElement('style');
    style.textContent = 'body:has(#prepare-probe[style*="visibility: hidden"]) #dynamic-banner-zone{height:220px!important}';
    document.head.append(style);
  });
  await start(); await verify(await waitFor(s => !s.busy));
  assert.equal(await page.locator('#prepare-probe').evaluate(el => el.style.visibility), '');
  console.log('PASS PREPARE-induced layout change cannot rewrite the frozen UI edges; styles restored');

  await reset(); await select(); await start(); await committed();
  await page.evaluate(() => startBanners());
  const moving = await waitFor(s => !s.busy); await page.evaluate(() => stopBanners()); await verify(moving);
  assert.ok(moving.diagnostics.regionDiagnostics.anchorTranslations > 0);
  console.log('PASS moving upper banner: every temporal frame uses fixed coordinates, not semantic tracking');

  await reset(); await select(); await start(); await committed();
  await page.evaluate(() => { document.getElementById('bottom-zone').style.width = '1400px'; window.bottomTimer = setInterval(growBottom, 450); });
  await verify(await waitFor(s => !s.busy), true);
  console.log('PASS outside bottom growth retains all immutable markers and pixels');

  await reset(); await select();
  await worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async function (...args) {
      chrome.tabs.captureVisibleTab = original;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => changeBanner() });
      return original.apply(this, args);
    };
  });
  await start(); const translated = await waitFor(s => !s.busy); await verify(translated);
  assert.equal(translated.metrics.frameRetries, 0);
  assert.ok(translated.diagnostics.regionDiagnostics.anchorTranslations > 0);
  console.log('PASS bitmap-time translation is diagnosed without changing crop or discarding the frame');

  await reset(); await select(); await start(); await committed();
  await page.evaluate(() => {
    const old = document.getElementById('CHECKPOINT_2'), replacement = old.cloneNode();
    replacement.getContext('2d').drawImage(old, 0, 0); old.replaceWith(replacement);
  });
  await verify(await waitFor(s => !s.busy), true);
  console.log('PASS unrelated node replacement preserves immutable pixels without a restart');

  await reset(); await select(); await start(); await committed();
  await page.evaluate(() => document.getElementById('BOTTOM_MARKER').remove());
  const lost = await waitFor(s => !s.busy); await verify(lost);
  assert.ok(lost.diagnostics.regionDiagnostics.anchorFallbacks > 0);
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [0, 0]);
  assert.deepEqual(await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })), []);
  console.log('PASS removed bottom anchor leaves frozen crop unchanged and cleans up');

  await reset(); await select(); await fillPickerField(page, 'left', 80);
  await page.evaluate(() => changeBanner()); await start();
  const numeric = await waitFor(s => !s.busy), numericPNG = await verify(numeric);
  assert.deepEqual([...numericPNG.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(numeric.diagnostics.regionDiagnostics.anchorResolutions, 0);
  console.log('PASS real numeric editing clears anchors and keeps fixed document coordinates');

  await reset(); await select(true); await start(); await committed();
  await page.evaluate(() => growArticle()); await page.waitForTimeout(250); await page.evaluate(() => growArticle());
  const repeated = await waitFor(s => !s.busy); await verify(repeated);
  assert.equal(repeated.attempt, 1); assert.ok(repeated.diagnostics.regionDiagnostics.shapeChanges > 0);
  console.log('PASS repeated growth preserves 499x2409 scope and all acquired pixel rows');

  await reset(); await select(); await page.evaluate(() => document.getElementById('TOP_MARKER').remove()); await start();
  const removed = await waitFor(s => !s.busy); await verify(removed);
  assert.ok(removed.diagnostics.regionDiagnostics.anchorFallbacks > 0);
  console.log('PASS pre-start anchor loss is advisory when the displayed numeric rectangle is still valid');

  await reset(); await select(); await start(); await committed();
  await page.evaluate(() => { let n = 0; window.scopeTimer = setInterval(() => {
    document.getElementById('CHECKPOINT_2').style.height = (++n % 2 ? 600 : 480) + 'px';
  }, 150); });
  const unstable = await waitFor(s => !s.busy); await page.evaluate(() => clearInterval(window.scopeTimer)); await verify(unstable);
  assert.ok(unstable.diagnostics.regionDiagnostics.shapeChanges > 0);
  console.log('PASS repeated internal reflow remains advisory; exact frozen coordinates on every frame');

  await reset(); await select(); await start(); await committed();
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.setZoom(tab.id, 1.25); });
  const zoom = await fail(/CAPTURE_ENV_CHANGED/); assert.equal(zoom.reasonCode, 'CAPTURE_ENV_CHANGED');
  console.log('PASS actual viewport/zoom changes still reject output');
}
