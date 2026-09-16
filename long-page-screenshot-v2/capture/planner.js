export const MAX_STEPS = 1000;

// The requested point must actually be visible. Snapping/jumping must never
// silently turn an unvisited strip into a gap in the output.
export function visibleTile(region, view, x, y, bandBottom) {
  if (view.x > x + 0.01 || view.y > y + 0.01 ||
      view.x + view.clientWidth <= x || view.y + view.clientHeight <= y) {
    throw new Error("页面未到达所需位置（可能有滚动拦截），已停止以免遗漏内容。");
  }
  const bottom = bandBottom ?? Math.min(region.y + region.height, view.y + view.clientHeight);
  if (bottom > view.y + view.clientHeight + 0.01) {
    throw new Error("横向截图时页面发生位移，请重试。");
  }
  return { x, y, right: Math.min(region.x + region.width, view.x + view.clientWidth), bottom };
}

export function checkHeight(initial, current, viewport) {
  if (current > Math.max(initial * 2, initial + viewport * 4)) {
    throw new Error("页面持续增长，可能是无限滚动。请改用固定选区。");
  }
}
