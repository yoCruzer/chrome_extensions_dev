import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { outputGeometry, drawGeometry } from "../capture/geometry.js";
import { assessBottomTail } from "../capture/bottom-tail.js";
import { VISUAL, overlapCSS } from "../capture/visual.js";
import { robustPlacement, matchVertical } from "../capture/visual.js";
import { bottomTail } from "../capture/bottom-tail.js";

const source = (await readFile(new URL("../offscreen.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");

function harness() {
  let listener, pagehide, nextURL = 0, failDecode = false, failEncode = false;
  const canvases = [], bitmaps = [], urls = new Set(), draws = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; this.id = canvases.length; canvases.push(this); }
    getContext() { return { drawImage: (...args) => draws.push({ canvas: this.id, args }) }; }
    async convertToBlob() { if (failEncode) throw new Error("encode failed"); return { width: this.width, height: this.height }; }
  }
  vm.runInNewContext(source, {
    outputGeometry, drawGeometry, assessBottomTail, bottomTail, VISUAL, overlapCSS, robustPlacement, matchVertical, OffscreenCanvas: Canvas,
    chrome: { runtime: { id: "test", onMessage: { addListener(fn) { listener = fn; } } } },
    addEventListener(type, fn) { if (type === "pagehide") pagehide = fn; },
    URL: { createObjectURL() { const url = `blob:${++nextURL}`; urls.add(url); return url; }, revokeObjectURL(url) { urls.delete(url); } },
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => {
      if (failDecode) throw new Error("decode failed");
      const bitmap = { width: 800, height: 600, closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap); return bitmap;
    }
  });
  return {
    canvases, bitmaps, urls, draws, pagehide: () => pagehide(),
    failDecode: () => { failDecode = true; }, failEncode: () => { failEncode = true; },
    send: (type, id = "a", payload = {}) => new Promise(resolve =>
      listener({ target: "offscreen", type, id, ...payload }, { id: "test" }, resolve))
  };
}

const open = (h, height = 1200, output = "auto") => h.send("OPEN", "a", {
  region: { x: 0, y: 0, width: 800, height },
  view: { x: 0, y: 0, innerWidth: 800, innerHeight: 600, clientWidth: 800, clientHeight: 600 },
  dataUrl: "data:", output
});

async function drawRegion(h, height) {
  for (let y = 0; y < height; y += 600) {
    const bottom = Math.min(height, y + 600);
    const result = await h.send("FRAME", "a", {
      view: { x: 0, y, innerWidth: 800, innerHeight: 600 },
      rect: { x: 0, y, right: 800, bottom },
      dataUrl: "data:"
    });
    assert.equal(result.ok, true);
  }
}

test("rolling renderer splits a long output into ordered bounded parts without losing total height", async () => {
  const h = harness();
  const opened = await open(h, 22000);
  assert.equal(opened.ok, true);
  assert.equal(opened.width, 720);
  assert.equal(opened.height, 19800);
  assert.equal(opened.partCount, 2);
  assert.equal((await h.send("PART", "a", { start: 0, height: opened.partHeight })).ok, true);
  await drawRegion(h, 22000);
  const exported = await h.send("EXPORT");
  assert.equal(exported.ok, true);
  assert.deepEqual(exported.parts.map(p => [p.start, p.width, p.height]), [
    [0, 720, 16384],
    [16384, 720, 3416]
  ]);
  assert.equal(exported.parts.reduce((sum, part) => sum + part.height, 0), 19800);
  assert.equal(h.urls.size, 2);
  assert.ok(h.draws.length > Math.ceil(22000 / 600), "boundary-crossing frames must be split");
  assert.equal((await h.send("RELEASE", "a", { final: true })).ok, true);
  assert.equal(h.urls.size, 0);
  assert.ok(h.bitmaps.every(bitmap => bitmap.closed));
});

test("dynamic extension preserves the selected output scale and only increases total height/part count", async () => {
  const h = harness();
  const opened = await open(h, 12000);
  assert.equal(opened.scaleX, 0.9); assert.equal(opened.partCount, 1);
  assert.equal((await h.send("PART", "a", { start: 0, height: opened.partHeight })).ok, true);
  const extended = await h.send("EXTEND", "a", { region: { x: 0, y: 0, width: 800, height: 26000 } });
  assert.equal(extended.ok, true);
  assert.equal(extended.scaleX, 0.9);
  assert.equal(extended.height, 23400);
  assert.equal(extended.partCount, 2);
  assert.equal(extended.partHeight, opened.partHeight);
  await h.send("CLOSE", "a");
});

test("stale messages cannot tear down the active rolling session", async () => {
  const h = harness();
  const opened = await open(h);
  assert.equal((await h.send("CLOSE", "old")).ok, true);
  assert.equal((await h.send("PART", "old", { start: 0, height: opened.partHeight })).ok, false);
  assert.equal((await h.send("PART", "a", { start: 0, height: opened.partHeight })).ok, true);
  await drawRegion(h, 1200);
  assert.equal((await h.send("EXPORT")).ok, true);
  assert.ok(h.urls.size > 0);
  assert.equal((await h.send("CLOSE", "a")).ok, true);
  assert.equal(h.urls.size, 0);
});

test("encode failure and pagehide both release canvases/URLs and permit a new session", async () => {
  for (const failure of ["encode", "pagehide"]) {
    const h = harness();
    const opened = await open(h);
    await h.send("PART", "a", { start: 0, height: opened.partHeight });
    await drawRegion(h, 1200);
    if (failure === "encode") {
      h.failEncode();
      assert.equal((await h.send("EXPORT")).ok, false);
    } else {
      assert.equal((await h.send("EXPORT")).ok, true);
      assert.ok(h.urls.size > 0);
      h.pagehide();
    }
    assert.equal(h.urls.size, 0);
    assert.ok(h.canvases.every(canvas => canvas.width === 1));
    assert.equal((await open(h)).ok, true);
  }
});
