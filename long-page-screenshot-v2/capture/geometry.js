export const MAX_PIXELS = 16_000_000;
export const MAX_DIMENSION = 16_384;

export function regionFromEdges({ left, top, right, bottom }, page) {
  if (![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 ||
      right <= left || bottom <= top || right > page.width || bottom > page.height) {
    throw new Error("选区无效：请在页面范围内设置左、右、上、下边界。");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function verticalRegionFromViewportEdges({ left, top, right, bottom }, view) {
  const minX = view.viewportRect?.left || 0;
  const maxX = minX + view.clientWidth;
  if (![left, top, right, bottom, minX, maxX].every(Number.isFinite) ||
      left < minX || right > maxX || right <= left || top < 0 || bottom <= top || bottom > view.height) {
    throw new Error("选区无效：横向边界必须位于当前可见区域内，纵向边界必须位于目标内容范围内。");
  }
  return { x: 0, y: top, width: right - left, height: bottom - top, cropLeft: left, cropRight: right };
}

// Round absolute boundaries, never the height of each successive tile.
export const pixelEdge = (css, origin, scale) => Math.round((css - origin) * scale);

export function outputGeometry(region, view, bitmap, mode = "auto") {
  const sourceX = bitmap.width / view.innerWidth;
  const sourceY = bitmap.height / view.innerHeight;
  if (![region.width, region.height, sourceX, sourceY].every(n => Number.isFinite(n) && n > 0) || Math.abs(sourceX - sourceY) > 0.02) {
    throw new Error("截图尺寸不受支持，请缩小选区。");
  }
  const safe = Math.min(MAX_DIMENSION / region.width, MAX_DIMENSION / region.height,
    Math.sqrt(MAX_PIXELS / (region.width * region.height)));
  const requested = { auto: Math.min(1, sourceX, sourceY, safe), css: 1, "75": 0.75, "50": 0.5, device: sourceX }[mode];
  if (!requested || (mode === "auto" && requested < 0.25)) throw new Error("页面过长，无法生成清晰的单图，请缩小截图区域。");
  let ratio = requested;
  let width = Math.round(region.width * ratio), height = Math.round(region.height * ratio);
  // Rounding must not push an Auto canvas beyond its hard budget.
  while (mode === "auto" && width * height > MAX_PIXELS) {
    ratio *= Math.sqrt(MAX_PIXELS / (width * height)) * 0.9999;
    width = Math.round(region.width * ratio); height = Math.round(region.height * ratio);
  }
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error("此输出尺寸无法安全生成单图，请改用自动、更低比例或缩小区域。");
  }
  return { sourceX, sourceY, scaleX: ratio, scaleY: ratio, width, height, partHeight: height };
}

export function drawGeometry(region, view, rect, scale, partStart) {
  const x0 = pixelEdge(rect.x, region.x, scale.scaleX);
  const x1 = pixelEdge(rect.right, region.x, scale.scaleX);
  const y0 = pixelEdge(rect.y, region.y, scale.scaleY);
  const y1 = pixelEdge(rect.bottom, region.y, scale.scaleY);
  return {
    sx: (rect.x - view.x + (view.cropLeft ?? view.viewportRect?.left ?? 0)) * (scale.sourceX ?? scale.scaleX),
    sy: (rect.y - view.y + (view.viewportRect?.top || 0)) * (scale.sourceY ?? scale.scaleY),
    sw: (rect.right - rect.x) * (scale.sourceX ?? scale.scaleX),
    sh: (rect.bottom - rect.y) * (scale.sourceY ?? scale.scaleY),
    dx: x0, dy: y0 - partStart, dw: x1 - x0, dh: y1 - y0
  };
}

export function sameViewport(a, b) {
  return ["innerWidth", "innerHeight", "clientWidth", "clientHeight", "dpr"]
    .every(key => a[key] === b[key]);
}
