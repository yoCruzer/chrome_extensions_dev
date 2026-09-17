// Optional integration test: NODE_PATH must expose playwright and pngjs.
// All browser profiles and downloads live in /tmp. The production manifest is unchanged.
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
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
const nestedFixture = process.env.NESTED_ONLY ? await readFile(resolve(extension, "tests/fixtures/test-nested-page.html"), "utf8") : null;
const adaptiveFixture = process.env.ADAPTIVE_ONLY ? await readFile(resolve(extension, "tests/fixtures/test-adaptive-page.html"), "utf8") : null;
const server = createServer((req, res) => {
  if (req.url.startsWith('/lazy.svg')) {
    res.setHeader('Content-Type','image/svg+xml');
    setTimeout(()=>res.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="20"><rect width="900" height="20" fill="#e000e0"/></svg>'),600);
    return;
  } res.setHeader("Content-Type", "text/html"); res.end(adaptiveFixture || nestedFixture || reliabilityFixture || (process.env.DYNAMIC_ONLY ? dynamicFixture : process.env.COMPLEX_ONLY ? complexFixture : fixture)); });
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
    while (Date.now() - start < 180_000) {
      const state = await message({ type: "STATUS" });
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Timed out waiting for capture state");
  };
  const capture = async (mode, output = "auto") => {
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
    const result = await message({ type: "START", mode, output });
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
  if (process.env.ADAPTIVE_ONLY) {
    await testAdaptive({ page, worker, message, waitFor, capture, PNG });
  } else if (process.env.NESTED_ONLY) {
    await testNested({ page, worker, message, waitFor, capture, PNG, browserCDP });
  } else if (process.env.RELIABILITY_ONLY) {
    await testReliability({ page, worker, message, waitFor, capture, PNG, kind:process.env.RELIABILITY_ONLY });
  } else if (process.env.DYNAMIC_ONLY) {
    await testDynamicRegion({ page, worker, message, waitFor, capture, selectRegion, PNG });
  } else if (process.env.OUTPUT_ONLY) {
    const panel = page.locator("#long-screenshot-v2-progress");
    for (const [output, ratio] of [["auto", 1], ["css", 1], ["75", .75], ["50", .5], ["device", 1]]) {
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
      assert.equal(await worker.evaluate(() => globalThis.shownDownload), result.result.downloadId);
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
    const oversized = await waitFor(s => !s.busy);
    assert.equal(oversized.state, "failed"); assert.match(oversized.message, /自动/);
    assert.equal(oversized.metrics.captures, 0);
    await capture("full", "auto");
    const reduced = await waitFor(s => !s.busy);
    assert.equal(reduced.state, "complete", JSON.stringify(reduced));
    assert.equal(reduced.parts, 1);
    const reducedPNG = PNG.sync.read(await readFile(reduced.result.filename));
    assert.ok(reducedPNG.width * reducedPNG.height <= 16000000);
    assert.equal(reducedPNG.height, 16384);
    for (let y = 0; y < reducedPNG.height; y++) assert.equal(reducedPNG.data[(y * reducedPNG.width + 10) * 4 + 2], 97);
    const bottom = ((reducedPNG.height - 1) * reducedPNG.width + 10) * 4;
    assert.ok(Math.abs(reducedPNG.data[bottom] - (10336 % 251)) <= 2);
    assert.equal(reducedPNG.data[bottom + 1], Math.floor(10336 / 251));
    await page.evaluate(() => { document.querySelector("canvas").style.height = "1000000px"; });
    await capture("full");
    const extreme = await waitFor(s => !s.busy);
    assert.equal(extreme.state, "failed"); assert.match(extreme.message, /缩小截图区域/);
    assert.equal(extreme.metrics.captures, 0);
    console.log("PASS Auto reduction, single PNG, bottom, fixed-size and extreme preflight rejection");
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
    for (const [output, ratio] of [["auto", 1], ["css", 1], ["75", .75], ["50", .5]]) {
      const job = await capture("region", output);
      await selectRegion(job, { left: 200, top: 100, right: 700, bottom: 1700 });
      const done = await waitFor(s => !s.busy);
      assert.equal(done.state, "complete", JSON.stringify(done));
      const image = PNG.sync.read(await readFile(done.result.filename));
      assert.equal(image.width, 500 * ratio); assert.equal(image.height, 1600 * ratio);
      for (let y = 0; y < image.height; y++) assert.equal(image.data[(y * image.width + 10) * 4 + 2], 97);
      console.log("PASS native Retina CSS output", output, image.width, image.height);
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
  await capture("full");
  const full = await waitFor(s => !s.busy);
  assert.equal(full.state, "complete", JSON.stringify(full));
  assert.equal(full.parts, 1); console.log("FAST", JSON.stringify(full));
  const items = await worker.evaluate(() => chrome.downloads.search({}));
  // Playwright may assign GUID filenames, so order by download initiation.
  const files = items.sort((a, b) => a.startTime.localeCompare(b.startTime));
  let row = 0;
  for (const file of files) {
    const png = PNG.sync.read(await readFile(file.filename));
    assert.equal(png.width, 1500);
    for (let y = 0; y < png.height; y++, row++) {
      for (const x of [0, 800, 1499]) {
        const offset = (y * png.width + x) * 4;
        assert.deepEqual([...png.data.subarray(offset, offset + 3)], [row % 251, Math.floor(row / 251), 97], `row=${row} x=${x}`);
      }
    }
  }
  assert.equal(row, 10337);
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.getElementById("fixed").style.visibility]), [123, 321, ""]);
  console.log("PASS full: exact rows across horizontal/vertical tiles in one PNG, bottom and page restoration");

  await capture("region");
  await page.screenshot({ path: join(root, "selection.png") });
  // Exercise both picker buttons across a scroll, including the closed Shadow DOM UI.
  await page.mouse.click(642, 245);
  await page.mouse.click(107, 392);
  await page.evaluate(() => scrollTo({ left: 0, top: 2500, behavior: "instant" }));
  await page.mouse.click(730, 245);
  await page.mouse.click(870, 369);
  await page.mouse.click(811, 245);
  const region = await waitFor(s => !s.busy);
  assert.equal(region.state, "complete", JSON.stringify(region));
  const [regionFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  const png = PNG.sync.read(await readFile(regionFile.filename));
  assert.equal(png.width, 640); assert.equal(png.height, 2156);
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
  await selectRegion(zoomJob, { left: 200, top: 100, right: 840, bottom: 2260 });
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
  const retinaJob = await capture("region");
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
  await capture("full");
  const lazy = await waitFor(s => !s.busy);
  assert.equal(lazy.state, "complete", JSON.stringify(lazy));
  const [lazyFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
  assert.equal(PNG.sync.read(await readFile(lazyFile.filename)).height, 2800);
  console.log("PASS lazy layout growth: 1800 → 2800 CSS pixels, final bottom included");

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
