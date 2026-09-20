// One-dimensional registration only. CSS rows stay exact; horizontal samples
// are four CSS pixels apart (capped at 384), independent of device/output scale.
export const VISUAL = Object.freeze({ tiles: 12, maxWidth: 384, sampleX: 4,
  radius: 96, rows: 64, minTiles: 3, agreement: 0.6,
  minDeviation: 5, maxError: 0.04, maxAbsoluteError: 0.5, margin: 0.018, exactMargin: 0.005,
  probableScore: 0.72, probableScoreMargin: 0.08 });
export const overlapCSS = height => Math.min(height - 32, Math.max(160, Math.min(320, height * 0.25)));


// Robust completion-first placement after normal matching + bounded recovery.
// This never upgrades uncertainty to "matched": it returns an explicit probable
// placement only for ambiguity / low-information with coherent positive geometry.
// Strong mismatch ("failed") and Strict policy remain fail-closed.
export function robustPlacement(previous, expectedOffset, visual, policy = 'robust') {
  const scoreProbable = visual?.result === 'failed' && visual.failureReason === 'insufficient-quality' &&
    visual.scoreAgreeingTiles >= VISUAL.minTiles && visual.scoreAgreementRatio >= VISUAL.agreement &&
    Number.isFinite(visual.scoreCandidateOffset) &&
    visual.scoreBestScore >= VISUAL.probableScore &&
    visual.scoreBestScore - visual.scoreSecondBestScore >= VISUAL.probableScoreMargin;
  if (policy !== 'robust' || !visual ||
      (!['ambiguous', 'low-information'].includes(visual.result) && !scoreProbable)) return null;
  const previousVisibleHeight = previous?.end - previous?.canonicalY;
  if (!Number.isFinite(expectedOffset) || expectedOffset <= 0 ||
      !Number.isFinite(previousVisibleHeight) || previousVisibleHeight <= 0 ||
      expectedOffset >= previousVisibleHeight) return null;

  let placementOffset = expectedOffset, fallbackMethod = 'geometry';
  if (scoreProbable) {
    placementOffset = visual.scoreCandidateOffset;
    fallbackMethod = 'probable-score';
  } else if (visual.result === 'ambiguous' && visual.agreeingTiles >= VISUAL.minTiles &&
      Number.isFinite(visual.candidateOffset)) {
    placementOffset = visual.candidateOffset;
    fallbackMethod = 'probable-visual';
  }
  if (!Number.isFinite(placementOffset) || placementOffset <= 0 || placementOffset >= previousVisibleHeight) return null;

  return {
    canonicalY: previous.canonicalY + placementOffset,
    novelTop: previous.end,
    visual: {
      ...visual,
      continuity: 'probable',
      fallbackMethod,
      placementOffset,
      placementCorrection: placementOffset - expectedOffset,
      path: fallbackMethod === 'geometry' ? 'geometry-fallback' : fallbackMethod
    }
  };
}

// Frames contain only bounded top/tail strips, never complete screenshot history.
export function matchVertical(previous, current, expectedOffset, fast = false, policy = 'robust') {
  const radius = VISUAL.radius, width = previous.width;
  policy = policy === 'strict' ? 'strict' : 'robust';
  const informative = [];
  const base = { policy, expectedOffset, matchedOffset: null, correction: null,
    candidateOffset: null, candidateCorrection: null,
    scoreCandidateOffset: null, scoreCandidateCorrection: null,
    searchRadius: radius, overlapHeight: previous.height - expectedOffset,
    informativeTiles: 0, qualityTiles: 0, agreeingTiles: 0, scoreAgreeingTiles: 0,
    agreementRatio: 0, scoreAgreementRatio: 0, qualityRatio: 0,
    bestScore: 0, secondBestScore: 0, scoreBestScore: 0, scoreSecondBestScore: 0,
    confidence: 0, failureReason: null };
  if (width !== current.width) return { ...base, result: 'failed', failureReason: 'width-mismatch' };
  const low = Math.max(1, Math.round(expectedOffset) - radius);
  const high = Math.min(previous.height - 32, Math.round(expectedOffset) + radius);
  // The same rows participate in every candidate; changing overlap size must not
  // favor an offset just because it compares fewer pixels.
  const start = Math.max(previous.start, high + current.start), end = Math.min(previous.height, low + current.start + current.data.length / width);
  if (end - start < 24) return { ...base, result: 'failed', failureReason: 'insufficient-overlap' };
  const step = Math.max(1, Math.ceil((end - start) / (fast ? 24 : VISUAL.rows)));
  const votes = [], scores = [];
  let qualityTiles = 0;
  for (let tile = 0; tile < VISUAL.tiles; tile++) {
    const left = Math.floor(tile * width / VISUAL.tiles), right = Math.floor((tile + 1) * width / VISUAL.tiles);
    let sum = 0, squares = 0, count = 0, verticalEnergy = 0;
    for (let y = start; y < end; y += step) for (let x = left; x < right; x += fast ? 6 : 2) {
      const v = previous.data[(y - previous.start) * width + x];
      sum += v; squares += v * v; count++;
      if (y > start) verticalEnergy += Math.abs(v - previous.data[(y - step - previous.start) * width + x]);
    }
    const deviation = Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
    if (!Number.isFinite(deviation) || deviation < VISUAL.minDeviation || verticalEnergy / count < 0.05) continue;
    base.informativeTiles++;
    informative.push(tile);
    const candidates = [];
    for (let offset = low; offset <= high; offset++) {
      let error = 0;
      for (let y = start; y < end; y += step) for (let x = left; x < right; x += fast ? 6 : 2) {
        error += Math.abs(previous.data[(y - previous.start) * width + x] - current.data[(y - offset - current.start) * width + x]);
      }
      candidates.push({ offset, error: error / count / deviation });
    }
    candidates.sort((a, b) => a.error - b.error);
    const [best, second] = candidates;
    if (!best || !second) continue;
    scores.push({ ...best, second: second.error });
    // A gray-only match can alias two differently colored smooth gradients.
    // Verify the winning candidate's sampled RGB values; no second RGB search.
    let colorError = 0;
    if (previous.colors && current.colors) {
      for (let y = start; y < end; y += step) for (let x = left; x < right; x += fast ? 6 : 2) {
        const a = ((y - previous.start) * width + x) * 3;
        const b = ((y - best.offset - current.start) * width + x) * 3;
        colorError += Math.max(Math.abs(previous.colors[a] - current.colors[b]),
          Math.abs(previous.colors[a + 1] - current.colors[b + 1]), Math.abs(previous.colors[a + 2] - current.colors[b + 2]));
      }
    }
    const quality = colorError / count <= VISUAL.maxAbsoluteError && best.error <= VISUAL.maxError && best.error * deviation <= VISUAL.maxAbsoluteError;
    if (quality) qualityTiles++;
    // Near-exact matches may distinguish adjacent smooth rows by a smaller
    // absolute margin; noisy near-ties still require the full 0.018 margin.
    if (quality && second.error - best.error >= Math.min(VISUAL.margin, Math.max(VISUAL.exactMargin, best.error * 0.5))) {
      votes.push({ tile, ...best, second: second.error });
    }
  }
  base.qualityTiles = qualityTiles;
  base.qualityRatio = base.informativeTiles ? qualityTiles / base.informativeTiles : 0;
  if (base.informativeTiles < VISUAL.minTiles) return { ...base, result: 'low-information', failureReason: 'low-information' };
  let agreeing = [];
  for (const vote of votes) {
    const group = votes.filter(other => other.offset === vote.offset);
    if (group.length > agreeing.length) agreeing = group;
  }
  base.agreeingTiles = agreeing.length;
  base.agreementRatio = agreeing.length / base.informativeTiles;
  if (agreeing.length) {
    base.candidateOffset = agreeing[0].offset;
    base.candidateCorrection = base.candidateOffset - expectedOffset;
  }
  let scoreAgreeing = [];
  for (const score of scores) {
    const group = scores.filter(other => other.offset === score.offset);
    if (group.length > scoreAgreeing.length) scoreAgreeing = group;
  }
  base.scoreAgreeingTiles = scoreAgreeing.length;
  base.scoreAgreementRatio = scoreAgreeing.length / base.informativeTiles;
  if (scoreAgreeing.length) {
    base.scoreCandidateOffset = scoreAgreeing[0].offset;
    base.scoreCandidateCorrection = base.scoreCandidateOffset - expectedOffset;
    base.scoreBestScore = 1 / (1 + scoreAgreeing.reduce((sum, score) => sum + score.error, 0) / scoreAgreeing.length);
    base.scoreSecondBestScore = 1 / (1 + scoreAgreeing.reduce((sum, score) => sum + score.second, 0) / scoreAgreeing.length);
  }
  const summary = agreeing.length ? agreeing : scores;
  if (summary.length) {
    base.bestScore = 1 / (1 + summary.reduce((sum, vote) => sum + vote.error, 0) / summary.length);
    base.secondBestScore = 1 / (1 + summary.reduce((sum, vote) => sum + vote.second, 0) / summary.length);
  }
  if (agreeing.length < VISUAL.minTiles || base.agreementRatio < VISUAL.agreement) {
    const result = qualityTiles >= VISUAL.minTiles ? 'ambiguous' : 'failed';
    return { ...base, result, failureReason: result === 'ambiguous' ? 'insufficient-consensus' : 'insufficient-quality' };
  }
  base.matchedOffset = agreeing[0].offset;
  base.correction = base.matchedOffset - expectedOffset;
  base.confidence = base.agreementRatio * Math.max(0, base.bestScore);
  if (policy === 'strict') {
    base.zones = {};
    for (const [name, left, right] of [['left', 0, 3], ['center', 3, 9], ['right', 9, 12]]) {
      const informativeTiles = informative.filter(tile => tile >= left && tile < right).length;
      const agreeingTiles = agreeing.filter(vote => vote.tile >= left && vote.tile < right).length;
      const agreementRatio = informativeTiles ? agreeingTiles / informativeTiles : null;
      base.zones[name] = { informativeTiles, agreeingTiles, agreementRatio,
        pass: !informativeTiles || agreementRatio >= 2 / 3 };
    }
    if (Object.values(base.zones).some(zone => !zone.pass)) return { ...base, result: 'strict-coverage-failed', failureReason: 'strict-zone' };
  }
  return { ...base, result: 'matched' };
}
