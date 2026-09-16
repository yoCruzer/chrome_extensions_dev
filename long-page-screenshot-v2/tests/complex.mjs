import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testComplexPage({ page, worker, message, waitFor, capture, selectRegion, root, PNG }) {
  const styles = () => page.evaluate(() => Object.fromEntries(
    ['fixed-header', 'sticky-sidebar', 'fixed-background', 'tiny-fixed'].map(id => [id, document.getElementById(id).style.cssText])));
  const assertRestored = async (before, position) => {
    assert.deepEqual(await styles(), before);
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), position);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'smooth');
    assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 0);
  };
  const regionEdges = () => page.evaluate(() => {
    const rect = document.getElementById('article').getBoundingClientRect();
    return { left: Math.ceil(rect.left + scrollX), top: Math.ceil(rect.top + scrollY),
      right: Math.floor(rect.right + scrollX), bottom: Math.floor(rect.bottom + scrollY) };
  });
  const filesFor = async (since) => (await worker.evaluate(() => chrome.downloads.search({})))
    .filter(file => !since.has(file.id)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const downloadIds = async () => new Set((await worker.evaluate(() => chrome.downloads.search({}))).map(file => file.id));
  const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];

  // Start before the fixture's two-second timer fires; full-page warm-up must
  // include both the inserted panel and all locally delayed images.
  const before = await styles();
  const position = [0, 0];
  const since = await downloadIds();
  await capture('full');
  await waitFor(s => s.state === 'loading');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('fixed-header')).visibility), 'hidden');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sticky-sidebar')).position), 'relative');
  for (const id of ['fixed-background', 'tiny-fixed']) assert.equal((await styles())[id], before[id]);
  const full = await waitFor(s => !s.busy);
  assert.equal(full.state, 'complete', JSON.stringify(full));
  assert.ok(full.parts >= 2);
  assert.equal(await page.locator('img[data-loaded="true"]').count(), 18);
  assert.equal(await page.locator('.dynamic-panel').count(), 1);
  const fullFiles = await filesFor(since);
  const fullPNGs = await Promise.all(fullFiles.map(async file => PNG.sync.read(await readFile(file.filename))));
  const expectedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.equal(fullPNGs.reduce((sum, png) => sum + png.height, 0), expectedHeight);
  assert.ok(fullPNGs.every(png => png.width === 900));
  const last = fullPNGs.at(-1);
  assert.deepEqual(pixel(last, 450, last.height - 10), [31, 61, 85]);
  // The former fixed header must not obscure any captured tile.
  for (const png of fullPNGs) for (let y = 0; y < png.height; y++) {
    assert.notDeepEqual(pixel(png, 890, y), [213, 42, 72]);
  }
  await assertRestored(before, position);
  await writeFile(join(root, 'complex-full-result.json'), JSON.stringify({ full, fullFiles, expectedHeight }, null, 2));
  console.log('PASS complex full: multi-part bottom, 18 lazy images, timed growth, fixed/sticky handling and restoration');

  const edges = await regionEdges();
  const regionSince = await downloadIds();
  await capture('region');
  await page.screenshot({ path: join(root, 'complex-selection.png') });
  // Use the actual closed-shadow selection UI across a long scroll.
  await page.mouse.click(642, 245);
  await page.mouse.click(edges.left, edges.top);
  await page.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), edges.bottom - 550);
  await page.mouse.click(730, 245);
  const bottomPoint = await page.evaluate(bottom => bottom - scrollY, edges.bottom);
  await page.mouse.click(edges.right, bottomPoint);
  await page.mouse.click(811, 245);
  const region = await waitFor(s => !s.busy);
  assert.equal(region.state, 'complete', JSON.stringify(region));
  const regionFiles = await filesFor(regionSince);
  const regionPNGs = await Promise.all(regionFiles.map(async file => PNG.sync.read(await readFile(file.filename))));
  assert.ok(regionPNGs.every(png => png.width === edges.right - edges.left));
  assert.equal(regionPNGs.reduce((sum, png) => sum + png.height, 0), edges.bottom - edges.top);
  // Continuous green border proves no gaps across tiles/parts and no sidebar.
  for (const png of regionPNGs) for (let y = 0; y < png.height; y++) assert.deepEqual(pixel(png, 1, y), [20, 123, 102]);
  await assertRestored(before, position);
  await writeFile(join(root, 'complex-region-result.json'), JSON.stringify({ region, regionFiles, edges }, null, 2));
  console.log('PASS complex region: real two-corner UI, article-only dimensions and continuous border through every row');

  // Change height while the selection UI is open, even when its edges still fit.
  const stale = await capture('region');
  const oldEdges = await regionEdges();
  await page.evaluate(() => document.getElementById('grow').click());
  const rejected = await selectRegion(stale, oldEdges, false);
  assert.match(rejected.error, /尺寸或视口发生变化/);
  assert.equal((await waitFor(s => !s.busy)).state, 'failed');
  await assertRestored(before, position);
  console.log('PASS stale region: changed page height rejected even with boundaries still inside page');

  // Shrinking the page invalidates a selected bottom edge.
  const shrinking = await capture('region');
  const shrinkEdges = await regionEdges();
  await page.evaluate(() => document.getElementById('section-18').remove());
  assert.match((await selectRegion(shrinking, shrinkEdges, false)).error, /选区无效/);
  await waitFor(s => !s.busy);
  await assertRestored(before, position);

  // Region warm-up must reject growth rather than silently crop stale coordinates.
  const warming = await capture('region');
  await selectRegion(warming, await regionEdges());
  await waitFor(s => s.state === 'loading');
  await page.evaluate(() => document.getElementById('grow').click());
  const warmFailure = await waitFor(s => !s.busy);
  assert.equal(warmFailure.state, 'failed', JSON.stringify(warmFailure));
  assert.match(warmFailure.message, /尺寸或视口发生变化/);
  await assertRestored(before, position);
  console.log('PASS region bounds and growth during warm-up: clear failure and full restoration');

  // Cancel with an actual live offscreen document, then recover with a new job.
  const cancelledJob = await capture('full');
  await waitFor(s => s.state === 'capturing');
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 1);
  await page.keyboard.press('Escape');
  const cancelled = await waitFor(s => !s.busy);
  assert.equal(cancelled.state, 'cancelled');
  await assertRestored(before, position);
  const recovery = await capture('region');
  assert.equal((await message({ type: 'CANCEL', id: cancelledJob.id })).ok, false);
  const newEdges = await regionEdges();
  await worker.evaluate(() => {
    const close = chrome.offscreen.closeDocument.bind(chrome.offscreen);
    chrome.offscreen.closeDocument = async () => {
      chrome.offscreen.closeDocument = close;
      throw new Error('Injected one-time offscreen close failure');
    };
  });
  await selectRegion(recovery, { ...newEdges, bottom: newEdges.top + 600 });
  assert.equal((await waitFor(s => !s.busy)).state, 'complete');
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 1);
  const afterCloseFailure = await capture('region');
  await selectRegion(afterCloseFailure, { ...newEdges, bottom: newEdges.top + 600 });
  assert.equal((await waitFor(s => !s.busy)).state, 'complete');
  await assertRestored(before, position);
  console.log('PASS complex cancellation, stale cancel rejection, export recovery and retry after offscreen close failure');
}
