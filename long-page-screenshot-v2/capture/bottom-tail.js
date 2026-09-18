import { overlapCSS } from "./visual.js";

// Target-local visible bottom must coincide with the physical content bottom.
// For clipped elements this also rejects a bottom edge outside the bitmap.
export function bottomTail(view, canonicalEnd, finalExtent = view.height) {
  const remainingTail = finalExtent - canonicalEnd;
  if (![finalExtent, canonicalEnd, view.y, view.clientHeight].every(Number.isFinite) ||
      canonicalEnd <= 0 || view.height !== finalExtent ||
      Math.abs(view.y + view.clientHeight - finalExtent) > 0.01 ||
      remainingTail <= 0 || remainingTail > Math.min(320, overlapCSS(view.clientHeight))) return null;
  return { finalExtent, canonicalEndBefore: canonicalEnd, remainingTail,
    actualTargetScrollY: view.y, maxTargetScrollY: finalExtent - view.clientHeight,
    viewportHeight: view.clientHeight, novelPixels: remainingTail,
    canonicalY: finalExtent - view.clientHeight, novelTop: canonicalEnd };
}
