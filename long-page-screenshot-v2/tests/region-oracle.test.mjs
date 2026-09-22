import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFrozenRows } from './region-oracle.mjs';
function image(width, height, offset = 0) {
  return { width, height, data: Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const pixel = Math.floor(i / 4), channel = i % 4;
    return [pixel % width, Math.floor(pixel / width) + offset, 97, 255][channel];
  }) };
}
function fixture() {
  const edges = { left: 2, top: 1, right: 6, bottom: 10 };
  const samples = [0, 4, 6].map(y => ({ png: image(8, 4, y),
    view: { x: 0, y, innerWidth: 8, innerHeight: 4, clientHeight: 4 } }));
  const output = image(4, 9);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 4; x++)
    output.data.set([x + 2, y + 1, 97, 255], (y * 4 + x) * 4);
  return { output, samples, edges };
}
test('fixed-scope oracle verifies every row through a clamped overlapping final frame', () => {
  const h = fixture(); assert.doesNotThrow(() => verifyFrozenRows(h.output, h.samples, h.edges));
});
for (const [name, mutate, pattern] of [
  ['horizontal anchor drift', h => { h.output.data[0]--; }, /fixed-scope row 0/],
  ['vertical anchor drift', h => { h.output.data[1]++; }, /fixed-scope row 0/],
  ['gap', h => { h.samples[1].view.y++; }, /uncovered/],
  ['missing final rows', h => { h.samples.pop(); }, /final selected row/],
  ['wrong dimensions', h => { h.output.height++; }, /equal/]
]) test(`fixed-scope oracle rejects ${name}`, () => {
  const h = fixture(); mutate(h); assert.throws(() => verifyFrozenRows(h.output, h.samples, h.edges), pattern);
});
