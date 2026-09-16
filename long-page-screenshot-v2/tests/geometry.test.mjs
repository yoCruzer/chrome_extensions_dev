import test from "node:test";
import assert from "node:assert/strict";
import { regionFromEdges, outputGeometry, drawGeometry, pixelEdge, MAX_PIXELS, sameViewport } from "../capture/geometry.js";
import { visibleTile, checkHeight } from "../capture/planner.js";

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
  test(`fractional scale ${scale}: wide document, clamped bottom, multiple parts cover every output pixel`, () => {
    const region = { x: 73, y: 121, width: 2303, height: 19517 };
    const viewport = { innerWidth: 1000, innerHeight: 700, clientWidth: 985, clientHeight: 685 };
    const output = outputGeometry(region, viewport, { width: 1000 * scale, height: 700 * scale });
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

test("limits fail explicitly for infinite growth, oversized width and changed zoom", () => {
  checkHeight(5000, 6500, 700);
  assert.throws(() => checkHeight(5000, 20000, 700));
  assert.throws(() => outputGeometry({ x: 0, width: 20000 }, { innerWidth: 1000, innerHeight: 700 }, { width: 1000, height: 700 }));
  assert.equal(sameViewport({ dpr: 1 }, { dpr: 2 }), false);
});
