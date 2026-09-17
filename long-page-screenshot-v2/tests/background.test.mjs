import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { regionFromEdges, outputGeometry, sameViewport } from "../capture/geometry.js";
import { visibleTile, checkHeight, MAX_STEPS } from "../capture/planner.js";
const source = (await readFile(new URL("../background.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");

test("startup close failure does not poison ready; new job completes and reveals actual download", async () => {
  let listener, closes = 0, contexts = [{}], saved, shown, hidden = false;
  const events = [], view = { x: 0, y: 0, width: 800, height: 600, innerWidth: 800, innerHeight: 600, clientWidth: 800, clientHeight: 600, dpr: 1, visualScale: 1 };
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: "test", getURL: path => `extension://${path}`, getContexts: async () => contexts,
      onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async m => {
        events.push(m.type);
        if (m.type === "OPEN") return { ok: true, ...outputGeometry(m.region, m.view, { width: 800, height: 600 }, m.output) };
        return { ok: true, url: "blob:test" };
      } },
    storage: { session: { get: async () => ({}), set: async data => { saved = data.status; } } },
    offscreen: { closeDocument: async () => { if (++closes === 1) throw new Error("transient close"); contexts = []; }, createDocument: async () => { contexts = [{}]; } },
    scripting: { executeScript: async () => {} },
    tabs: { query: async () => [{ id: 1, windowId: 2, url: "https://fixture.test", title: "Fixture" }],
      sendMessage: async (id, m) => { events.push(m.type); if (m.type === "HIDE_UI") hidden = true; if (m.type === "SHOW_UI") hidden = false; return { ok: true, ...view }; },
      captureVisibleTab: async () => { assert.equal(hidden, true); return "data:"; }, onActivated: event, onRemoved: event, onUpdated: event },
    downloads: { download: async options => { assert.doesNotMatch(options.filename, /part-/); return 8; },
      search: async () => [{ id: 8, state: "complete", filename: "/custom/chosen/result.png", fileSize: 42 }], cancel: async () => {}, show: async id => { shown = id; } }
  };
  vm.runInNewContext(source, { chrome, crypto: { randomUUID: () => "new" }, regionFromEdges, outputGeometry, sameViewport, visibleTile, checkHeight, MAX_STEPS, setTimeout, setInterval, clearInterval });
  const send = m => new Promise(resolve => listener({ target: "background", ...m }, { id: "test", url: "extension://popup.html" }, resolve));
  assert.equal((await send({ type: "STATUS" })).ok, true);
  assert.equal((await send({ type: "START", mode: "full" })).ok, true);
  for (let i = 0; i < 100 && saved?.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.state, "complete");
  assert.equal(saved.result.filename, "/custom/chosen/result.png");
  assert.equal(saved.result.width, 800);
  assert.equal(saved.parts, 1);
  assert.ok(closes >= 3);
  assert.ok(events.includes("FINISH"));
  assert.equal((await send({ type: "CANCEL", id: "old" })).ok, false);
  assert.equal((await send({ type: "SHOW", id: "new" })).ok, true);
  assert.equal(shown, 8);
  assert.equal((await send({ type: "SHOW", id: "old" })).ok, false);
});
