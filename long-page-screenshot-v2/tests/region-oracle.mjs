import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Observe the real Chrome bitmaps, not production FRAME rectangles or anchor
// resolutions. Each expected row comes from the user's fixed viewport-x / content-y
// rectangle in the bitmap acquired at that instant. This handles temporal pages
// without pretending that frozen coordinates promise semantic content tracking.
export async function installRegionOracle(worker) {
  await worker.evaluate(() => {
    const original = globalThis.__v2RegionCaptureOriginal || chrome.tabs.captureVisibleTab;
    globalThis.__v2RegionCaptureOriginal = original;
    globalThis.__v2RegionSamples = [];
    chrome.tabs.captureVisibleTab = async function (...args) {
      const dataUrl = await original.apply(this, args);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw Error('Region oracle lost its active tab');
      const [measured] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED',
        func: () => ({ x: scrollX, y: scrollY, innerWidth, innerHeight,
          clientHeight: document.documentElement.clientHeight })
      });
      globalThis.__v2RegionSamples.push({ dataUrl, view: measured.result });
      return dataUrl;
    };
  });
}

export function verifyFrozenRows(output, samples, { left, top, right, bottom }) {
  const width = right - left, height = bottom - top;
  assert.equal(output.width, width); assert.equal(output.height, height);
  let row = 0;
  for (const { png, view } of samples) {
    // These fixtures deliberately use CSS output at a true 1x backing scale.
    assert.equal(png.width, view.innerWidth); assert.equal(png.height, view.innerHeight);
    assert.ok(left >= 0 && right <= png.width);
    assert.ok(top + row >= view.y, `uncovered fixed-scope row ${row}`);
    const end = Math.min(height, view.y + view.clientHeight - top);
    assert.ok(end > row, 'recorded frame must add new fixed-scope rows');
    for (; row < end; row++) {
      const sourceY = top + row - view.y;
      assert.ok(Number.isInteger(sourceY) && sourceY >= 0 && sourceY < png.height);
      const start = (sourceY * png.width + left) * 4;
      assert.deepEqual(output.data.subarray(row * width * 4, (row + 1) * width * 4),
        png.data.subarray(start, start + width * 4), `fixed-scope row ${row}`);
    }
  }
  assert.equal(row, height, 'the final selected row must be covered');
}

export async function verifyRegionOracle(worker, result, edges, PNG) {
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.equal(result.parts, 1);
  const records = await worker.evaluate(() => {
    chrome.tabs.captureVisibleTab = globalThis.__v2RegionCaptureOriginal;
    delete globalThis.__v2RegionCaptureOriginal;
    const samples = globalThis.__v2RegionSamples;
    delete globalThis.__v2RegionSamples;
    return samples;
  });
  // No discarded acquisitions are expected in these non-resizing scenarios.
  assert.equal(records.length, result.frames);
  const png = PNG.sync.read(await readFile(result.result.filename));
  const samples = records.map(({ dataUrl, view }) => ({ view,
    png: PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64')) }));
  verifyFrozenRows(png, samples, edges);
  assert.equal(result.diagnostics.regionViewport.left, edges.left);
  assert.equal(result.diagnostics.regionViewport.right, edges.right);
  assert.deepEqual(result.diagnostics.region.current,
    { x: 0, y: edges.top, width: edges.right - edges.left, height: edges.bottom - edges.top });
  return png;
}
