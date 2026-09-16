import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { outputGeometry, drawGeometry } from "../capture/geometry.js";

const source = (await readFile(new URL("../offscreen.js", import.meta.url), "utf8")).replace(/^import .*;\n/, "");
function harness() {
  let listener, pagehide, nextURL = 0, failDecode = false, failEncode = false;
  const canvases = [], bitmaps = [], urls = new Set();
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { if (failEncode) throw new Error("encode failed"); return {}; }
  }
  vm.runInNewContext(source, {
    outputGeometry, drawGeometry, OffscreenCanvas: Canvas,
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
  return { canvases, bitmaps, urls, pagehide: () => pagehide(),
    failDecode: () => { failDecode = true; }, failEncode: () => { failEncode = true; },
    send: (type, id = "a", payload = {}) => new Promise(resolve => listener({ target: "offscreen", type, id, ...payload }, { id: "test" }, resolve)) };
}
const open = h => h.send("OPEN", "a", { region: { x: 0, y: 0, width: 800, height: 1200 }, view: { innerWidth: 800, innerHeight: 600 }, dataUrl: "data:" });

test("export drops canvas, release revokes blob, final release permits a fresh session", async () => {
  const h = harness();
  assert.equal((await open(h)).ok, true);
  for (const start of [0, 600]) {
    assert.equal((await h.send("PART", "a", { start, height: 600 })).ok, true);
    const result = await h.send("EXPORT");
    assert.equal(result.ok, true);
    assert.equal(h.canvases.at(-1).width, 1);
    assert.equal(h.urls.size, 1);
    assert.equal((await h.send("RELEASE", "a", { final: start === 600 })).ok, true);
    assert.equal(h.urls.size, 0);
  }
  assert.equal((await h.send("PART", "a", { start: 0, height: 600 })).ok, false);
  assert.equal((await open(h)).ok, true);
  assert.ok(h.bitmaps.every(bitmap => bitmap.closed));
});

test("stale frames, release, close and open cannot tear down another task", async () => {
  const h = harness();
  await open(h);
  for (const type of ["FRAME", "RELEASE", "OPEN"]) assert.equal((await h.send(type, "old")).ok, false);
  assert.equal((await h.send("CLOSE", "old")).ok, true);
  assert.equal((await h.send("PART", "a", { start: 0, height: 600 })).ok, true);
  assert.equal((await h.send("EXPORT")).ok, true);
  assert.equal((await h.send("CLOSE")).ok, true);
  assert.equal(h.urls.size, 0);
  assert.equal((await open(h)).ok, true);
});

for (const failure of ["decode", "encode", "pagehide"]) {
  test(`${failure} clears resources and session`, async () => {
    const h = harness();
    await open(h);
    await h.send("PART", "a", { start: 0, height: 600 });
    if (failure === "decode") {
      h.failDecode();
      assert.equal((await h.send("FRAME", "a", { dataUrl: "data:" })).ok, false);
    } else if (failure === "encode") {
      h.failEncode();
      assert.equal((await h.send("EXPORT")).ok, false);
    } else {
      await h.send("EXPORT");
      h.pagehide();
    }
    assert.equal(h.canvases[0].width, 1);
    assert.equal(h.urls.size, 0);
    assert.equal((await h.send("PART", "a", { start: 0, height: 600 })).ok, false);
  });
}

test("queued export and cleanup finish before the next task opens", async () => {
  const h = harness();
  await open(h);
  await h.send("PART", "a", { start: 0, height: 600 });
  const results = await Promise.all([
    h.send("EXPORT"), h.send("CLOSE"),
    h.send("OPEN", "b", { region: { x: 0, y: 0, width: 800, height: 600 }, view: { innerWidth: 800, innerHeight: 600 }, dataUrl: "data:" }),
    h.send("FRAME", "a", { dataUrl: "data:" }),
    h.send("PART", "b", { start: 0, height: 600 })
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, true, true, false, true]);
  assert.equal(h.urls.size, 0);
  assert.ok(h.bitmaps.every(bitmap => bitmap.closed));
});

test("failure after export revokes its pending URL and permits restart", async () => {
  const h = harness();
  await open(h);
  await h.send("PART", "a", { start: 0, height: 600 });
  await h.send("EXPORT");
  assert.equal(h.urls.size, 1);
  assert.equal((await h.send("FRAME", "a", { dataUrl: "data:" })).ok, false);
  assert.equal(h.urls.size, 0);
  assert.equal((await open(h)).ok, true);
});
