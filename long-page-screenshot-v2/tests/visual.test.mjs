import test from 'node:test';
import assert from 'node:assert/strict';
import { matchVertical } from '../capture/visual.js';
function frame(offset, mutate = () => null, pattern = (x, y) => ((Math.imul(y + 17, 7321) ^ Math.imul(x + 19, y + 731)) >>> 0) % 251) {
  const width = 120, height = 700;
  return { width, height, start: 0, data: Float32Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return mutate(x, y) ?? pattern(x, y + offset);
  }) };
}
for (const correction of [0, -45, -80, 20, 96]) test(`exact displacement correction ${correction}`, () => {
  const result = matchVertical(frame(0), frame(525 + correction), 525);
  assert.equal(result.result, 'matched'); assert.equal(result.correction, correction);
});
for (const kind of ['sidebar', 'ad', 'islands']) test(`minority ${kind}`, () => {
  const result = matchVertical(frame(0), frame(525, (x, y) => (kind === 'islands' ? x < 12 || x >= 108 : x < 30) ? (y * 19 + x) % 255 : null), 525);
  assert.equal(result.result, 'matched'); assert.equal(result.matchedOffset, 525);
});
test('unrelated images fail', () => assert.notEqual(matchVertical(frame(0), frame(1800), 525).result, 'matched'));
test('repeated rows are ambiguous including adjacent ties', () => {
  for (const period of [1, 2, 20]) assert.notEqual(matchVertical(frame(0, undefined, (x, y) => (y % period) * 10 + x), frame(525, undefined, (x, y) => (y % period) * 10 + x), 525).result, 'matched');
});
test('white tiles excluded', () => {
  const blank = frame(0, () => 255);
  assert.equal(matchVertical(blank, blank, 525).result, 'low-information');
});
test('out-of-range gradient alias does not manufacture continuity', () => {
 const ramp=(x,y)=>((y%251)*77+Math.floor(y/251)*150+97*29)/256;
 assert.notEqual(matchVertical(frame(0,undefined,ramp),frame(125,undefined,ramp),525).result,'matched');
});
test('bounded strips and sparse fast check preserve exact alignment',()=>{
 const a=frame(0),b=frame(480);a.start=269;a.data=a.data.slice(a.start*a.width);b.data=b.data.slice(0,431*b.width);
 assert.equal(matchVertical(a,b,525).matchedOffset,480);
 assert.equal(matchVertical(a,b,525,true).matchedOffset,480);
});
test('RGB verification rejects a luminance-equivalent colored gradient alias',()=>{
 function colored(offset){
  const result=frame(offset,undefined,(x,y)=>((y%251)*77+Math.floor(y/251)*150+97*29)/256);
  result.colors=new Uint8Array(result.width*result.height*3);
  for(let y=0;y<result.height;y++)for(let x=0;x<result.width;x++)result.colors.set([(y+offset)%251,Math.floor((y+offset)/251),97],(y*result.width+x)*3);
  return result;
 }
 assert.notEqual(matchVertical(colored(0),colored(45),525).result,'matched');
 assert.equal(matchVertical(colored(0),colored(525),525).matchedOffset,525);
});
test('vertical borders alone do not inflate informative tile count',()=>{
 const pattern=(x,y)=>x<40?(x%2)*200:((Math.imul(y+17,7321)^Math.imul(x+19,y+731))>>>0)%251;
 const result=matchVertical(frame(0,undefined,pattern),frame(525,undefined,pattern),525);
 assert.equal(result.result,'matched');assert.equal(result.informativeTiles,8);assert.equal(result.agreeingTiles,8);
});
