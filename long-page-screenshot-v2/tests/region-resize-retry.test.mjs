import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { verticalRegionFromViewportEdges, outputGeometry, sameViewport } from '../capture/geometry.js';
import { visibleTile, MAX_STEPS } from '../capture/planner.js';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const validation = source.slice(source.indexOf('function validateView'), source.indexOf('async function scroll'));
const runSource = source.slice(source.indexOf('async function run('), source.indexOf('chrome.runtime.onMessage.addListener'));

async function scenario(mode = 'once') {
  const events = [];
  let frozen, terminal, resized = false, secondResize = false, refreshes = 0;
  let current = { x: 0, y: 0, width: 500, height: 4800, innerWidth: 900, innerHeight: 700,
    clientWidth: 500, clientHeight: 620, dpr: 1, visualScale: 1,
    targetKind: 'element', viewportRect: { left: 80, top: 40 } };
  const s = { mode: 'region', tab: { id: 1 }, output: 'css',
    edges: { left: 80, top: 0, right: 579, bottom: 4799 },
    frames: 0, parts: 0, metrics: { captures: 0, settles: 0, retries: 0, frameRetries: 0 } };
  const context = { Date, MAX_STEPS, visibleTile, outputGeometry, verticalRegionFromViewportEdges, sameViewport,
    near: (a, b, epsilon = 0.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon,
    status: async (s, state) => { s.state = state; },
    ensureVisible: async s => { context.validateEnvironment(s, { ...s.lastView, tabId: 1, tabZoom: 1 }); },
    chrome: { tabs: { getZoom: async () => mode === 'zoom-during-refresh' && refreshes ? 1.25 : 1 },
      runtime: { getContexts: async () => [] }, offscreen: {
        createDocument: async () => events.push('create'), closeDocument: async () => events.push('close') } },
    request: async (s, target, type, args = {}) => {
      events.push(type);
      if (type === 'PREPARE') return { ...current };
      if (type === 'REGION_FREEZE') { frozen = { ...args.region }; return {}; }
      if (type === 'MEASURE') {
        if (s.attempt === 2) {
          refreshes++;
          if (mode === 'window-during-refresh') current = { ...current, innerWidth: 880 };
        }
        return { ...current, region: frozen };
      }
      if (type === 'OPEN') return outputGeometry(args.region, args.view, { width: 900, height: 700 }, 'css');
      if (type === 'FRAME') {
        if (!resized) { resized = true; current = { ...current, clientHeight: 500 }; }
        else if (mode === 'twice' && s.attempt === 2 && !secondResize) {
          secondResize = true; current = { ...current, clientHeight: 450 };
        }
      }
      if (type === 'EXPORT') return { parts: [{ width: 499, height: 4799, index: 0, count: 1 }] };
      return {};
    },
    scroll: async (s, x, y) => {
      current = { ...current, y: Math.min(y, current.height - current.clientHeight) };
      const view = { ...current, region: frozen };
      context.validateView(s, view);
      return view;
    },
    capture: async (s, view) => { s.metrics.captures++; return { view, dataUrl: 'bitmap' }; },
    saveImage: async (s, part) => { s.parts++; return { ...part, filename: '/test/result.png' }; },
    finish: async (s, error) => { terminal = error || null; }
  };
  vm.runInNewContext(validation + '\n' + runSource, context);
  await context.run(s);
  return { s, terminal, events };
}

test('one target resize discards the old canvas then remeasures and completes the unchanged selected scope', async () => {
  const { s, terminal, events } = await scenario();
  assert.equal(terminal, null); assert.equal(s.attempt, 2); assert.equal(s.metrics.retries, 1);
  assert.equal(s.parts, 1); assert.equal(s.result.width, 499); assert.equal(s.result.height, 4799);
  assert.equal(s.environment.clientHeight, 620); // Original environment evidence is retained.
  assert.equal(s.targetViewport.height, 500); assert.equal(s.viewport.clientHeight, 500);
  const close = events.indexOf('close'), measure = events.indexOf('MEASURE');
  assert.ok(close >= 0 && measure > close && events.indexOf('OPEN', measure) > measure);
});

test('a second target resize still fails closed instead of restarting indefinitely', async () => {
  const { s, terminal, events } = await scenario('twice');
  assert.equal(terminal.reasonCode, 'TARGET_RESIZED'); assert.equal(s.attempt, 2);
  assert.equal(s.metrics.retries, 1); assert.equal(s.parts, 0); assert.equal(s.result, undefined);
  assert.equal(events.includes('EXPORT'), false);
});
for (const [mode, field] of [['window-during-refresh', 'innerWidth'], ['zoom-during-refresh', 'tabZoom']]) {
  test(`${field} change cannot be accepted as a new environment baseline during target retry`, async () => {
    const { s, terminal, events } = await scenario(mode);
    assert.equal(terminal.reasonCode, 'CAPTURE_ENV_CHANGED'); assert.equal(terminal.diagnostics.delta.field, field);
    assert.equal(s.environment.innerWidth, 900); assert.equal(s.environment.tabZoom, 1);
    assert.equal(s.parts, 0); assert.equal(events.includes('EXPORT'), false);
  });
}
