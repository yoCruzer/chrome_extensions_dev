import test from 'node:test';
import assert from 'node:assert/strict';
import { matchVertical, VISUAL } from '../capture/visual.js';

const pattern = (x, y) => ((Math.imul(y + 17, 7321) ^ Math.imul(x + 19, y + 731)) >>> 0) % 251;
function strip(offset, { paired = false, noise = false, previous = false } = {}) {
  const width = 120, height = 700, start = previous ? 269 : 0;
  return { width, height, start, data: Float32Array.from({ length: width * 431 }, (_, i) => {
    const x = i % width, y = Math.floor(i / width) + start + offset;
    return pattern(x, paired ? Math.floor((y + 1) / 2) : y) + (noise ? ((x * 17 + y * 13) % 3) - 1 : 0);
  }) };
}

test('tied adjacent-row scores cannot shrink static content by one pixel per seam', () => {
  const previous = strip(0, { paired: true, previous: true });
  const current = strip(525, { paired: true });
  const visual = matchVertical(previous, current, 525, false, 'robust');
  assert.equal(visual.result, 'matched');
  assert.equal(visual.continuity, 'probable');
  assert.equal(visual.scoreCandidateOffset, 524); // Preserve misleading evidence for diagnosis.
  assert.equal(visual.subjectCore.bestScore, 1);
  assert.equal(visual.subjectCore.secondBestScore, 1);
  assert.equal(visual.subjectCore.placementBasis, 'geometry-score');
  assert.equal(visual.matchedOffset, 525);
  assert.equal(visual.correction, 0);
  assert.deepEqual(visual.volatileEdges, []);
  assert.equal(visual.subjectCore.candidateOffset, 524);
  let canonicalEnd = 700;
  for (let i = 0; i < 20; i++) canonicalEnd += visual.matchedOffset;
  assert.equal(canonicalEnd, 700 + 20 * 525);
  assert.notEqual(matchVertical(previous, current, 525, false, 'strict').result, 'matched');
});

for (const correction of [-45, -1, 0, 1, 20]) {
  test(`decisive quality evidence still corrects genuine ${correction}px displacement`, () => {
    const visual = matchVertical(strip(0, { previous: true }), strip(525 + correction), 525, false, 'robust');
    assert.equal(visual.result, 'matched');
    assert.equal(visual.correction, correction);
    assert.equal(visual.matchedOffset, 525 + correction);
  });
}

for (const correction of [-1, 1]) {
  test(`unique noisy score evidence still permits ${correction}px correction`, () => {
    const visual = matchVertical(strip(0, { previous: true }), strip(525 + correction, { noise: true }), 525, false, 'robust');
    assert.equal(visual.result, 'matched');
    assert.equal(visual.subjectCore.method, 'score');
    assert.ok(visual.subjectCore.bestScore - visual.subjectCore.secondBestScore >= VISUAL.probableScoreMargin);
    assert.equal(visual.subjectCore.placementBasis, 'score-margin');
    assert.equal(visual.correction, correction);
    assert.equal(visual.continuity, 'probable');
  });
}
