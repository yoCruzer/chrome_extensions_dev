import test from "node:test";
import assert from "node:assert/strict";
import { regionFromEdges, verticalRegionFromViewportEdges, outputGeometry, drawGeometry, pixelEdge, MAX_PIXELS, AUTO_SCALE, sameViewport } from "../capture/geometry.js";
import { visibleTile } from "../capture/planner.js";

test("selection validates all four document edges", () => {
  const page = { width: 1200, height: 30000 };
  assert.deepEqual(regionFromEdges({ left: 200, right: 900, top: 500, bottom: 29000 }, page),
    { x: 200, y: 500, width: 700, height: 28500 });
  for (const edges of [
    { left: -1, right: 900, top: 0, bottom: 10 },
    { left: 900, right: 200, top: 0, bottom: 10 },
    { left: 0, right: 1300, top: 0, bottom: 10 },
    { left: 0, right: 10, top: 10, bottom: 9 },
    { left: 0, right: 10, top: 0, bottom: Infinity }
  ]) assert.throws(() => regionFromEdges(edges, page));
});

for (const scale of [1, 1.25, 1.5, 2, 2.5]) {
  test(`fractional scale ${scale}: clamped bottom and absolute tile edges cover every output pixel`, () => {
    const region = { x: 73, y: 121, width: 2303, height: 1017 };
    const viewport = { innerWidth: 1000, innerHeight: 700, clientWidth: 985, clientHeight: 685 };
    const output = outputGeometry(region, viewport, { width: 1000 * scale, height: 700 * scale }, "device");
    assert.ok(output.width * output.partHeight <= MAX_PIXELS);
    const total = pixelEdge(region.y + region.height, region.y, scale);
    let previousRow = 0;
    for (let start = 0; start < total; start += output.partHeight) {
      const height = Math.min(output.partHeight, total - start);
      const end = Math.min(region.y + region.height, region.y + (start + height) / scale);
      let y = region.y + start / scale;
      while (y < end - 0.0001) {
        let x = region.x, bandBottom, previousColumn = 0, rowEnd;
        while (x < region.x + region.width - 0.0001) {
          const view = { ...viewport, x: Math.min(Math.floor(x), 2500 - viewport.clientWidth), y: Math.min(Math.floor(y), 20000 - viewport.clientHeight) };
          const tile = visibleTile(region, view, x, y, bandBottom);
          tile.bottom = Math.min(tile.bottom, end);
          bandBottom = tile.bottom;
          const draw = drawGeometry(region, view, tile, output, start);
          assert.equal(draw.dx, previousColumn);
          assert.equal(draw.dy + start, previousRow);
          assert.ok(draw.sy >= 0 && draw.sy + draw.sh <= viewport.clientHeight * scale + 0.01);
          assert.ok(draw.dy + draw.dh <= height);
          previousColumn += draw.dw;
          rowEnd = draw.dy + start + draw.dh;
          x = tile.right;
        }
        assert.equal(previousColumn, output.width);
        previousRow = rowEnd;
        y = bandBottom;
      }
    }
    assert.equal(previousRow, total);
  });
}

test("actual clamped last viewport is cropped, not appended twice", () => {
  const region = { x: 0, y: 0, width: 800, height: 1500 };
  const view = { x: 0, y: 800, clientWidth: 800, clientHeight: 700 };
  assert.deepEqual(visibleTile(region, view, 0, 1400), { x: 0, y: 1400, right: 800, bottom: 1500 });
  assert.throws(() => visibleTile(region, { ...view, y: 900 }, 0, 800));
  assert.throws(() => visibleTile(region, { ...view, y: 0 }, 0, 800));
});

test("Full Page rejects oversized width and strict viewport changes", () => {
  assert.throws(() => outputGeometry({ x: 0, width: 20000 }, { innerWidth: 1000, innerHeight: 700 }, { width: 1000, height: 700 }));
  assert.equal(sameViewport({ dpr: 1 }, { dpr: 2 }), false);
});

for (const [mode, ratio] of [["auto", AUTO_SCALE], ["css", 1], ["75", 0.75], ["50", 0.5], ["device", 2]]) {
  test(`output mode ${mode} separates bitmap sampling from CSS output scale`, () => {
    const region = { x: 0, y: 0, width: 800, height: 2000 };
    const out = outputGeometry(region, { innerWidth: 800, innerHeight: 600 }, { width: 1600, height: 1200 }, mode);
    assert.equal(out.width, 800 * ratio); assert.equal(out.height, 2000 * ratio);
    const draw = drawGeometry(region, { x: 0, y: 0 }, { x: 0, y: 0, right: 800, bottom: 600 }, out, 0);
    assert.equal(draw.sw, 1600); assert.equal(draw.sh, 1200);
    assert.equal(draw.dw, 800 * ratio); assert.equal(draw.dh, 600 * ratio);
  });
}

test("Auto keeps a balanced scale and plans multiple bounded parts instead of shrinking to one canvas", () => {
  const view = { innerWidth: 900, innerHeight: 700 }, bitmap = { width: 1800, height: 1400 };
  const region = { x: 0, y: 0, width: 900, height: 26000 };
  const out = outputGeometry(region, view, bitmap);
  assert.equal(out.scaleX, AUTO_SCALE);
  assert.equal(out.width, Math.round(900 * AUTO_SCALE));
  assert.equal(out.height, Math.round(26000 * AUTO_SCALE));
  assert.ok(out.partHeight <= 16384);
  assert.ok(out.width * out.partHeight <= MAX_PIXELS);
  assert.ok(out.partCount > 1);
  const css = outputGeometry(region, view, bitmap, "css");
  assert.equal(css.scaleX, 1);
  assert.ok(css.partCount >= out.partCount);
});

test('nested target crop adds browser viewport origin using bitmap-derived scale', () => {
  const region = {x:0,y:2000,width:499,height:2400};
  const view = {x:0,y:2000,innerWidth:900,innerHeight:700,viewportRect:{left:80,top:40}};
  const scale = outputGeometry(region,view,{width:1800,height:1400},'css');
  const d = drawGeometry(region,view,{x:0,y:2000,right:499,bottom:2620},scale,0);
  assert.deepEqual(d,{sx:160,sy:80,sw:998,sh:1240,dx:0,dy:0,dw:499,dh:620});
});

test('vertical Region keeps horizontal selection in browser viewport coordinates', () => {
  const view={innerWidth:1496,innerHeight:704,clientWidth:1100,clientHeight:704,height:27115,
    viewportRect:{left:180,top:0}};
  const selected=verticalRegionFromViewportEdges({left:200,right:1200,top:300,bottom:20300},view);
  assert.deepEqual(selected,{x:0,y:300,width:1000,height:20000,cropLeft:200,cropRight:1200});
  const scale=outputGeometry(selected,view,{width:1496,height:704},'auto');
  const d=drawGeometry(selected,{x:0,y:300,innerWidth:1496,innerHeight:704,cropLeft:200,viewportRect:{left:180,top:0}},
    {x:0,y:300,right:1000,bottom:1004},scale,0);
  assert.equal(d.sx,200);
  assert.equal(d.sw,1000);
  assert.equal(d.dx,0);
  assert.throws(()=>verticalRegionFromViewportEdges({left:100,right:1200,top:300,bottom:400},view));
});
