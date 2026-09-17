import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
function fixture() {
  const rect = { left: 10, top: 20, width: 500, height: 8000, right: 510, bottom: 8020 };
  const element = { isConnected: true, getBoundingClientRect: () => rect };
  const context = { document: { elementFromPoint: () => element }, scrollX: 0, scrollY: 0,
    progress: null, getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }) };
  vm.runInNewContext(source.slice(source.indexOf('  function anchorAt'), source.indexOf('  function regionView')), context);
  const s = { host: { style: { setProperty() {}, removeProperty() {} } }, edges: {left:10,top:20,right:500,bottom:8010} };
  s.anchors = { first: context.anchorAt(s, 10, 20), second: context.anchorAt(s, 500, 8010) };
  return { rect, element, s, resolve: () => context.resolveRegion(s) };
}

test('anchors retain selection size and all edge distances; rigid translation follows', () => {
  const { rect, s, resolve } = fixture();
  assert.equal(s.anchors.second.width, 500);assert.equal(s.anchors.second.height, 8000);
  assert.deepEqual(JSON.parse(JSON.stringify(s.anchors.second.insets)), {left:490,top:7990,right:10,bottom:10});
  rect.top += 300;rect.left += 40;
  assert.deepEqual(JSON.parse(JSON.stringify(resolve())), {x:50,y:320,width:490,height:7990});
});
for (const [axis, delta] of [['height',300], ['height',-300], ['width',300], ['width',-100], ['height',0.5]]) {
  test(`anchor ${axis} change ${delta} fails on initial resolve and retry without rebasing`, () => {
    const {rect, resolve} = fixture();rect[axis] += delta;
    for (let i=0;i<2;i++) assert.throws(resolve, e => e.layout === true && /锚点尺寸已变化/.test(e.message));
  });
}
test('removed anchor still fails closed; numeric fallback ignores anchor size', () => {
  const {element, rect, s, resolve} = fixture();element.isConnected = false;
  assert.throws(resolve, /锚点已失效/);
  s.anchors = null;rect.height += 300;
  assert.equal(resolve().height, 7990);
});
