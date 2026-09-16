export const MAX_PIXELS = 16_000_000;
export const MAX_DIMENSION = 16_384;

export function regionFromEdges({ left, top, right, bottom }, page) {
  if (![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 ||
      right <= left || bottom <= top || right > page.width || bottom > page.height) {
    throw new Error("选区无效：请在页面范围内设置左、右、上、下边界。");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Round absolute boundaries, never the height of each successive tile.
export const pixelEdge = (css, origin, scale) => Math.round((css - origin) * scale);

export function outputGeometry(region, view, bitmap) {
  const scaleX = bitmap.width / view.innerWidth;
  const scaleY = bitmap.height / view.innerHeight;
  const width = pixelEdge(region.x + region.width, region.x, scaleX);
  if (width < 1 || width > MAX_DIMENSION || Math.abs(scaleX - scaleY) > 0.02) {
    throw new Error("截图尺寸不受支持，请缩小页面缩放或选区宽度。");
  }
  return { scaleX, scaleY, width,
    partHeight: Math.min(8192, Math.floor(MAX_PIXELS / width)) };
}

export function drawGeometry(region, view, rect, scale, partStart) {
  const x0 = pixelEdge(rect.x, region.x, scale.scaleX);
  const x1 = pixelEdge(rect.right, region.x, scale.scaleX);
  const y0 = pixelEdge(rect.y, region.y, scale.scaleY);
  const y1 = pixelEdge(rect.bottom, region.y, scale.scaleY);
  return {
    sx: (rect.x - view.x) * scale.scaleX,
    sy: (rect.y - view.y) * scale.scaleY,
    sw: (rect.right - rect.x) * scale.scaleX,
    sh: (rect.bottom - rect.y) * scale.scaleY,
    dx: x0, dy: y0 - partStart, dw: x1 - x0, dh: y1 - y0
  };
}

export function sameViewport(a, b) {
  return ["innerWidth", "innerHeight", "clientWidth", "clientHeight", "dpr"]
    .every(key => a[key] === b[key]);
}
