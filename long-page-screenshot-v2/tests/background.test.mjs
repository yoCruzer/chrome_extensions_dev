import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { regionFromEdges, verticalRegionFromViewportEdges, outputGeometry, sameViewport } from "../capture/geometry.js";
import { visibleTile, adaptiveEnd, MAX_STEPS } from "../capture/planner.js";
import { assessBottomTail, bottomTail, TERMINAL_GEOMETRY_EPSILON, terminalNear } from "../capture/bottom-tail.js";
import { VISUAL, overlapCSS } from "../capture/visual.js";
const source = (await readFile(new URL("../background.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");

test("startup close failure does not poison ready; new job completes and reveals actual download", async () => {
  let listener, closes = 0, contexts = [{}], saved, shown, hidden = false, openedScale;
  const events = [], view = { x: 0, y: 0, width: 800, height: 600, innerWidth: 800, innerHeight: 600, clientWidth: 800, clientHeight: 600, dpr: 1, visualScale: 1 };
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: "test", getURL: path => `extension://${path}`, getContexts: async () => contexts,
      onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async m => {
        events.push(m.type);
        if (m.type === "OPEN") { openedScale = outputGeometry(m.region, m.view, { width: 800, height: 600 }, m.output); return { ok: true, ...openedScale }; }
        if (m.type === "FULL_FRAME") return { ok: true, accepted: true, canonicalY: 0, novelTop: 0, end: 600, right: 800 };
        if (m.type === "FULL_FINALIZE") return { ok: true, ...openedScale };
        if (m.type === "EXPORT") return { ok: true, parts: [{ url: "blob:test", width: openedScale.width, height: openedScale.height, index: 0, count: 1 }] };
        return { ok: true };
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
  vm.runInNewContext(source, { chrome, crypto: { randomUUID: () => "new" }, regionFromEdges, verticalRegionFromViewportEdges, outputGeometry, sameViewport, visibleTile, adaptiveEnd, MAX_STEPS, VISUAL, overlapCSS, assessBottomTail, bottomTail, TERMINAL_GEOMETRY_EPSILON, terminalNear, setTimeout, setInterval, clearInterval });
  const send = m => new Promise(resolve => listener({ target: "background", ...m }, { id: "test", url: "extension://popup.html" }, resolve));
  assert.equal((await send({ type: "STATUS" })).ok, true);
  assert.equal((await send({ type: "START", mode: "full" })).ok, true);
  for (let i = 0; i < 300 && saved?.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.state, "complete");
  assert.equal(saved.result.filename, "/custom/chosen/result.png");
  assert.equal(saved.result.width, 720);
  assert.equal(saved.parts, 1);
  assert.equal(saved.results.length, 1);
  assert.ok(closes >= 3);
  assert.ok(events.includes("FINISH"));
  assert.equal((await send({ type: "CANCEL", id: "old" })).ok, false);
  assert.equal((await send({ type: "SHOW", id: "new" })).ok, true);
  assert.equal(shown, 8);
  assert.equal((await send({ type: "SHOW", id: "old" })).ok, false);
});

const validation = source.slice(source.indexOf('function validateView'), source.indexOf('async function scroll'));
const validationContext = { sameViewport, regionFromEdges,
  near: (a,b,epsilon=0.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= epsilon };
vm.runInNewContext(validation, validationContext);

test('Region tolerates unrelated document dimensions but rejects only actual environment or region geometry changes', () => {
  const page = { width: 900, height: 4000, innerWidth: 900, innerHeight: 700, clientWidth: 900, clientHeight: 700, dpr: 1, visualScale: 1 };
  const region = { x: 80, y: 40, width: 500, height: 2400 };
  const s = { mode: 'region', tab:{id:1}, environment:{...page,tabId:1,tabZoom:1}, viewport: page, region, scope: 'stable-content' };
  const moved = { ...page, width: 1400, height: 9000, region: { ...region, y: 220 }, scope: s.scope };
  assert.doesNotThrow(() => validationContext.validateView(s, moved));
  assert.doesNotThrow(() => validationContext.validateView(s, { ...moved, region: { ...moved.region, width: region.width + 0.4, height: region.height - 0.4 } }));
  assert.doesNotThrow(() => validationContext.validateView(s, { ...moved, dpr: 2, clientWidth:880, clientHeight:680 }));
  assert.doesNotThrow(() => validationContext.validateView(s, { ...moved, scope: 'replaced-content' }));
  for (const field of ['innerWidth','innerHeight','tabZoom','visualScale','tabId']) {
    assert.throws(() => validationContext.validateEnvironment(s, {...s.environment,[field]:s.environment[field]+1}), e => {
      assert.equal(e.reasonCode,'CAPTURE_ENV_CHANGED');
      assert.equal(e.diagnostics.delta.field,field);
      assert.equal(e.diagnostics.delta.expected,s.environment[field]);
      return true;
    });
  }
  assert.throws(() => validationContext.validateView(s, { ...moved, region: { ...region, height: 2500 } }), /所选区域尺寸发生明显变化/);
  assert.doesNotThrow(() => validationContext.validateView({ ...s, mode: 'full' }, moved));
});

test('rigid vertical translation rebases y while Region horizontal output stays viewport-fixed', () => {
  const region = { x: 0, y: 40, width: 800, height: 2400 };
  const s = { mode: 'region', region, regionCropLeft: 200 };
  const actual = { x: 480, y: 1620, clientWidth: 900, clientHeight: 700,
    region: { ...region, x: 60, y: 220 } };
  const normalized = validationContext.relativeView(s, actual);
  assert.equal(normalized.x, 0);
  assert.equal(normalized.y, 1440);
  assert.equal(normalized.cropLeft, 200);
  const tile = visibleTile(region, normalized, 0, 1440);
  assert.equal(tile.right, 800); assert.equal(tile.bottom, 2140);
  assert.equal(tile.y - normalized.y, (tile.y + 180) - actual.y);
});


test('Full Page warmup pre-scrolls bounded growth, returns to top, and records diagnostics', async () => {
  const warmupSource = source.slice(source.indexOf('const WARMUP_MAX_STEPS'), source.indexOf('function recoveryBacktrackCSS'));
  const moves = [];
  let grew = false;
  const context = {
    Date,
    check: () => {},
    scroll: async (s, x, y) => {
      moves.push({ x, y });
      assert.equal(x, 73);
      let height = grew ? 2500 : 2100;
      const clientHeight = 700;
      const maxY = height - clientHeight;
      const actualY = Math.min(maxY, y);
      if (!grew && actualY >= maxY) { grew = true; height = 2500; }
      return { x: 73, y: Math.min(height - clientHeight, y), width: 900, height, innerWidth: 900, innerHeight: 700,
        clientWidth: 900, clientHeight, dpr: 1, visualScale: 1 };
    }
  };
  vm.runInNewContext(warmupSource, context);
  const s = { mode: 'full', cancelled: false };
  const top = await context.warmupFull(s, { x: 73, y: 0, width: 900, height: 2100, innerWidth: 900, innerHeight: 700,
    clientWidth: 900, clientHeight: 700, dpr: 1, visualScale: 1 });
  assert.equal(top.y, 0);
  assert.equal(s.warming, false);
  assert.equal(s.warmup.completed, true);
  assert.equal(s.warmup.stopReason, 'bottom-stable');
  assert.equal(s.warmup.growthEvents, 1);
  assert.equal(s.warmup.maxObservedHeight, 2500);
  assert.ok(s.warmup.steps >= 3);
  assert.equal(moves.at(-1).y, 0);
  assert.ok(moves.every(move => move.x === 73));
  assert.equal(s.warmup.captureX, 73);
});

test('Full Page absorbs advisory pending-witness FRAME_MOVED and maximizes retained recovery context', async () => {
  const helperSource = source.slice(source.indexOf('function recoveryBacktrackCSS'), source.indexOf('async function capture(s, view)'));
  let calls = 0;
  const context = {
    VISUAL,
    scroll: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('pending witness moved'), { translation: true, reasonCode: 'FRAME_MOVED' });
      return { x: 0, y: 100 };
    }
  };
  vm.runInNewContext(helperSource, context);
  const s = { metrics: { frameRetries: 0 } };
  assert.equal((await context.scrollFullRecoverable(s, 0, 100)).y, 100);
  assert.equal(calls, 2);
  assert.equal(s.metrics.frameRetries, 1);
  assert.equal(context.recoveryBacktrackCSS(768), 256);
  assert.equal(768 - overlapCSS(768) - context.recoveryBacktrackCSS(768), 320);
  context.scroll = async () => { throw Object.assign(new Error('still moving'), { translation: true, reasonCode: 'FRAME_MOVED' }); };
  await assert.rejects(() => context.scrollFullRecoverable({ metrics: { frameRetries: 0 } }, 0, 100),
    error => error.reasonCode === 'FRAME_MOVED' && error.translation);
});

test('Full Page is vertical-only and preserves the current horizontal slice through recovery', async () => {
  const moves = [], frames = [];
  const view = { x: 123, y: 0, width: 1600, height: 1000, clientWidth: 800, clientHeight: 600 };
  const s = { full: { end: 1000 }, region: { x: 123, y: 0, width: 800, height: 1000 },
    metrics: { captures: 1 }, frames: 0, continuityPolicy: 'robust' };
  let rejects = 0;
  const context = { VISUAL, overlapCSS, assessBottomTail, bottomTail, TERMINAL_GEOMETRY_EPSILON, terminalNear, MAX_STEPS,
    recordBottomTailReject: () => {}, bottomQuiescence: async () => true,
    scrollFullRecoverable: async (s, x, y) => {
      assert.equal(x, 123); const current = { ...view, x, y: Math.min(400, y) }; moves.push(current); return current;
    },
    extendEnd: async () => {}, capture: async (s, view) => { s.metrics.captures++; return { view, dataUrl: 'data:' }; },
    status: async () => {}, request: async (s, target, type, m) => {
      if (type !== 'FULL_FRAME') return {};
      assert.equal(m.x, 123); assert.equal(m.firstColumn, true); frames.push(m);
      if (s.frames >= 1 && rejects < 2) { rejects++; return { accepted: false, visual: { result: 'low-information' } }; }
      return { accepted: true, canonicalY: m.view.y, novelTop: s.frames ? 600 : 0,
        end: Math.min(1000, m.view.y + 600), right: 923 };
    } };
  vm.runInNewContext(source.slice(source.indexOf('function recordVisual'), source.indexOf('async function saveImage')), context);
  await context.captureFull(s, view, 'data:');
  assert.equal(rejects, 2);
  assert.ok(frames.every(m => m.x === 123 && m.firstColumn));
  assert.ok(moves.every(m => m.x === 123));
  assert.equal(s.frames, 3);
  assert.equal(s.full.visual.visualFailures, 0);
});


test('download filename is UTF-8 byte bounded and retries with a timestamp-only safe fallback', async () => {
  const helperSource=source.slice(source.indexOf('function utf8CodePointBytes'),source.indexOf('async function run'));
  const attempts=[];
  const context={
    chrome:{downloads:{
      download:async options=>{attempts.push(options.filename);if(attempts.length===1)throw new Error('Invalid filename');return 9},
      search:async()=>[{id:9,state:'complete',filename:'/chosen/result.png',fileSize:123}]
    }},
    status:async()=>{},check:()=>{},delay:async()=>{}
  };
  vm.runInNewContext(helperSource,context);
  const chinese='测'.repeat(120)+'😀😀😀 / : * ? " < > |';
  const safe=context.suggestedFilename('2026-09-20T00-00-00-000Z',chinese);
  const basename=safe.split('/').at(-1);
  let bytes=0;for(const ch of basename)bytes+=context.utf8CodePointBytes(ch);
  assert.ok(bytes < 220, `basename bytes=${bytes}`);
  assert.doesNotMatch(safe, /[\\:*?"<>|]/);
  const s={tab:{title:chinese},stamp:'2026-09-20T00-00-00-000Z',metrics:{filenameFallbacks:0},parts:0};
  const saved=await context.saveImage(s,{url:'blob:test',width:1,height:1},0,1);
  assert.equal(attempts.length,2);
  assert.match(attempts[1],/LongScreenshot\/2026-09-20T00-00-00-000Z-capture\.png$/);
  assert.equal(s.metrics.filenameFallbacks,1);
  assert.equal(saved.filename,'/chosen/result.png');
});

test('START validates Full Page policy and omits it for Region', async () => {
 const startSource=source.slice(source.indexOf('async function start('),source.indexOf('async function ensureVisible'));
 for(const [mode,input,expected] of [['full','strict','strict'],['full','robust','robust'],['full','broken','robust'],['full',undefined,'robust'],['region','strict',undefined]]){
  let session;
  const context={active:null,crypto:{randomUUID:()=> 'policy'},chrome:{tabs:{query:async()=>[{id:1,url:'https://fixture.test'}]},scripting:{executeScript:async()=>{}}},
   status:async s=>{session=s},request:async()=>{},run:()=>{},setInterval:()=>0,finish:async()=>{}};
  vm.runInNewContext(startSource,context);await context.start(mode,'css',input);
  assert.equal(session.continuityPolicy,expected);
 }
});

test('Full Page Robust exposes strong probable-score on retry 1 and all fallbacks only on retry 2', () => {
  assert.match(source,/robustFallbackMode:\s*s\.continuityPolicy === "strict" \? null : retry === 1 \? "score" : retry === 2 \? "all" : null/);
  assert.doesNotMatch(source,/allowRobustFallback:/);
});

test('Region run freezes original UI edges as viewport-x/content-y Scope instead of rebuilding from anchors', () => {
  assert.match(source,/const selected = verticalRegionFromViewportEdges\(s\.edges, s\.viewport\)/);
  assert.match(source,/s\.regionCropLeft = selected\.cropLeft/);
  assert.doesNotMatch(source,/left: resolved\.region\.x/);
});

test('Region relativeView normalizes horizontal output to zero while preserving viewport cropLeft', () => {
  const s={mode:'region',region:{x:0,y:300,width:1000,height:20000},regionCropLeft:200};
  const actual={x:20,y:1000,region:{x:0,y:300,width:1000,height:20000},viewportRect:{left:180,top:0},clientWidth:1100,clientHeight:704};
  const normalized=validationContext.relativeView(s,actual);
  assert.equal(normalized.x,0);
  assert.equal(normalized.cropLeft,200);
  assert.equal(normalized.y,1000);
});


test('multi-part save uses ordered suffixes and preserves actual DownloadItem paths', async () => {
  const helperSource=source.slice(source.indexOf('function utf8CodePointBytes'),source.indexOf('async function run'));
  const attempts=[];let next=0;
  const context={
    chrome:{downloads:{
      download:async options=>{attempts.push(options.filename);return ++next},
      search:async ({id})=>[{id,state:'complete',filename:`/chosen/part-${id}.png`,fileSize:id*100}]
    }},
    status:async()=>{},check:()=>{},delay:async()=>{}
  };
  vm.runInNewContext(helperSource,context);
  const s={tab:{title:'Fixture'},stamp:'2026-09-20T00-00-00-000Z',metrics:{filenameFallbacks:0},parts:0};
  const parts=[
    {url:'blob:1',width:900,height:16384},
    {url:'blob:2',width:900,height:3416}
  ];
  const saved=[];
  for(let i=0;i<parts.length;i++)saved.push(await context.saveImage(s,parts[i],i,parts.length));
  assert.match(attempts[0],/-01-of-02\.png$/);
  assert.match(attempts[1],/-02-of-02\.png$/);
  assert.deepEqual(saved.map(x=>x.filename),['/chosen/part-1.png','/chosen/part-2.png']);
  assert.equal(s.parts,2);
});
