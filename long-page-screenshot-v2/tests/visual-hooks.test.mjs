import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { armAfterFirstBitmap, installVisualMutation } from './visual-hooks.mjs';

function harness({ failCapture = false } = {}) {
  const events = [];
  const sandbox = vm.createContext({
    window: { armVisualMutation: () => events.push('arm'), armTailMutation: () => events.push('tail-arm') },
    paint: seed => events.push(`paint:${seed}`), requestAnimationFrame: fn => fn()
  });
  const original = async function (...args) {
    assert.equal(this, sandbox.chrome.tabs);
    events.push('bitmap');
    if (failCapture) throw Error('capture denied');
    return JSON.stringify(args);
  };
  sandbox.chrome = {
    tabs: { captureVisibleTab: original, query: async () => [{ id: 42 }] },
    scripting: { executeScript: async ({ target, world, func, args = [] }) => {
      assert.equal(target.tabId, 42); assert.equal(world, 'MAIN');
      sandbox.__args = args;
      return [{ result: await vm.runInContext(`(${func.toString()})(...__args)`, sandbox) }];
    } }
  };
  return { sandbox, original, events,
    worker: { evaluate: (fn, arg) => { sandbox.__arg = arg; return vm.runInContext(`(${fn.toString()})(__arg)`, sandbox); } } };
}

test('one-shot arm follows a successful bitmap and restores the original with this/args intact', async () => {
  const h = harness();
  await armAfterFirstBitmap(h.worker, 'armTailMutation');
  assert.deepEqual(h.events, []);
  assert.equal(await h.sandbox.chrome.tabs.captureVisibleTab(7, { format: 'png' }), '[7,{"format":"png"}]');
  assert.deepEqual(h.events, ['bitmap', 'tail-arm']);
  assert.equal(h.sandbox.chrome.tabs.captureVisibleTab, h.original);
  await h.sandbox.chrome.tabs.captureVisibleTab();
  assert.deepEqual(h.events, ['bitmap', 'tail-arm', 'bitmap']);
});

test('a rejected first bitmap does not arm and does not leave a hook installed', async () => {
  const h = harness({ failCapture: true });
  await armAfterFirstBitmap(h.worker, 'armTailMutation');
  await assert.rejects(() => h.sandbox.chrome.tabs.captureVisibleTab(), /capture denied/);
  assert.deepEqual(h.events, ['bitmap']);
  assert.equal(h.sandbox.chrome.tabs.captureVisibleTab, h.original);
});

for (const restoreAt of [0, 3, 4]) {
  test(`visual fault schedule ${restoreAt} arms after first bitmap without consuming restoration`, async () => {
    const h = harness();
    await installVisualMutation(h.worker, { restoreAt });
    const count = restoreAt || 3;
    for (let i = 0; i < count; i++) await h.sandbox.chrome.tabs.captureVisibleTab();
    const expected = ['bitmap', 'arm'];
    for (let call = 2; call <= count; call++) {
      if (restoreAt && call === 2) expected.push('paint:987654');
      if (restoreAt && call === restoreAt) expected.push('paint:0');
      expected.push('bitmap');
    }
    assert.deepEqual(h.events, expected);
    assert.equal(h.sandbox.__v2VisualOriginal, undefined);
    h.events.length = 0;
    await h.sandbox.chrome.tabs.captureVisibleTab();
    assert.deepEqual(h.events, ['bitmap']);
  });
}

test('a new scenario discards a previous incomplete corruption wrapper', async () => {
  const h = harness();
  await installVisualMutation(h.worker, { restoreAt: 4 });
  await h.sandbox.chrome.tabs.captureVisibleTab();
  await h.sandbox.chrome.tabs.captureVisibleTab();
  await installVisualMutation(h.worker);
  h.events.length = 0;
  for (let i = 0; i < 3; i++) await h.sandbox.chrome.tabs.captureVisibleTab();
  assert.deepEqual(h.events, ['bitmap', 'arm', 'bitmap', 'bitmap']);
});

test('invalid corruption restoration schedules are rejected before installation', async () => {
  for (const restoreAt of [1, 2, 2.5, -1, NaN]) {
    const h = harness();
    await assert.rejects(() => installVisualMutation(h.worker, { restoreAt }), /restoreAt/);
    assert.equal(h.sandbox.chrome.tabs.captureVisibleTab, h.original);
  }
});

async function fixtureHarness(name, kind) {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const draws = [], listeners = {};
  const ctx = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w*h*4) }),
    putImageData() {}, fillText() {}, fillRect: (...args) => draws.push(args) };
  const canvas = { width: 12, height: 160, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,reference' };
  const elements = { '#island': { style: {}, prepend() {} }, '#witness': {}, '#spacer': { style: {} }, '#layout': { prepend() {} }, '#target': {} };
  const sandbox = vm.createContext({ URLSearchParams, Uint8ClampedArray, location: { search: `?kind=${kind}` },
    scrollY: 0, document: { documentElement: {}, querySelector: s => s === 'canvas' ? canvas : elements[s] },
    addEventListener: (name, fn) => { listeners[name] = fn; } });
  sandbox.window = sandbox;
  vm.runInContext(script, sandbox);
  return { sandbox, draws, canvas,
    scroll: y => { sandbox.scrollY = y; listeners.scroll(); } };
}

test('visual fixture ignores warmup and changes on the scroll after arming, exactly once', async () => {
  const h = await fixtureHarness('test-visual-page.html', 'ad');
  for (const y of [630, 1260, 1890, 2500, 0]) h.scroll(y);
  assert.equal(h.sandbox.visualMutationStatus().changed, false);
  assert.equal(h.sandbox.visualMutationStatus().preCaptureScrolls, 4);
  assert.equal(h.draws.length, 0);
  h.sandbox.armVisualMutation();
  assert.equal(h.sandbox.visualMutationStatus().changed, false);
  for (const y of [525, 1050, 1575]) h.scroll(y);
  assert.equal(h.sandbox.visualMutationStatus().changed, true);
  assert.equal(h.sandbox.visualMutationStatus().armCount, 1);
  assert.deepEqual(h.draws, [[0, 0, 240, 160]]);
  assert.throws(() => h.sandbox.armVisualMutation(), /unchanged at the capture top/);
});

test('44px tail retains its 6364px baseline through warmup, then grows during capture', async () => {
  const h = await fixtureHarness('test-bottom-tail-page.html', '44');
  for (const y of [820, 1640, 2460, 3280, 4100, 4920, 5452, 0]) h.scroll(y);
  assert.equal(h.canvas.height, 6364);
  h.sandbox.armTailMutation();
  assert.equal(h.canvas.height, 6364);
  h.scroll(4500);
  assert.equal(h.canvas.height, 6428);
  h.scroll(5000);
  assert.equal(h.canvas.height, 6428);
});
