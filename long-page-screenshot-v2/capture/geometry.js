export const MAX_PIXELS = 16_000_000;
export const MAX_DIMENSION = 16_384;
export const MAX_PARTS = 24;
export const AUTO_SCALE = 0.9;

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
  const ratio = { auto: Math.min(AUTO_SCALE, sourceX, sourceY), css: 1, "75": 0.75, "50": 0.5, device: sourceX }[mode];
  if (!ratio) throw new Error("未知输出尺寸。");
  const width = Math.round(region.width * ratio), height = Math.round(region.height * ratio);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || width > MAX_PIXELS) {
    throw new Error("截图横向尺寸过大，请缩小区域或选择更低比例。");
  }
  const partHeight = Math.min(MAX_DIMENSION, Math.max(1, Math.floor(MAX_PIXELS / width)));
  const partCount = Math.ceil(height / partHeight);
  if (partCount > MAX_PARTS) throw new Error(`截图过长，需要 ${partCount} 张图片；请缩小区域或选择更低比例。`);
  return { sourceX, sourceY, scaleX: ratio, scaleY: ratio, width, height, partHeight, partCount,
    split: partCount > 1, autoScale: mode === "auto" ? AUTO_SCALE : null };
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
