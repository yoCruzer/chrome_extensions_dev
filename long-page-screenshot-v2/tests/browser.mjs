// Optional integration test: NODE_PATH must expose playwright and pngjs.
// All browser profiles and downloads live in /tmp. The production manifest is unchanged.
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { testBottomTail } from "./bottom-tail.mjs";
import { testPolicy } from "./policy.mjs";
import { testVisual } from "./visual.mjs";
import { testFullNested } from "./full-nested.mjs";
import { testProof } from "./proof.mjs";
import { testDiagnostics } from "./diagnostics.mjs";
import { testAdaptive } from "./adaptive.mjs";
import { testNested } from "./nested.mjs";
import { testReliability } from "./reliability.mjs";
import { testDynamicRegion } from "./dynamic.mjs";
import { testComplexPage } from "./complex.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PNG } = require("pngjs");
const root = await mkdtemp(join(tmpdir(), "screenshot-v2-test-"));
const extension = resolve(import.meta.dirname, "..");
const downloads = join(root, "downloads");
await mkdir(downloads);
const fixture = `<!doctype html><style>html{scroll-behavior:smooth;scroll-snap-type:y mandatory}body{margin:0}canvas{display:block}#fixed{position:fixed;top:0;background:red;width:100%;height:60px}</style><canvas width="1500" height="10337"></canvas><div id="fixed">Fixed header</div><script>
const c=document.querySelector('canvas'),ctx=c.getContext('2d');for(let y=0;y<c.height;y++){ctx.fillStyle='rgb('+(y%251)+','+Math.floor(y/251)+',97)';ctx.fillRect(0,y,c.width,1)};
</script>`;
const complexFixture = await readFile(resolve(extension, "../tests/fixtures/test-complex-page.html"), "utf8");
const dynamicFixture = await readFile(resolve(extension, "tests/fixtures/test-dynamic-region-page.html"), "utf8");
const reliabilityFixture = process.env.RELIABILITY_ONLY ? await readFile(resolve(extension, `tests/fixtures/test-${process.env.RELIABILITY_ONLY}-like-page.html`), "utf8") : null;
const nestedFixture = (process.env.NESTED_ONLY || process.env.FULL_NESTED_ONLY) ? await readFile(resolve(extension, "tests/fixtures/test-nested-page.html"), "utf8") : null;
const adaptiveFixture = (process.env.ADAPTIVE_ONLY || process.env.DIAGNOSTICS_ONLY) ? await readFile(resolve(extension, "tests/fixtures/test-adaptive-page.html"), "utf8") : null;
const bottomTailFixture = process.env.BOTTOM_TAIL_ONLY ? await readFile(resolve(extension, "tests/fixtures/test-bottom-tail-page.html"), "utf8") : null;
const visualFixture = (process.env.VISUAL_ONLY || process.env.POLICY_ONLY) ? await readFile(resolve(extension, "tests/fixtures/test-visual-page.html"), "utf8") : null;
const proofFixture = process.env.PROOF_ONLY ? await readFile(resolve(extension, "tests/fixtures/test-proof-page.html"), "utf8") : null;
const server = createServer((req, res) => {
  if (req.url.startsWith('/lazy.svg')) {
    res.setHeader('Content-Type','image/svg+xml');
    setTimeout(()=>res.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="20"><rect width="900" height="20" fill="#e000e0"/></svg>'),600);
    return;
  } res.setHeader("Content-Type", "text/html"); res.end(bottomTailFixture || visualFixture || proofFixture || adaptiveFixture || nestedFixture || reliabilityFixture || (process.env.DYNAMIC_ONLY ? dynamicFixture : process.env.COMPLEX_ONLY ? complexFixture : fixture)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const context = await chromium.launchPersistentContext(join(root, "profile"), {
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: "chromium" }),
  headless: !process.env.HEADED, viewport: process.env.NATIVE_DPR ? null : { width: 900, height: 700 },
  ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging",
    ...(process.env.NATIVE_DPR ? [`--force-device-scale-factor=${process.env.NATIVE_DPR}`, "--window-size=900,700"] : [])]
});
console.log("Artifacts:", root);
try {
  const browserCDP = await context.browser().newBrowserCDPSession();
  const { id } = await browserCDP.send("Extensions.loadUnpacked", { path: extension });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  worker.on("console", message => console.log("worker:", message.text()));
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await page.goto(process.env.SITE_URL || `http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const message = value => control.evaluate(value => chrome.runtime.sendMessage({ target: "background", ...value }), value);
  const waitFor = async predicate => {
    const start = Date.now();
    let state;
    const fail = async reason => {
      const report = { reason, expected: String(predicate), elapsedMs: Date.now() - start, state };
      await writeFile(join(root, 'capture-wait-failure.json'), JSON.stringify(report, null, 2));
      await page.screenshot({path: join(root, 'capture-wait-failure.png')}).catch(() => {});
      throw new Error(`${reason}: ${JSON.stringify(report)}`);
    };
    while (Date.now() - start < 180_000) {
      state = await message({ type: "STATUS" });
      if (predicate(state)) {
        if (!state.busy && ['complete', 'failed', 'cancelled'].includes(state.state)) {
          await writeFile(join(root, 'capture-terminal-state.json'), JSON.stringify(state, null, 2));
        }
        return state;
      }
      if (!state.busy && ['complete', 'failed', 'cancelled'].includes(state.state)) {
        await fail('Capture ended before the expected checkpoint');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await fail('Timed out waiting for capture state');
  };
  const capture = async (mode, output = "auto", continuityPolicy) => {
    await page.bringToFront();
    const { targetInfos: tabs } = await browserCDP.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const targetInfo = tabs.find(tab => tab.type === "tab" && tab.url === page.url());
    assert.ok(targetInfo, JSON.stringify(tabs));
    // Exercise Chrome's real action/activeTab grant in the isolated profile.
    await browserCDP.send("Extensions.triggerAction", { id, targetId: targetInfo.targetId });
    const controlCDP = await context.newCDPSession(control);
    const { targetInfo: controlInfo } = await controlCDP.send("Target.getTargetInfo");
    const { targetInfos } = await browserCDP.send("Target.getTargets");
    for (const target of targetInfos) {
      if (target.url === `chrome-extension://${id}/popup.html` && target.targetId !== controlInfo.targetId) {
        await browserCDP.send("Target.closeTarget", { targetId: target.targetId });
      }
    }
    await controlCDP.detach();
    const result = await message({ type: "START", mode, output, continuityPolicy });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const selectRegion = async (selection, edges, expected = true) => {
    const selected = await worker.evaluate(async ({ id, edges }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async (id, edges) => chrome.runtime.sendMessage({ target: "background", type: "REGION", id, edges }), args: [id, edges] });
      return result.result;
    }, { id: selection.id, edges });
    assert.equal(selected.ok, expected, JSON.stringify(selected));
    return selected;
  };
  if (process.env.POLICY_ONLY) {
    await testPolicy({ page, worker, control, context, id, waitFor, capture, selectRegion, PNG });
  } else if (process.env.BOTTOM_TAIL_ONLY) {
    await testBottomTail({ page, worker, waitFor, capture, PNG });
  } else if (process.env.VISUAL_ONLY) {
    await testVisual({ page, worker, waitFor, capture, PNG });
  } else if (process.env.FULL_NESTED_ONLY) {
    await testFullNested({ page, worker, message, waitFor, capture, PNG, browserCDP });
  } else if (process.env.PROOF_ONLY) {
    await testProof({ page, worker, waitFor, capture, PNG });
  } else if (process.env.DIAGNOSTICS_ONLY) {
    await testDiagnostics({ page, worker, waitFor, capture, PNG });
  } else if (process.env.ADAPTIVE_ONLY) {
    await testAdaptive({ page, worker, message, waitFor, capture, PNG });
  } else if (process.env.NESTED_ONLY) {
    await testNested({ page, worker, message, waitFor, capture, PNG, browserCDP });
  } else if (process.env.RELIABILITY_ONLY) {
    await testReliability({ page, worker, message, waitFor, capture, PNG, kind:process.env.RELIABILITY_ONLY });
  } else if (process.env.DYNAMIC_ONLY) {
    await testDynamicRegion({ page, worker, message, waitFor, capture, selectRegion, PNG });
  } else if (process.env.OUTPUT_ONLY) {
    const panel = page.locator("#long-screenshot-v2-progress");
    for (const [output, ratio] of [["auto", .9], ["css", 1], ["75", .75], ["50", .5], ["device", 1]]) {
      const job = await capture("region", output);
      await selectRegion(job, { left: 0, top: 0, right: 800, bottom: 1800 });
      await waitFor(s => s.state === "loading");
      await panel.waitFor({ state: "visible" });
      assert.equal(await panel.locator("#cancel").isVisible(), true);
      const result = await waitFor(s => !s.busy);
      assert.equal(result.state, "complete", JSON.stringify(result));
      assert.equal(result.parts, 1);
      const png = PNG.sync.read(await readFile(result.result.filename));
      assert.equal(png.width, 800 * ratio); assert.equal(png.height, 1800 * ratio);
      // Constant blue channel across the full image catches status-panel contamination,
      // blank seams and duplicated overlays, including the bottom-right panel area.
      for (let i = 2; i < png.data.length; i += 4) assert.equal(png.data[i], 97);
      assert.ok((await panel.locator("section").innerText()).includes(result.result.filename));
      assert.ok((await panel.locator("section").innerText()).includes(`${png.width} × ${png.height}`));
      assert.equal(await panel.locator("#show").isVisible(), true);
      if (output === "auto") await page.screenshot({ path: join(root, "completed-panel.png") });
      await worker.evaluate(() => { globalThis.shownDownload = null; chrome.downloads.show = id => { globalThis.shownDownload = id; }; });
      await panel.locator("#show").click();
      // A completed click does not await its async extension message handler.
      assert.equal(await worker.evaluate(async expected => {
        const start = Date.now();
        while (globalThis.shownDownload !== expected && Date.now() - start < 2000) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return globalThis.shownDownload;
      }, result.result.downloadId), result.result.downloadId);
      console.log("PASS output/UI/path/show", output, png.width, png.height);
    }
    await capture("full");
    await waitFor(s => s.state === "loading");
    await panel.locator("#cancel").click();
    assert.equal((await waitFor(s => !s.busy)).state, "cancelled");
    assert.ok((await panel.locator("section").innerText()).includes("取消"));
    await panel.locator("#close").click();
    assert.equal(await panel.count(), 0);
    console.log("PASS page-panel cancel and persistent completion close");
    await page.evaluate(() => { document.querySelector("canvas").style.width = "1500px"; document.querySelector("canvas").style.height = "26000px"; });
    await capture("full", "css");
    const cssLong = await waitFor(s => !s.busy);
    assert.equal(cssLong.state, "complete", JSON.stringify(cssLong));
    assert.equal(cssLong.parts, 2);
    assert.equal(cssLong.results.length, 2);
    assert.notEqual(cssLong.results[0].filename, cssLong.results[1].filename);
    const cssPNGs = await Promise.all(cssLong.results.map(async item => PNG.sync.read(await readFile(item.filename))));
    assert.deepEqual(cssPNGs.map(png => [png.width, png.height]), [[900, 16384], [900, 9616]]);
    assert.equal(cssPNGs.reduce((sum, png) => sum + png.height, 0), 26000);

    await capture("full", "auto");
    const balanced = await waitFor(s => !s.busy);
    assert.equal(balanced.state, "complete", JSON.stringify(balanced));
    assert.equal(balanced.parts, 2);
    assert.equal(balanced.results.length, 2);
    const autoPNGs = await Promise.all(balanced.results.map(async item => PNG.sync.read(await readFile(item.filename))));
    assert.deepEqual(autoPNGs.map(png => [png.width, png.height]), [[810, 16384], [810, 7016]]);
    assert.equal(autoPNGs.reduce((sum, png) => sum + png.height, 0), 23400);
    const panelText = await panel.locator("section").innerText();
    assert.ok(panelText.includes(balanced.results[0].filename));
    assert.ok(panelText.includes(balanced.results[1].filename));

    await page.evaluate(() => { document.querySelector("canvas").style.height = "1000000px"; });
    await capture("full");
    const extreme = await waitFor(s => !s.busy);
    assert.equal(extreme.state, "failed"); assert.match(extreme.message, /需要 .* 张图片|缩小区域/);
    assert.equal(extreme.metrics.captures, 0);
    console.log("PASS balanced Auto and CSS multi-part output with ordered files and extreme part-count guard");
  } else if (process.env.COMPLEX_ONLY) {
    await testComplexPage({ page, worker, message, waitFor, capture, selectRegion, root, PNG });
  } else if (process.env.NATIVE_DPR) {
    const retina = await capture("region", "device");
    await selectRegion(retina, { left: 200, top: 100, right: 700, bottom: 1700 });
    const result = await waitFor(s => !s.busy);
    assert.equal(result.state, "complete", JSON.stringify(result));
    const [file] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
    const png = PNG.sync.read(await readFile(file.filename));
    assert.equal(png.width, 500 * Number(process.env.NATIVE_DPR));
    assert.equal(png.height, 1600 * Number(process.env.NATIVE_DPR));
    for (let y = 0; y < png.height; y++) assert.equal(png.data[(y * png.width + 400) * 4 + 2], 97);
    console.log("PASS native device scale", process.env.NATIVE_DPR, png.width, png.height);
    assert.equal((await message({ type: "SHOW", id: result.id })).ok, true);
    console.log("PASS real Chrome downloads.show API");
    for (const [output, ratio] of [["auto", .9], ["css", 1], ["75", .75], ["50", .5]]) {
      const job = await capture("region", output);
      await selectRegion(job, { left: 200, top: 100, right: 700, bottom: 1700 });
      const done = await waitFor(s => !s.busy);
      assert.equal(done.state, "complete", JSON.stringify(done));
      const image = PNG.sync.read(await readFile(done.result.filename));
      assert.equal(image.width, 500 * ratio); assert.equal(image.height, 1600 * ratio);
      for (let y = 0; y < image.height; y++) assert.equal(image.data[(y * image.width + 10) * 4 + 2], 97);
      console.log("PASS native Retina CSS output", output, image.width, image.height);
    }
    await page.evaluate(() => { document.querySelector("canvas").style.width = "1500px"; document.querySelector("canvas").style.height = "1800px"; });
    for (const output of ["css", "device"]) {
      await capture("full", output);
      const result = await waitFor(s => !s.busy);
      assert.equal(result.state, "complete", JSON.stringify(result));
      const png = PNG.sync.read(await readFile(result.result.filename));
      const ratio = output === "device" ? Number(process.env.NATIVE_DPR) : 1;
      assert.equal(png.width, 900 * ratio); assert.equal(png.height, 1800 * ratio);
      for (let y = 0; y < png.height; y++) assert.equal(png.data[(y * png.width + 100) * 4 + 2], 97);
      assert.ok(result.diagnostics.visual.visualChecks > 0);
      console.log("PASS native Retina Full Page visual", output, png.width, png.height);
    }
  } else if (process.env.SITE_URL) {
    await page.screenshot({ path: join(root, "page-before.png") });
    console.log("PAGE", await page.title(), await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })));
    const modes = process.env.REGION_EDGES ? ["full", "region"] : ["full"];
    for (const mode of modes) {
      const job = await capture(mode);
      if (mode === "region") {
        await page.screenshot({ path: join(root, "selection.png") });
        await selectRegion(job, JSON.parse(process.env.REGION_EDGES));
      }
      let previous = "";
      const result = await waitFor(s => {
        if (s.state !== previous) { console.log(mode, s.message); previous = s.state; }
        return !s.busy;
      });
      const items = await worker.evaluate(() => chrome.downloads.search({}));
      await writeFile(join(root, `${mode}-result.json`), JSON.stringify({ url: page.url(), result, items }, null, 2));
      assert.equal(result.state, "complete", JSON.stringify(result));
      console.log("PASS", mode, JSON.stringify(result));
    }
  } else {
  await page.evaluate(() => scrollTo({ left: 123, top: 321, behavior: "instant" }));
  if (!process.env.EXTRA_ONLY) {
  await capture("full", "css");
  const full = await waitFor(s => !s.busy);
  assert.equal(full.state, "complete", JSON.stringify(full));
  assert.equal(full.parts, 1); console.log("FAST", JSON.stringify(full));
  const items = await worker.evaluate(() => chrome.downloads.search({}));
  // Playwright may assign GUID filenames, so order by download initiation.
  const files = items.sort((a, b) => a.startTime.localeCompare(b.startTime));
  let row = 0;
  for (const file of files) {
    const png = PNG.sync.read(await readFile(file.filename));
    assert.equal(png.width, 900);
    for (let y = 0; y < png.height; y++, row++) {
      for (const x of [0, 450, 899]) {
        const offset = (y * png.width + x) * 4;
        assert.deepEqual([...png.data.subarray(offset, offset + 3)], [row % 251, Math.floor(row / 251), 97], `row=${row} x=${x}`);
      }
    }
  }
  assert.equal(row, 10337);
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.getElementById("fixed").style.visibility]), [123, 321, ""]);
  console.log("PASS full: current 900px horizontal slice, exact vertical rows, bottom and page restoration");

  const regionJob = await capture("region", "css");
  // Base regression verifies the Phase 2.3 coordinate contract directly:
  // horizontal edges are browser-viewport x; vertical edges are content y.
  await selectRegion(regionJob, { left: 107, top: 713, right: 870, bottom: 2869 });
  const region = await waitFor(s => !s.busy);
  assert.equal(region.state, "complete", JSON.stringify(region));
  const [regionFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  const png = PNG.sync.read(await readFile(regionFile.filename));
  assert.equal(png.width, 763); assert.equal(png.height, 2156);
  for (let y = 0; y < png.height; y++) {
    const offset = y * png.width * 4;
    assert.deepEqual([...png.data.subarray(offset, offset + 3)], [(y + 713) % 251, Math.floor((y + 713) / 251), 97]);
  }
  console.log("PASS region: exact selected dimensions and every row");

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1.25);
  });
  const zoomJob = await capture("region", "device");
  const zoomViewportWidth = await page.evaluate(() => innerWidth);
  assert.ok(zoomViewportWidth >= 640, `zoomed viewport too narrow: ${zoomViewportWidth}`);
  const zoomLeft = Math.floor((zoomViewportWidth - 640) / 2);
  await selectRegion(zoomJob, { left: zoomLeft, top: 100, right: zoomLeft + 640, bottom: 2260 });
  const zoomResult = await waitFor(s => !s.busy);
  assert.equal(zoomResult.state, "complete", JSON.stringify(zoomResult));
  const [zoomFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  const zoomPNG = PNG.sync.read(await readFile(zoomFile.filename));
  assert.equal(zoomPNG.width, 800); assert.equal(zoomPNG.height, 2700);
  for (let y = 0; y < zoomPNG.height; y++) {
    const offset = (y * zoomPNG.width + 400) * 4;
    // Blue is constant across the fixture, detecting empty/seam rows even at fractional zoom.
    assert.equal(zoomPNG.data[offset + 2], 97, `zoom row ${y}`);
  }
  console.log("PASS browser zoom 125%: dimensions, horizontal tiles and no blank rows");
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1);
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
  const retinaJob = await capture("region", "css");
  await selectRegion(retinaJob, { left: 200, top: 100, right: 700, bottom: 1700 });
  const retinaResult = await waitFor(s => !s.busy);
  assert.equal(retinaResult.state, "complete", JSON.stringify(retinaResult));
  const [retinaFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  const retinaPNG = PNG.sync.read(await readFile(retinaFile.filename));
  // CDP's emulated DPR changes devicePixelRatio but not captureVisibleTab's
  // native backing scale. Correct output must use bitmap geometry, not DPR.
  assert.equal(retinaPNG.width, 500); assert.equal(retinaPNG.height, 1600);
  for (let y = 0; y < retinaPNG.height; y++) assert.equal(retinaPNG.data[(y * retinaPNG.width + 250) * 4 + 2], 97);
  console.log("PASS emulated DPR mismatch: native bitmap dimensions and no blank rows");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  }

  const cancelJob = await capture("full");
  await waitFor(s => s.state === "loading");
  assert.equal((await message({ type: "START", mode: "full" })).ok, false);
  assert.equal((await message({ type: "CANCEL", id: "old-session" })).ok, false);
  await page.keyboard.press("Escape");
  const cancelled = await waitFor(s => !s.busy);
  assert.equal(cancelled.state, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.id, cancelJob.id);
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [123, 321]);
  const newJob = await capture("region");
  assert.equal((await message({ type: "CANCEL", id: cancelJob.id })).ok, false);
  assert.equal((await message({ type: "STATUS" })).id, newJob.id);
  await message({ type: "CANCEL", id: newJob.id });
  await waitFor(s => !s.busy);
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))).length, 0);
  console.log("PASS cancellation, overlap rejection, stale-message protection, restart and offscreen cleanup");

  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    canvas.style.width = "1500px";
    canvas.style.height = "1800px";
    function grow() {
      if (scrollY > 500) { canvas.style.height = "2800px"; removeEventListener("scroll", grow); }
    }
    addEventListener("scroll", grow);
  });
  await capture("full", "css");
  const warmedGrowth = await waitFor(s => !s.busy);
  assert.equal(warmedGrowth.state, "complete", JSON.stringify(warmedGrowth));
  assert.ok(warmedGrowth.diagnostics.warmup.growthEvents >= 1, JSON.stringify(warmedGrowth.diagnostics.warmup));
  let [lazyFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  assert.equal(PNG.sync.read(await readFile(lazyFile.filename)).height, 2800);
  await capture("full", "css");
  const stableGrowth = await waitFor(s => !s.busy);
  assert.equal(stableGrowth.state, "complete", JSON.stringify(stableGrowth));
  [lazyFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  assert.equal(PNG.sync.read(await readFile(lazyFile.filename)).height, 2800);
  console.log("PASS bounded warmup absorbs initial growth; stable recapture includes final bottom");

  await capture("full");
  await waitFor(s => s.state === "capturing");
  const { targetInfos: workerTargets } = await browserCDP.send("Target.getTargets");
  const workerTarget = workerTargets.find(target => target.type === "service_worker" && target.url === worker.url());
  await browserCDP.send("Target.closeTarget", { targetId: workerTarget.targetId });
  const interrupted = await waitFor(s => !s.busy);
  assert.equal(interrupted.state, "failed", JSON.stringify(interrupted));
  assert.match(interrupted.message, /中断/);
  worker = context.serviceWorkers().find(item => item.url().includes(id)) || await context.waitForEvent("serviceworker");
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.getElementById("fixed").style.visibility]), [123, 321, ""]);
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))).length, 0);
  console.log("PASS service-worker termination: persisted status, page and offscreen recovered");
  await browserCDP.send("Browser.setDownloadBehavior", { behavior: "deny" });
  const deniedJob = await capture("region");
  await selectRegion(deniedJob, { left: 200, top: 100, right: 700, bottom: 1000 });
  const denied = await waitFor(s => !s.busy);
  assert.equal(denied.state, "failed", JSON.stringify(denied));
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.getElementById("fixed").style.visibility]), [123, 321, ""]);
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))).length, 0);
  console.log("PASS denied download: failure surfaced and page/blob resources recovered");
  }
} finally {
  await context.close();
  server.close();
}
