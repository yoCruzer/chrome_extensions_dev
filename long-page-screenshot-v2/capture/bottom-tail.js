import { overlapCSS } from "./visual.js";

export const TERMINAL_GEOMETRY_EPSILON = 1;
export const terminalNear = (a, b, epsilon = TERMINAL_GEOMETRY_EPSILON) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;

// Explain terminal eligibility without weakening normal-frame geometry.
// finalExtent remains authoritative; <=1 CSS px differences are treated as
// measurement jitter, not as permission to grow/shrink the capture plan.
export function assessBottomTail(view, canonicalEnd, finalExtent = view?.height) {
  const tailLimit = Number.isFinite(view?.clientHeight)
    ? Math.min(320, overlapCSS(view.clientHeight))
    : null;
  const details = {
    finalExtent,
    canonicalEndBefore: canonicalEnd,
    observedHeight: view?.height,
    actualTargetScrollY: view?.y,
    viewportHeight: view?.clientHeight,
    visibleBottom: Number.isFinite(view?.y) && Number.isFinite(view?.clientHeight)
      ? view.y + view.clientHeight : null,
    epsilon: TERMINAL_GEOMETRY_EPSILON,
    tailLimit
  };
  if (![finalExtent, canonicalEnd, view?.height, view?.y, view?.clientHeight].every(Number.isFinite)) {
    return { anchor: null, reason: "invalid-geometry", details };
  }
  if (canonicalEnd <= 0) return { anchor: null, reason: "invalid-canonical-end", details };
  const extentDelta = view.height - finalExtent;
  const bottomDelta = details.visibleBottom - finalExtent;
  const remainingTail = finalExtent - canonicalEnd;
  Object.assign(details, { extentDelta, bottomDelta, remainingTail });
  if (!terminalNear(view.height, finalExtent)) {
    return { anchor: null, reason: "extent-mismatch", details };
  }
  if (!terminalNear(details.visibleBottom, finalExtent)) {
    return { anchor: null, reason: "not-physical-bottom", details };
  }
  if (remainingTail <= 0) return { anchor: null, reason: "no-novel-tail", details };
  if (remainingTail > tailLimit) return { anchor: null, reason: "tail-too-large", details };
  return {
    anchor: {
      ...details,
      maxTargetScrollY: finalExtent - view.clientHeight,
      novelPixels: remainingTail,
      canonicalY: finalExtent - view.clientHeight,
      novelTop: canonicalEnd
    },
    reason: null,
    details
  };
}

// Target-local visible bottom must coincide with the physical content bottom,
// allowing only bounded terminal measurement jitter.
export function bottomTail(view, canonicalEnd, finalExtent = view.height) {
  return assessBottomTail(view, canonicalEnd, finalExtent).anchor;
}
