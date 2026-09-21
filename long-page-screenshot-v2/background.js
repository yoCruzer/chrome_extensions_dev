import { regionFromEdges, verticalRegionFromViewportEdges, outputGeometry, sameViewport } from "./capture/geometry.js";
import { visibleTile, adaptiveEnd, MAX_STEPS } from "./capture/planner.js";
import { VISUAL, overlapCSS } from "./capture/visual.js";
import { assessBottomTail, TERMINAL_GEOMETRY_EPSILON, terminalNear } from "./capture/bottom-tail.js";

let active = null;
let lastStatus = { state: "idle", message: "准备就绪" };
let lastCapture = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A terminated worker cannot resume an in-memory canvas. Recover the page and
// explicitly mark the old job interrupted instead of accepting stale messages.
const ready = (async () => {
  const saved = (await chrome.storage.session.get("status")).status;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
  if (saved?.busy) {
    await chrome.tabs.sendMessage(saved.tabId, { target: "content", type: "FINISH", id: saved.id }).catch(() => {});
    if (saved.downloadId) await chrome.downloads.cancel(saved.downloadId).catch(() => {});
    lastStatus = { ...saved, busy: false, state: "failed", message: "上次任务已中断，页面已恢复。请重新截图。" };
    await chrome.storage.session.set({ status: lastStatus });
    await chrome.tabs.sendMessage(saved.tabId, { target: "content", type: "PROGRESS", id: saved.id, status: lastStatus }).catch(() => {});
  } else if (saved) lastStatus = saved;
})().catch(() => { lastStatus = { busy: false, state: "failed", message: "启动恢复未完成，可以重新开始截图。" }; });

function check(s) {
  if (active !== s || s.cancelled || s.finishing) throw Object.assign(new Error(s.reason || "截图已取消。"), { reasonCode: s.reasonCode || "CAPTURE_CANCELLED" });
  if (Date.now() - s.started > 15 * 60_000) throw new Error("任务超过 15 分钟，请缩小选区后重试。");
}

async function status(s, state, message) {
  check(s);
  s.state = state;
  lastStatus = { id: s.id, tabId: s.tab.id, state, message, busy: true,
    frames: s.frames, parts: s.parts, attempt: s.attempt, diagnostics: s.diagnostics, downloadId: s.downloadId };
  await chrome.storage.session.set({ status: lastStatus });
  await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "PROGRESS", id: s.id, status: lastStatus }, { frameId: 0 }).catch(() => {});
}

async function request(s, target, type, payload = {}) {
  check(s);
  const message = { target, type, id: s.id, ...(s.mode === "full" && target === "content" ? { diagnosticContext: { attempt: s.attempt, frames: s.frames } } : {}), ...payload };
  const response = target === "content"
    ? await chrome.tabs.sendMessage(s.tab.id, message, { frameId: 0 })
    : await chrome.runtime.sendMessage(message);
  check(s);
  if (response?.fullProof) s.fullProofDiagnostics = response.fullProof;
  if (response?.regionDiagnostics) s.diagnostics = { ...s.diagnostics, regionDiagnostics: response.regionDiagnostics };
  if (!response?.ok) throw Object.assign(new Error(response?.error || "截图组件未响应。"), { layout: !!response?.layout, translation: !!response?.translation, reasonCode: response?.reasonCode, diagnostics: response?.diagnostics });
  if (s.mode === "region" && s.environment && target === "content" && ["MEASURE", "SCROLL"].includes(type)) {
    response.tabZoom = await chrome.tabs.getZoom(s.tab.id);
    check(s);
  }
  return response;
}

async function finish(s, error) {
  if (s.finishing || active !== s) return;
  s.finishing = true;
  clearInterval(s.heartbeat);
  if (s.downloadId) await chrome.downloads.cancel(s.downloadId).catch(() => {});
  const finished = await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "FINISH", id: s.id, diagnosticContext: { attempt: s.attempt, frames: s.frames } }, { frameId: 0 }).catch(() => {});
  if (finished?.fullProof) s.fullProofDiagnostics = finished.fullProof;
  if (s.offscreen) {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "CLOSE", id: s.id }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  lastStatus = { id: s.id, tabId: s.tab.id, busy: false, frames: s.frames, parts: s.parts, result: s.result, results: s.results,
    metrics: { ...s.metrics, totalMs: Date.now() - s.started },
    ...(s.mode === "full" ? { attempt: s.attempt || 1, reasonCode: error?.reasonCode, diagnostics: { ...s.full, warmup: s.warmup || null, continuityPolicy: s.continuityPolicy, fullProof: s.fullProofDiagnostics ? { ...s.fullProofDiagnostics, trigger: error?.fullProofTrigger || s.fullProofDiagnostics.trigger } : null, terminationReason: error ? error.reasonCode || "CAPTURE_FAILED" : "BOTTOM_QUIESCENT" } } : {}),
    ...(s.mode === "region" ? { reasonCode: error ? error.reasonCode || "CAPTURE_FAILED" : undefined,
      attempt: s.attempt || 1, diagnostics: { ...s.diagnostics, ...error?.diagnostics } } : {}),
    state: error ? (s.cancelled ? "cancelled" : "failed") : "complete",
    message: error ? error.message : `截图完成，已保存 ${s.parts || 1} 张 PNG。` };
  await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "PROGRESS", id: s.id, status: lastStatus }, { frameId: 0 }).catch(() => {});
  try { await chrome.storage.session.set({ status: lastStatus }); }
  finally { if (active === s) active = null; }
}

async function start(mode, output = "auto", continuityPolicy = "robust") {
  if (!["auto", "css", "75", "50", "device"].includes(output)) throw new Error("未知输出尺寸。");
  if (!["full", "region"].includes(mode)) throw new Error("未知截图模式。");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):\/\//.test(tab.url || "")) throw new Error("请在普通网页中使用；浏览器内部页面不支持截图。");
  if (active) throw new Error("已有截图任务，请先取消或等待完成。");
  const s = { id: crypto.randomUUID(), tab, mode, output, metrics: { captures: 0, settles: 0, encodeMs: 0, saveMs: 0, retries: 0, frameRetries: 0, filenameFallbacks: 0 }, started: Date.now(), frames: 0, parts: 0, cancelled: false };
  if (mode === "full") s.continuityPolicy = continuityPolicy === "strict" ? "strict" : "robust";
  active = s;
  try {
    await status(s, "preparing", "正在准备页面…");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await request(s, "content", "BEGIN", { mode });
    s.heartbeat = setInterval(() => {
      request(s, "content", "TOUCH").catch(error => {
        s.cancelled = true; s.reason = error.message;
        if (s.state === "selecting") void finish(s, error);
      });
    }, 10_000);
    if (mode === "region") await status(s, "selecting", "请在页面上选择区域；Esc 可取消。");
    else void run(s);
    return { id: s.id };
  } catch (error) { await finish(s, error); throw error; }
}

async function ensureVisible(s) {
  check(s);
  const [tab] = await chrome.tabs.query({ active: true, windowId: s.tab.windowId });
  if (tab?.id !== s.tab.id) throw Object.assign(new Error("截图页面已切换，请保持目标标签页在前台。"), { reasonCode: "TARGET_TAB_CHANGED" });
  if (s.mode === "region" && s.environment) {
    const tabZoom = await chrome.tabs.getZoom(s.tab.id);
    validateEnvironment(s, { ...s.lastView, tabZoom, tabId: tab.id });
  }
}

const REGION_EPSILON = 0.5;
const near = (a, b, epsilon = REGION_EPSILON) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;

function validateView(s, view) {
  if (s.mode === "full" && s.warming) {
    if (["innerWidth", "innerHeight", "dpr", "visualScale"].some(key => view[key] !== s.viewport[key]) || view.visualScale !== 1) {
      throw Object.assign(new Error("预加载期间视口或缩放已改变，请保持窗口尺寸与缩放不变。"), { reasonCode: "CAPTURE_ENV_CHANGED" });
    }
    return;
  }
  if (s.mode === "region") {
    s.lastView = view;
    validateEnvironment(s, { ...view, tabZoom: view.tabZoom ?? s.environment.tabZoom, tabId: s.tab.id });
    if (view.targetKind === "element" && s.targetViewport &&
        (view.clientWidth !== s.targetViewport.width || view.clientHeight !== s.targetViewport.height)) {
      throw Object.assign(new Error("滚动容器尺寸发生变化，正在重新截图。"), { layout: true, reasonCode: "TARGET_RESIZED" });
    }
    validateRegion(s, view);
    return;
  }
  if (s.viewport.targetKind === "element") {
    if (["innerWidth", "innerHeight", "dpr", "visualScale"].some(key => view[key] !== s.viewport[key])) {
      throw new Error("视口或缩放已改变，请保持窗口尺寸与缩放不变。");
    }
    if (view.clientWidth !== s.viewport.clientWidth || view.clientHeight !== s.viewport.clientHeight) {
      throw Object.assign(new Error("滚动容器可见区域尺寸发生变化，正在重新截图。"), { layout: true, reasonCode: "TARGET_RESIZED" });
    }
    return;
  }
  if (!sameViewport(s.viewport, view) || view.visualScale !== 1) throw new Error("视口或缩放已改变，请保持窗口尺寸与缩放不变。");
  // Full Page is vertical-only. document/target scrollWidth is diagnostic only;
  // it no longer defines capture Scope or invalidates a vertical capture.
}

function validateEnvironment(s, actual) {
  const expected = s.environment;
  s.diagnostics = { ...s.diagnostics, environment: { baseline: expected, actual } };
  for (const field of ["innerWidth", "innerHeight", "tabZoom", "visualScale", "tabId"]) {
    const epsilon = ["tabZoom", "visualScale"].includes(field) ? 0.0001 : 0;
    if (!Number.isFinite(actual[field]) || Math.abs(expected[field] - actual[field]) > epsilon) {
      throw Object.assign(new Error(`CAPTURE_ENV_CHANGED: ${field} ${expected[field]} -> ${actual[field]}`), {
        reasonCode: "CAPTURE_ENV_CHANGED", diagnostics: { ...s.diagnostics, delta: { field, expected: expected[field], actual: actual[field] } }
      });
    }
  }
}

function validateRegion(s, page) {
  s.diagnostics = { ...s.diagnostics, anchors: page.anchors, region: { before: s.region, current: page.region } };
  if (s.region && page.region && (!near(page.region.width, s.region.width) ||
      !near(page.region.height, s.region.height))) {
    throw Object.assign(new Error("所选区域尺寸发生明显变化，正在重新建立截图基线。"), {
      layout: true, reasonCode: "REGION_REFLOW", diagnostics: s.diagnostics
    });
  }
}

// Stitch in the attempt's coordinate system even when the real document moves.
function relativeView(s, view) {
  if (s.mode !== "region") return view;
  return { ...view, x: s.region.x, y: view.y - view.region.y + s.region.y,
    cropLeft: s.regionCropLeft };
}

async function scroll(s, x, y) {
  s.scrollTarget = { x, y };
  s.metrics.settles++;
  await status(s, s.frames ? "capturing" : "loading", s.warming
    ? `正在预加载页面内容 · 已滚动 ${s.warmup?.steps || 0} 步…`
    : `正在等待当前内容稳定 / 加载 · 已处理 ${s.frames} 帧…`);
  await ensureVisible(s);
  if (s.mode === "region") await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  const view = await request(s, "content", "SCROLL", s.mode === "region"
    ? { x: 0, y: y - s.region.y, relative: true }
    : { x: Math.floor(x), y: Math.floor(y) });
  validateView(s, view);
  return view;
}


const WARMUP_MAX_STEPS = 24;
const WARMUP_MAX_MS = 15_000;
const WARMUP_MAX_GROWTHS = 6;

async function warmupFull(s, initialView) {
  const started = Date.now();
  const captureX = initialView.x;
  s.fullCaptureX = captureX;
  const d = s.warmup = { steps: 0, growthEvents: 0, initialHeight: initialView.height,
    maxObservedHeight: initialView.height, finalHeight: initialView.height,
    captureX, visibleWidth: initialView.clientWidth, reportedWidth: initialView.width,
    completed: false, stopReason: null, durationMs: 0 };
  let view = initialView, warmupError;
  s.warming = true;
  try {
    view = await scroll(s, captureX, 0);
    d.initialHeight = view.height;
    d.maxObservedHeight = view.height;
    let y = view.y;
    const maxHeight = Math.max(view.height * 2, view.height + view.clientHeight * 4);
    while (d.steps < WARMUP_MAX_STEPS && Date.now() - started < WARMUP_MAX_MS) {
      check(s);
      const maxY = Math.max(0, view.height - view.clientHeight);
      if (maxY <= 0.5) { d.completed = true; d.stopReason = "single-viewport"; break; }
      const nextY = Math.min(maxY, y + Math.max(320, Math.floor(view.clientHeight * 0.9)));
      const beforeHeight = view.height;
      view = await scroll(s, captureX, nextY);
      d.steps++;
      if (view.height > d.maxObservedHeight + 0.5) d.growthEvents++;
      d.maxObservedHeight = Math.max(d.maxObservedHeight, view.height);
      y = view.y;
      if (view.height > maxHeight || d.growthEvents > WARMUP_MAX_GROWTHS) {
        d.stopReason = "growth-budget"; break;
      }
      if (Math.abs(y - maxY) <= 0.5) {
        if (view.height <= beforeHeight + 0.5) {
          d.completed = true; d.stopReason = "bottom-stable"; break;
        }
      }
    }
    if (!d.stopReason) d.stopReason = d.steps >= WARMUP_MAX_STEPS ? "step-budget" : "time-budget";
  } catch (error) {
    warmupError = error;
    // Warmup is discovery, not capture truth. A page that never settles during
    // pre-scroll may still be capturable frame-by-frame. Environment/target and
    // cancellation errors remain fatal.
    if (s.cancelled || ["TARGET_TAB_CHANGED", "TARGET_TAB_CLOSED", "TARGET_TAB_NAVIGATED",
        "CAPTURE_ENV_CHANGED", "TARGET_UNRESOLVABLE"].includes(error.reasonCode)) {
      s.warming = false;
      throw error;
    }
    d.stopReason = error.reasonCode === "FRAME_NOT_SETTLED" ? "settle-budget" : "warmup-recoverable-error";
  }
  let top;
  try {
    // Keep warmup validation rules until we are back at the start. The caller
    // then adopts this fresh top-of-target view as the formal capture baseline.
    top = await scroll(s, captureX, 0);
  } finally {
    s.warming = false;
  }
  s.fullCaptureX = top.x;
  d.captureX = top.x;
  d.visibleWidth = top.clientWidth;
  d.reportedWidth = top.width;
  d.finalHeight = top.height;
  d.maxObservedHeight = Math.max(d.maxObservedHeight, top.height);
  d.durationMs = Date.now() - started;
  if (warmupError) d.lastErrorReason = warmupError.reasonCode || "WARMUP_RECOVERABLE";
  return top;
}

function recoveryBacktrackCSS(height) {
  // The retained previous strip contains normal overlap plus the matcher search
  // margins/rows. On the final retry, use that already-retained context instead
  // of lowering matching thresholds or allocating more history.
  return Math.min(Math.max(0, height - 32), 2 * VISUAL.radius + VISUAL.rows);
}

async function scrollFullRecoverable(s, x, y) {
  for (let sample = 0; sample < 3; sample++) {
    try { return await scroll(s, x, y); }
    catch (error) {
      // Full Page pending witnesses are advisory. content.js clears the stale
      // pending baseline before reporting FRAME_MOVED; repeat the uncommitted
      // scroll checkpoint and let visual continuity judge the captured pixels.
      if (!error.translation || error.reasonCode !== "FRAME_MOVED" || sample === 2) throw error;
      s.metrics.frameRetries++;
    }
  }
}

async function capture(s, view) {
  const target = s.scrollTarget;
  for (let sample = 0; sample < 3; sample++) {
    try { return { view, dataUrl: await captureOnce(s, view) }; }
    catch (error) {
      if (!error.translation || sample === 2) throw error;
      // Only this uncommitted frame moved; keep already verified canvas pixels.
      s.metrics.frameRetries++;
      view = s.mode === "full"
        ? await scrollFullRecoverable(s, target.x, target.y)
        : await scroll(s, target.x, target.y);
      if (s.mode === "full" && !s.frames) {
        s.fullCaptureX = view.x;
        s.region = { x: view.x, y: 0, width: view.clientWidth, height: view.height };
        s.full.end = view.height;
        s.full.maxObservedHeight = Math.max(s.full.maxObservedHeight, view.height);
      }
    }
  }
}

async function captureOnce(s, view) {
  // Chrome allows at most two captureVisibleTab calls per second.
  await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  await ensureVisible(s);
  await request(s, "content", "HIDE_UI");
  try {
    let fullBefore;
    if (s.mode === "full") {
      const before = await request(s, "content", "MEASURE", { watch: true });
      validateView(s, before);
      fullBefore = before;
      if (before.x !== view.x || before.y !== view.y || before.viewportRect?.left !== view.viewportRect?.left || before.viewportRect?.top !== view.viewportRect?.top) {
        throw Object.assign(new Error("当前帧位置变化，正在重新采样。"), { translation: true });
      }
    }
    let regionBefore;
    if (s.mode === "region") {
      regionBefore = await request(s, "content", "MEASURE");
      validateView(s, regionBefore);
      const rebased = !near(regionBefore.region.x, view.region.x) || !near(regionBefore.region.y, view.region.y) ||
        !near(regionBefore.viewportRect?.left || 0, view.viewportRect?.left || 0) ||
        !near(regionBefore.viewportRect?.top || 0, view.viewportRect?.top || 0);
      if (rebased) {
        s.diagnostics = { ...s.diagnostics, regionRebases: (s.diagnostics?.regionRebases || 0) + 1 };
        Object.assign(view, regionBefore);
      }
    }
    lastCapture = Date.now();
    s.metrics.captures++;
    const dataUrl = await chrome.tabs.captureVisibleTab(s.tab.windowId, { format: "png" });
    await ensureVisible(s);
    const after = await request(s, "content", "MEASURE");
    validateView(s, after);
    if (s.mode === "full") {
      s.captureExtentStable = terminalNear(fullBefore.height, view.height) && terminalNear(after.height, view.height);
      await extendEnd(s, after);
    }
    if (s.mode === "region") {
      const scrollMovedDuringCapture = regionBefore && (!near(after.x, regionBefore.x) || !near(after.y, regionBefore.y));
      if (scrollMovedDuringCapture) {
        throw Object.assign(new Error("截图时滚动位置发生变化，请重试。"), { reasonCode: "FRAME_MOVED" });
      }
      const translatedDuringCapture = regionBefore && (!near(after.region.x, regionBefore.region.x) ||
        !near(after.region.y, regionBefore.region.y) ||
        !near(after.viewportRect?.left || 0, regionBefore.viewportRect?.left || 0) ||
        !near(after.viewportRect?.top || 0, regionBefore.viewportRect?.top || 0));
      if (translatedDuringCapture) {
        s.diagnostics = { ...s.diagnostics, regionCaptureRebases: (s.diagnostics?.regionCaptureRebases || 0) + 1 };
        Object.assign(view, after);
      }
    }
    if (s.mode === "full" && (!near(after.x, view.x) || !near(after.y, view.y))) {
      throw Object.assign(new Error("截图时滚动位置发生变化，请重试。"), { translation: true, reasonCode: "FRAME_MOVED" });
    }
    return dataUrl;
  } finally {
    await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "SHOW_UI", id: s.id }, { frameId: 0 }).catch(() => {});
  }
}

async function extendEnd(s, view) {
  if (Number.isFinite(s.terminalExtent) && terminalNear(view.height, s.terminalExtent)) {
    s.full.maxObservedHeight = Math.max(s.full.maxObservedHeight, view.height);
    return;
  }
  if (!s.frames && !s.offscreen && view.height < s.full.end) {
    s.full.end = view.height;
    s.region = { ...s.region, height: view.height };
    return;
  }
  if (!adaptiveEnd(s.full, view.height, view.clientHeight)) return;
  s.region = { ...s.region, height: s.full.end };
  if (s.offscreen) s.outputSize = await request(s, "offscreen", "EXTEND", { region: s.region });
}

async function bottomQuiescence(s, anchorView, report) {
  // Four stable 200ms observations; visible lazy images must also be ready.
  // Terminal checks tolerate <=1 CSS px measurement jitter only when an
  // anchorView is supplied; ordinary bottom discovery keeps existing behavior.
  const started = Date.now();
  s.full.bottomStableSamples = 0;
  while (Date.now() - started < 3000) {
    await delay(200);
    await ensureVisible(s);
    const view = await request(s, "content", "BOTTOM").catch(error => {
      if (anchorView && error.translation) return null;
      throw error;
    });
    if (!view) {
      if (report) Object.assign(report, { reason: "quiescence-translation" });
      return false;
    }
    validateView(s, view);
    const previous = s.full.end;
    await extendEnd(s, view);
    if (s.full.end > previous) {
      if (report) Object.assign(report, { reason: "quiescence-growth", previousExtent: previous, observedExtent: s.full.end });
      return false;
    }
    if (anchorView) {
      const targetExtent = Number.isFinite(s.terminalExtent) ? s.terminalExtent : s.full.end;
      if (!terminalNear(view.height, anchorView.height) ||
          !terminalNear(view.y, anchorView.y) ||
          !terminalNear(view.y + view.clientHeight, targetExtent)) {
        if (report) Object.assign(report, {
          reason: "quiescence-drift",
          targetExtent,
          observedHeight: view.height,
          anchorHeight: anchorView.height,
          observedY: view.y,
          anchorY: anchorView.y,
          visibleBottom: view.y + view.clientHeight,
          epsilon: TERMINAL_GEOMETRY_EPSILON
        });
        return false;
      }
    }
    s.full.bottomStableSamples = view.loading ? 0 : s.full.bottomStableSamples + 1;
    if (s.full.bottomStableSamples >= 4) return true;
  }
  throw Object.assign(new Error("页面底部仍在加载，请稍后重试或改用选择区域。"), { reasonCode: "BOTTOM_NOT_QUIESCENT" });
}

function recordBottomTailReject(s, reason, details = {}, retry = 0) {
  if (!reason) return;
  const d = s.full.visual;
  d.bottomTailRejectReasons[reason] = (d.bottomTailRejectReasons[reason] || 0) + 1;
  d.bottomTailRejectTrace.push({ reason, frame: s.frames, retry, ...details });
  if (d.bottomTailRejectTrace.length > 30) d.bottomTailRejectTrace.shift();
}

function recordVisual(s, match, retry) {
  if (!match) return;
  const d = s.full.visual;
  d.visualChecks++;
  if (match.zones) d.strictCoverageChecks++;
  if (match.result === "strict-coverage-failed") d.strictCoverageFailures++;
  if (match.continuity === "probable") d.probablePlacements++;
  if (match.fallbackMethod === "geometry") d.geometryFallbacks++;
  if (match.fallbackMethod === "probable-visual") d.probableVisualCorrections++;
  if (match.fallbackMethod === "probable-score") d.probableScoreCorrections++;
  if (match.fallbackMethod === "geometry-score") d.geometryScoreFallbacks++;
  if (match.matchMode === "subject-core") {
    d.subjectCorePlacements++;
    if (match.volatileEdges?.includes("left")) d.leftEdgeVolatileFrames++;
    if (match.volatileEdges?.includes("right")) d.rightEdgeVolatileFrames++;
  }
  if (match.failureReason === "insufficient-quality") d.insufficientQualityRejects++;
  if (["width-mismatch", "insufficient-overlap"].includes(match.failureReason)) d.structuralVisualRejects++;
  if (retry) d.visualRecoveryRetries++;
  if (match.result === 'matched') {
    if (match.path === 'fast' && !retry) d.visualFastPath++;
    else d.visualRecoveries++;
  } else {
    if (match.result === 'ambiguous') d.ambiguousMatches++;
    if (match.result === 'low-information') d.lowInformationRejects++;
  }
  d.trace.push({ ...match, frame: s.frames, retry });
  if (d.trace.length > 150) d.trace.shift();
}

async function captureFull(s, view, dataUrl) {
  s.full.visual ||= { continuityPolicy: s.continuityPolicy, strictCoverageChecks: 0, strictCoverageFailures: 0, visualChecks: 0, visualFastPath: 0, visualRecoveries: 0,
    visualRecoveryRetries: 0, visualFailures: 0, ambiguousMatches: 0, lowInformationRejects: 0,
    probablePlacements: 0, geometryFallbacks: 0, probableVisualCorrections: 0, probableScoreCorrections: 0,
    geometryScoreFallbacks: 0, subjectCorePlacements: 0, leftEdgeVolatileFrames: 0, rightEdgeVolatileFrames: 0,
    insufficientQualityRejects: 0, structuralVisualRejects: 0,
    bottomTailChecks: 0, bottomTailAccepted: 0, bottomTailRejected: 0,
    bottomTailRejectReasons: {}, bottomTailRejectTrace: [], trace: [] };
  let documentBottom = 0, nextY = 0;
  const x = s.region.x;
  while (true) {
    if (documentBottom >= s.full.end - 0.01 && await bottomQuiescence(s)) break;
    for (let retry = 0; retry < 3; retry++) {
      if (s.metrics.captures >= MAX_STEPS) throw new Error("截图超过 1000 帧，请缩小选区。");
      if (!dataUrl) {
        // Full Page is vertical-only: preserve the initially visible horizontal
        // slice and change only y. The final retry increases vertical overlap.
        const y = retry === 2 ? Math.max(0, nextY - recoveryBacktrackCSS(view.clientHeight)) : nextY;
        view = await scrollFullRecoverable(s, x, y);
        await extendEnd(s, view);
        ({ view, dataUrl } = await capture(s, view));
      }
      const counters = s.fullProofDiagnostics?.counters;
      const evidence = (counters?.witnessMoved || 0) + (counters?.witnessResized || 0) + (counters?.witnessRemoved || 0);
      let result = await request(s, "offscreen", "FULL_FRAME", { view, dataUrl, x,
        uncertain: retry > 0 || evidence !== (s.visualEvidence || 0) || view.height !== s.visualHeight,
        robustFallbackMode: s.continuityPolicy === "strict" ? null : retry === 1 ? "score" : retry === 2 ? "all" : null,
        firstColumn: true });
      dataUrl = null;
      recordVisual(s, result.visual, retry);
      if (!result.accepted && s.continuityPolicy !== "strict") {
          const d = s.full.visual;
          d.bottomTailChecks++;
          d.bottomTailRejected++;
          let rejectRecorded = false;
          const reject = (reason, details = {}) => {
            if (rejectRecorded) return;
            rejectRecorded = true;
            recordBottomTailReject(s, reason, details, retry);
          };
          const decision = assessBottomTail(view, result.canonicalEnd, s.full.end);
          if (!decision.anchor) {
            reject(decision.reason, decision.details);
          } else {
            const quiescence = {};
            s.terminalExtent = s.full.end;
            try {
              if (await bottomQuiescence(s, view, quiescence)) {
                const stableExtent = s.full.end;
                const confirmed = assessBottomTail(view, result.canonicalEnd, stableExtent);
                if (!confirmed.anchor) {
                  reject("post-quiescence-" + confirmed.reason, confirmed.details);
                } else {
                  // The rejected bitmap predates quiescence. Capture again, and
                  // let visual registration win before authorizing the tail.
                  if (s.metrics.captures >= MAX_STEPS) throw new Error("截图超过 1000 帧，请缩小选区。");
                  view = await scrollFullRecoverable(s, x, view.y);
                  await extendEnd(s, view);
                  ({ view, dataUrl } = await capture(s, view));
                  const after = await request(s, "content", "BOTTOM").catch(error => {
                    if (error.translation) return null;
                    throw error;
                  });
                  if (after) { validateView(s, after); await extendEnd(s, after); }
                  const freshDecision = assessBottomTail(view, result.canonicalEnd, stableExtent);
                  const afterDecision = after ? assessBottomTail(after, result.canonicalEnd, stableExtent)
                    : { anchor: null, reason: "post-capture-translation", details: {} };
                  const stable = s.captureExtentStable && s.full.end === stableExtent && after && !after.loading &&
                    terminalNear(after.height, view.height) && terminalNear(after.y, view.y) && after.x === view.x &&
                    !!freshDecision.anchor && !!afterDecision.anchor;
                  if (!stable) {
                    reject("fresh-capture-unstable", {
                      stableExtent,
                      captureExtentStable: s.captureExtentStable,
                      freshReason: freshDecision.reason,
                      afterReason: afterDecision.reason,
                      viewHeight: view.height,
                      afterHeight: after?.height,
                      viewY: view.y,
                      afterY: after?.y,
                      visibleBottom: after ? after.y + after.clientHeight : null,
                      epsilon: TERMINAL_GEOMETRY_EPSILON
                    });
                  }
                  result = await request(s, "offscreen", "FULL_FRAME", { view, dataUrl, x, firstColumn: true,
                    uncertain: true, bottomExtent: stable ? stableExtent : undefined });
                  dataUrl = null;
                  recordVisual(s, result.visual, retry);
                  if (result.bottomTailReject) reject("offscreen-" + result.bottomTailReject.reason, result.bottomTailReject.details);
                  if (result.accepted && !result.bottomTail && !rejectRecorded) reject("visual-recovered", { stableExtent });
                }
              } else {
                reject(quiescence.reason || "quiescence-rejected", quiescence);
              }
            } finally {
              delete s.terminalExtent;
            }
          }
          if (result.bottomTail) {
            d.bottomTailAccepted++;
            d.bottomTailRejected--;
            d.trace.push({ event: "bottom-tail-anchored", result: "BOTTOM_ANCHORED_TAIL",
              visualResult: result.visual.result, ...result.bottomTail, frame: s.frames });
            if (d.trace.length > 150) d.trace.shift();
          }
        }
        if (!result.accepted) {
          if (retry < 2) continue;
          s.full.visual.visualFailures++;
          const strictCoverageFailed = s.continuityPolicy === "strict" && result.visual?.result === "strict-coverage-failed";
          throw Object.assign(new Error(strictCoverageFailed
            ? "全宽严格模式下无法确认部分区域连续。可等待页面稳定后重试，或改用“智能容错”。"
            : "无法可靠对齐相邻截图，请等待页面稳定后重试。"), { reasonCode: "VISUAL_CONTINUITY_FAILED" });
        }
      s.visualEvidence = evidence;
      s.visualHeight = view.height;
      s.frames++;
      await request(s, "content", "FULL_COMMIT", { rect: { x, y: view.y + result.novelTop - result.canonicalY,
        right: result.right, bottom: Math.min(view.height, view.y + view.clientHeight) } });
      documentBottom = Math.min(view.height, view.y + view.clientHeight);
      await status(s, "capturing", `正在截图 ${Math.min(100, Math.floor(documentBottom / s.full.end * 100))}% · ${s.frames} 帧`);
      break;
    }
    nextY = documentBottom - overlapCSS(view.clientHeight);
  }
  s.outputSize = await request(s, "offscreen", "FULL_FINALIZE");
}


function utf8CodePointBytes(char) {
  const code = char.codePointAt(0);
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
}

function safeTitle(raw, maxBytes = 160) {
  let value = String(raw || "page");
  try { value = value.normalize("NFKC"); } catch { /* normalization is optional */ }
  value = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "-")
    .replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "");
  let bytes = 0, out = "";
  for (const char of value) {
    const size = utf8CodePointBytes(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out.replace(/[. ]+$/g, "") || "page";
}

function suggestedFilename(stamp, title) {
  return `LongScreenshot/${stamp}-${safeTitle(title)}.png`;
}

async function saveImage(s, part, index, count) {
  await status(s, "saving", count > 1
    ? `正在保存第 ${index + 1}/${count} 张，若弹出保存窗口请选择位置…`
    : "正在保存，若弹出保存窗口请选择位置…");
  check(s);
  const suffix = count > 1 ? `-${String(index + 1).padStart(2, "0")}-of-${String(count).padStart(2, "0")}` : "";
  const filename = `LongScreenshot/${s.stamp}-${safeTitle(s.tab.title)}${suffix}.png`;
  try {
    s.downloadId = await chrome.downloads.download({ url: part.url, filename });
  } catch (error) {
    if (!/invalid filename/i.test(error?.message || "")) throw error;
    s.metrics.filenameFallbacks++;
    s.downloadId = await chrome.downloads.download({ url: part.url,
      filename: `LongScreenshot/${s.stamp}-capture${suffix}.png` });
  }
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    check(s);
    const [item] = await chrome.downloads.search({ id: s.downloadId });
    if (!item || item.state === "interrupted") throw new Error(`下载失败：${item?.error || "记录不存在"}`);
    if (item.state === "complete") {
      const result = { downloadId: item.id, filename: item.filename, width: part.width, height: part.height,
        bytes: item.fileSize, index, count };
      s.downloadId = null; s.parts++; return result;
    }
    await delay(250);
  }
  throw new Error("下载超过两分钟，请检查浏览器下载设置。");
}

async function run(s) {
  try {
    await status(s, "preparing", "正在准备截图…");
    s.viewport = await request(s, "content", "PREPARE", { edges: s.edges });
    if (s.mode === "region") {
      s.environment = { ...s.viewport, tabZoom: await chrome.tabs.getZoom(s.tab.id), tabId: s.tab.id };
      s.lastView = s.viewport;
    }
    if (s.mode === "full" && (s.viewport.visualScale !== 1 || s.viewport.clientHeight < 64 || s.viewport.clientWidth < 64)) throw new Error("请恢复触控缩放并增大浏览器窗口。");
    if (s.mode === "region" && Math.abs(s.viewport.visualScale - 1) > 0.0001) {
      throw Object.assign(new Error(`CAPTURE_ENV_UNSUPPORTED: visualScale ${s.viewport.visualScale}，请恢复触控缩放。`), {
        reasonCode: "CAPTURE_ENV_UNSUPPORTED", diagnostics: { environment: { baseline: s.environment, actual: s.environment } }
      });
    }
    if (s.mode === "full") s.viewport = { ...s.viewport, ...(await warmupFull(s, s.viewport)) };
    for (let attempt = 0; attempt < 2; attempt++) {
      s.attempt = attempt + 1;
      try {
        let view, dataUrl;
        if (s.mode === "region") {
          if (attempt) {
            s.metrics.retries++;
            await status(s, "loading", "所选内容发生变化，正在重新截图…");
          }
          // The final UI edge values are the user's selected visual Scope. PREPARE
          // may normalize layout, but anchors must not rewrite these coordinates.
          for (let sample = 0; sample < 3; sample++) {
            try {
              s.targetViewport = { width: s.viewport.clientWidth, height: s.viewport.clientHeight };
              const selected = verticalRegionFromViewportEdges(s.edges, s.viewport);
              s.regionCropLeft = selected.cropLeft;
              s.region = { x: selected.x, y: selected.y, width: selected.width, height: selected.height };
              s.diagnostics = { ...s.diagnostics, regionViewport: {
                left: selected.cropLeft, right: selected.cropRight, width: selected.width,
                targetViewportLeft: s.viewport.viewportRect?.left || 0, targetKind: s.viewport.targetKind
              } };
              await request(s, "content", "REGION_FREEZE", { region: s.region, cropLeft: s.regionCropLeft });
              view = await scroll(s, s.region.x, s.region.y);
              outputGeometry(s.region, view, { width: view.innerWidth, height: view.innerHeight }, s.output === "device" ? "auto" : s.output);
              ({ view, dataUrl } = await capture(s, view));
              break;
            } catch (error) {
              if (!error.layout || sample === 2 || attempt) throw error;
              s.metrics.frameRetries++;
            }
          }
        } else {
          if (attempt) s.metrics.retries++;
          for (let sample = 0; sample < 3; sample++) {
            try {
              const reset = await request(s, "content", "FULL_RESET", { rebase: sample > 0 });
              s.viewport = { ...s.viewport, clientWidth: reset.clientWidth, clientHeight: reset.clientHeight };
              view = await scroll(s, s.fullCaptureX ?? reset.x, 0);
              s.fullCaptureX = view.x;
              s.region = { x: view.x, y: 0, width: view.clientWidth, height: view.height };
              s.full ||= { initialHeight: view.height, maxObservedHeight: view.height, endExtensions: 0, bottomStableSamples: 0 };
              s.full.end = view.height;
              s.full.fullPageRestarts = attempt;
              s.full.targetKind = view.targetKind;
              s.full.horizontal = { mode: "viewport-slice", x: view.x, visibleWidth: view.clientWidth, reportedWidth: view.width };
              s.full.maxObservedHeight = Math.max(s.full.maxObservedHeight, view.height);
              const estimated = s.output === "device" ? view.dpr : 1;
              outputGeometry(s.region, view, { width: view.innerWidth * estimated, height: view.innerHeight * estimated }, s.output);
              ({ view, dataUrl } = await capture(s, view));
              break;
            } catch (error) {
              if (!error.layout) throw error;
              if (sample === 2) throw Object.assign(new Error("首帧布局持续变化，请稍后重试。"), { reasonCode: "FRAME_NOT_SETTLED" });
              s.metrics.frameRetries++;
            }
          }
        }
        // Reject impossible fixed sizes before the first screenshot. Device scale
        // is checked again against the actual first bitmap (not emulated DPR).
        const estimatedSource = s.mode === "full" && s.output === "device" ? view.dpr : 1;
        outputGeometry(s.region, view, { width: view.innerWidth * estimatedSource,
          height: view.innerHeight * estimatedSource }, s.mode === "region" && s.output === "device" ? "auto" : s.output);
        if (!dataUrl) ({ view, dataUrl } = await capture(s, view));
        s.offscreen = true;
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (contexts.length) await chrome.offscreen.closeDocument();
        await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Incrementally stitch frames into one bounded PNG." });
        const scale = await request(s, "offscreen", "OPEN", { region: s.region, view: relativeView(s, view), dataUrl, output: s.output, ...(s.mode === "full" ? { continuityPolicy: s.continuityPolicy } : {}) });
        s.outputSize = scale;
        await request(s, "offscreen", "PART", { start: 0, height: scale.partHeight });
        if (s.mode === "full") {
          const captureTask = captureFull(s, view, dataUrl);
          dataUrl = null;
          await captureTask;
        } else {
          let y = s.region.y;
          while (true) {
            if (y >= s.region.y + s.region.height - 0.0001) {
              break;
            }
            let x = s.region.x, bandBottom;
            while (x < s.region.x + s.region.width - 0.0001) {
              if (s.metrics.captures >= MAX_STEPS) throw new Error("截图超过 1000 帧，请缩小选区。");
              if (!dataUrl) {
                view = await scroll(s, x, y);
                ({ view, dataUrl } = await capture(s, view));
              }
              const tileView = relativeView(s, view);
              const rect = visibleTile(s.region, tileView, x, y, bandBottom);
              bandBottom = rect.bottom;
              await request(s, "offscreen", "FRAME", { view: tileView, rect, dataUrl });
              dataUrl = null;
              s.frames++;
              x = rect.right;
              const done = (y - s.region.y) * s.region.width + (rect.bottom - y) * (x - s.region.x);
              await status(s, "capturing", `正在截图 ${Math.min(100, Math.floor(done / (s.region.width * s.region.height) * 100))}% · ${s.frames} 帧`);
            }
            y = bandBottom;
          }
        }
        if (s.mode === "region") {
          await ensureVisible(s);
          validateView(s, await request(s, "content", "MEASURE"));
        }
        await status(s, "encoding", s.outputSize.partCount > 1
          ? `正在生成 ${s.outputSize.partCount} 张图片 · ${s.outputSize.width} × ${s.outputSize.height} 总像素…`
          : `正在生成图片 · ${s.outputSize.width} × ${s.outputSize.height} 像素…`);
        const encodeStart = Date.now();
        const exported = await request(s, "offscreen", "EXPORT");
        s.metrics.encodeMs += Date.now() - encodeStart;
        s.stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const saveStart = Date.now();
        s.results = [];
        for (const part of exported.parts) s.results.push(await saveImage(s, part, part.index, part.count));
        s.result = s.results[0];
        s.metrics.saveMs += Date.now() - saveStart;
        await request(s, "offscreen", "RELEASE", { final: true });
        break;
      } catch (error) {
        if (!error.layout || attempt || s.cancelled) throw error;
        if (s.offscreen) {
          await request(s, "offscreen", "CLOSE");
          await chrome.offscreen.closeDocument();
          s.offscreen = false;
        }
        s.frames = 0;
      }
    }
    await finish(s);
  } catch (error) { await finish(s, error); }
}

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m?.target !== "background" || sender.id !== chrome.runtime.id) return;
  (async () => {
    await ready;
    const fromPopup = sender.url === chrome.runtime.getURL("popup.html");
    if (m.type === "STATUS") return lastStatus;
    if (m.type === "START" && fromPopup) return start(m.mode, m.output, m.continuityPolicy);
    if (m.type === "SHOW") {
      if (m.id !== lastStatus.id || !lastStatus.result || (!fromPopup && (sender.tab?.id !== lastStatus.tabId || sender.frameId !== 0))) throw new Error("过期的截图结果。");
      await chrome.downloads.show(lastStatus.result.downloadId);
      return {};
    }
    const s = active;
    if (!s || s.id !== m.id || (!fromPopup && (sender.tab?.id !== s.tab.id || sender.frameId !== 0))) throw new Error("过期的截图任务。");
    if (m.type === "CANCEL") {
      s.cancelled = true;
      if (s.state === "selecting") await finish(s, new Error("截图已取消。"));
      return {};
    }
    if (m.type === "REGION" && s.state === "selecting" && sender.tab && !fromPopup) {
      // Claim the selection before awaiting so duplicate submissions cannot run twice.
      try {
        await status(s, "preparing", "正在复核选区…");
        // Resolve content anchors inside run's bounded Attempt, after prepare.
        const page = await request(s, "content", "MEASURE", { viewportOnly: true });
        if (!page.anchored) regionFromEdges(m.edges, page);
        s.edges = m.edges;
        void run(s);
        return {};
      } catch (error) { await finish(s, error); throw error; }
    }
    throw new Error("当前任务不接受此操作。");
  })().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onActivated.addListener(info => {
  if (active && active.state !== "selecting" && info.windowId === active.tab.windowId && info.tabId !== active.tab.id) {
    active.cancelled = true; active.reasonCode = "TARGET_TAB_CHANGED"; active.reason = "目标标签页已切换，截图已停止。";
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (active?.tab.id === tabId) {
    active.cancelled = true; active.reasonCode = "TARGET_TAB_CLOSED"; active.reason = "目标标签页已关闭。";
    if (active.state === "selecting") void finish(active, new Error(active.reason));
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (active?.tab.id === tabId && change.status === "loading") {
    active.cancelled = true; active.reasonCode = "TARGET_TAB_NAVIGATED"; active.reason = "目标页面已导航或刷新，截图已停止。";
    if (active.state === "selecting") void finish(active, new Error(active.reason));
  }
});
