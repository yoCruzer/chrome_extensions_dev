import test from 'node:test';
import assert from 'node:assert/strict';
import { VISUAL, matchVertical, robustPlacement } from '../capture/visual.js';
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
for (const policy of ['robust', 'strict']) test(`policy ${policy}: minority left conflict`, () => {
 const a=frame(0),b=frame(525,(x,y)=>x<30?(y*19+x)%255:null);
 const result=matchVertical(a,b,525,false,policy);
 assert.equal(result.result,policy==='robust'?'matched':'strict-coverage-failed');
 if(policy==='strict'){assert.equal(result.zones.left.pass,false);assert.equal(result.zones.center.pass,true);assert.equal(result.zones.right.pass,true)}
});
test('strict full-width correction and blank neutral zone',()=>{
 for(const blank of [false,true])for(const fast of [false,true]){
  const mutate=(x)=>blank&&x<30?255:null;
  const result=matchVertical(frame(0,mutate),frame(480,mutate),525,fast,'strict');
  assert.equal(result.result,'matched');assert.equal(result.correction,-45);
  assert.ok(Object.values(result.zones).every(zone=>zone.pass));
  if(blank){assert.equal(result.zones.left.informativeTiles,0);assert.equal(result.zones.left.agreementRatio,null)}
 }
});

test('Robust probable visual placement keeps a bounded minority correction without pretending it was verified', () => {
  const pattern=(x,y)=>x<30
    ? ((Math.imul(y+17,7321)^Math.imul(x+19,y+731))>>>0)%251
    : (y%20)*10+x;
  const visual=matchVertical(frame(0,undefined,pattern),frame(480,undefined,pattern),525,false,'robust');
  assert.equal(visual.result,'ambiguous');
  assert.equal(visual.agreeingTiles,3);
  assert.equal(visual.candidateOffset,480);
  const placement=robustPlacement({canonicalY:1000,end:1700},525,visual,'robust');
  assert.equal(placement.visual.continuity,'probable');
  assert.equal(placement.visual.fallbackMethod,'probable-visual');
  assert.equal(placement.visual.placementCorrection,-45);
  assert.equal(placement.canonicalY,1480);
  assert.equal(placement.novelTop,1700);
});

test('Robust geometry fallback is limited to non-contradictory ambiguity/low-information; Strict and failed evidence stay closed', () => {
  const repeated=matchVertical(
    frame(0,undefined,(x,y)=>(y%20)*10+x),
    frame(525,undefined,(x,y)=>(y%20)*10+x),525,false,'robust');
  assert.equal(repeated.result,'ambiguous');
  const geometry=robustPlacement({canonicalY:1000,end:1700},525,repeated,'robust');
  assert.equal(geometry.visual.fallbackMethod,'geometry');
  assert.equal(geometry.visual.placementOffset,525);
  assert.equal(geometry.visual.continuity,'probable');

  const blank=frame(0,()=>255);
  const low=matchVertical(blank,blank,525,false,'robust');
  assert.equal(low.result,'low-information');
  assert.equal(robustPlacement({canonicalY:0,end:700},525,low,'robust').visual.fallbackMethod,'geometry');

  const failed=matchVertical(frame(0),frame(1800),525,false,'robust');
  assert.equal(robustPlacement({canonicalY:0,end:700},525,failed,'robust'),null);
  assert.equal(robustPlacement({canonicalY:0,end:700},525,repeated,'strict'),null);
  assert.equal(robustPlacement({canonicalY:0,end:700},0,repeated,'robust'),null);
  assert.equal(robustPlacement({canonicalY:0,end:700},700,repeated,'robust'),null);
});

test('Robust probable-score accepts coherent noisy alignment but still rejects unrelated images', () => {
  const basePattern=(x,y)=>((Math.imul(y+17,7321)^Math.imul(x+19,y+731))>>>0)%251;
  const noisyPattern=(x,y)=>basePattern(x,y)+(((x*17+y*13)%3)-1);
  const noisy=matchVertical(frame(0,undefined,basePattern),frame(525,undefined,noisyPattern),525,false,'robust');
  assert.equal(noisy.result,'failed');
  assert.equal(noisy.failureReason,'insufficient-quality');
  assert.ok(noisy.scoreAgreeingTiles >= VISUAL.minTiles);
  assert.ok(noisy.scoreAgreementRatio >= VISUAL.agreement);
  assert.equal(noisy.scoreCandidateOffset,525);
  const placement=robustPlacement({canonicalY:1000,end:1700},525,noisy,'robust');
  assert.equal(placement.visual.fallbackMethod,'probable-score');
  assert.equal(placement.visual.placementOffset,525);
  assert.equal(placement.visual.continuity,'probable');

  const unrelated=matchVertical(frame(0),frame(1800),525,false,'robust');
  assert.equal(unrelated.result,'failed');
  assert.equal(robustPlacement({canonicalY:1000,end:1700},525,unrelated,'robust'),null);
  assert.equal(robustPlacement({canonicalY:1000,end:1700},525,noisy,'strict'),null);
});

test('Robust accepts strong probable-score after one retry without weakening the score threshold', () => {
  const trace = {
    result:'failed', failureReason:'insufficient-quality',
    scoreAgreeingTiles:4, scoreAgreementRatio:0.8, scoreCandidateOffset:528,
    scoreBestScore:0.9871222478008116, scoreSecondBestScore:0.864237836187155
  };
  const previous={canonicalY:0,end:704};
  assert.equal(robustPlacement(previous,528,trace,'robust','score').visual.fallbackMethod,'probable-score');
  assert.equal(robustPlacement(previous,528,trace,'robust','score').visual.placementOffset,528);
  assert.equal(robustPlacement(previous,528,trace,'robust','all').visual.fallbackMethod,'probable-score');
  assert.equal(robustPlacement(previous,528,trace,'strict','score'),null);

  const weakened={...trace,scoreBestScore:0.9653255460749157,scoreSecondBestScore:0.8924851674791702};
  assert.ok(weakened.scoreBestScore-weakened.scoreSecondBestScore < VISUAL.probableScoreMargin);
  assert.equal(robustPlacement(previous,272,weakened,'robust','score'),null);
});

test('Final Robust recovery uses geometry-score when low-quality majority still agrees with observed geometry', () => {
  const trace={
    result:'failed',failureReason:'insufficient-quality',
    scoreAgreeingTiles:6,scoreAgreementRatio:0.75,scoreCandidateOffset:272,
    scoreBestScore:0.9653255460749157,scoreSecondBestScore:0.8924851674791702
  };
  const placement=robustPlacement({canonicalY:1000,end:1704},272,trace,'robust','all');
  assert.equal(placement.visual.fallbackMethod,'geometry-score');
  assert.equal(placement.visual.placementOffset,272);
  assert.equal(placement.visual.continuity,'probable');

  const unrelated={
    ...trace,scoreAgreeingTiles:1,scoreAgreementRatio:0.125,scoreCandidateOffset:250,
    scoreBestScore:0.51,scoreSecondBestScore:0.50
  };
  assert.equal(robustPlacement({canonicalY:1000,end:1704},272,unrelated,'robust','all'),null);
  assert.equal(robustPlacement({canonicalY:1000,end:1704},272,trace,'strict','all'),null);
});
