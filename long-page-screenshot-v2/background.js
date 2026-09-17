import { regionFromEdges, outputGeometry, sameViewport } from "./capture/geometry.js";
import { visibleTile, checkHeight, MAX_STEPS } from "./capture/planner.js";

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
  const message = { target, type, id: s.id, ...payload };
  const response = target === "content"
    ? await chrome.tabs.sendMessage(s.tab.id, message, { frameId: 0 })
    : await chrome.runtime.sendMessage(message);
  check(s);
  if (!response?.ok) throw Object.assign(new Error(response?.error || "截图组件未响应。"), { layout: !!response?.layout, reasonCode: response?.reasonCode, diagnostics: response?.diagnostics });
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
  await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "FINISH", id: s.id }, { frameId: 0 }).catch(() => {});
  if (s.offscreen) {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "CLOSE", id: s.id }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  lastStatus = { id: s.id, tabId: s.tab.id, busy: false, frames: s.frames, parts: s.parts, result: s.result,
    metrics: { ...s.metrics, totalMs: Date.now() - s.started },
    ...(s.mode === "region" ? { reasonCode: error ? error.reasonCode || "CAPTURE_FAILED" : undefined,
      attempt: s.attempt || 1, diagnostics: { ...s.diagnostics, ...error?.diagnostics } } : {}),
    state: error ? (s.cancelled ? "cancelled" : "failed") : "complete",
    message: error ? error.message : "截图完成，已保存一张 PNG。" };
  await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "PROGRESS", id: s.id, status: lastStatus }, { frameId: 0 }).catch(() => {});
  try { await chrome.storage.session.set({ status: lastStatus }); }
  finally { if (active === s) active = null; }
}

async function start(mode, output = "auto") {
  if (!["auto", "css", "75", "50", "device"].includes(output)) throw new Error("未知输出尺寸。");
  if (!["full", "region"].includes(mode)) throw new Error("未知截图模式。");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):\/\//.test(tab.url || "")) throw new Error("请在普通网页中使用；浏览器内部页面不支持截图。");
  if (active) throw new Error("已有截图任务，请先取消或等待完成。");
  const s = { id: crypto.randomUUID(), tab, mode, output, metrics: { captures: 0, settles: 0, encodeMs: 0, saveMs: 0, retries: 0, frameRetries: 0 }, started: Date.now(), frames: 0, parts: 0, cancelled: false };
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

function validateView(s, view) {
  if (s.mode === "region") {
    s.lastView = view;
    validateEnvironment(s, { ...view, tabZoom: view.tabZoom ?? s.environment.tabZoom, tabId: s.tab.id });
    validateRegion(s, view);
    return;
  }
  if (!sameViewport(s.viewport, view) || view.visualScale !== 1) throw new Error("视口或缩放已改变，请保持窗口尺寸与缩放不变。");
  if (view.width !== s.viewport.width) throw new Error("页面宽度发生变化，请等待页面稳定后重试。");
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
  if (s.region && page.region && (Math.abs(page.region.width - s.region.width) > 0.01 ||
      Math.abs(page.region.height - s.region.height) > 0.01)) {
    throw Object.assign(new Error("所选区域持续发生布局变化，请稍后重试。"), {
      layout: true, reasonCode: "REGION_REFLOW", diagnostics: s.diagnostics
    });
  }
}

// Stitch in the attempt's coordinate system even when the real document moves.
function relativeView(s, view) {
  if (s.mode !== "region") return view;
  return { ...view, x: view.x - view.region.x + s.region.x, y: view.y - view.region.y + s.region.y };
}

async function scroll(s, x, y) {
  s.scrollTarget = { x, y };
  s.metrics.settles++;
  await status(s, s.frames ? "capturing" : "loading", `正在等待当前内容稳定 / 加载 · 已处理 ${s.frames} 帧…`);
  await ensureVisible(s);
  if (s.mode === "region") await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  const view = await request(s, "content", "SCROLL", s.mode === "region"
    ? { x: x - s.region.x, y: y - s.region.y, relative: true }
    : { x: Math.floor(x), y: Math.floor(y) });
  validateView(s, view);
  return view;
}

async function capture(s, view) {
  const target = s.scrollTarget;
  for (let sample = 0; sample < 3; sample++) {
    try { return { view, dataUrl: await captureOnce(s, view) }; }
    catch (error) {
      if (!error.translation || sample === 2) throw error;
      // Only this uncommitted frame moved; keep already verified canvas pixels.
      s.metrics.frameRetries++;
      view = await scroll(s, target.x, target.y);
    }
  }
}

async function captureOnce(s, view) {
  // Chrome allows at most two captureVisibleTab calls per second.
  await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  await ensureVisible(s);
  await request(s, "content", "HIDE_UI");
  try {
    if (s.mode === "region") {
      const before = await request(s, "content", "MEASURE");
      validateView(s, before);
      if (before.x !== view.x || before.y !== view.y || before.region.x !== view.region.x || before.region.y !== view.region.y) {
        throw Object.assign(new Error("所选内容移动过于频繁，请稍后重试。"), { translation: true, reasonCode: "FRAME_MOVED" });
      }
    }
    lastCapture = Date.now();
    s.metrics.captures++;
    const dataUrl = await chrome.tabs.captureVisibleTab(s.tab.windowId, { format: "png" });
    await ensureVisible(s);
    const after = await request(s, "content", "MEASURE");
    validateView(s, after);
    if (s.mode === "full" && after.height !== view.height) throw Object.assign(new Error("截图时页面高度发生变化。"), { layout: true });
    if (s.mode === "region" && (after.region.x !== view.region.x || after.region.y !== view.region.y)) {
      throw Object.assign(new Error("所选内容移动过于频繁，请稍后重试。"), { translation: true });
    }
    if (after.x !== view.x || after.y !== view.y) throw new Error("截图时页面发生移动，请重试。");
    return dataUrl;
  } finally {
    await chrome.tabs.sendMessage(s.tab.id, { target: "content", type: "SHOW_UI", id: s.id }, { frameId: 0 }).catch(() => {});
  }
}

async function warm(s) {
  await status(s, "loading", "正在预滚动加载图片…（Esc 取消）");
  const initial = s.viewport.height;
  let y = s.mode === "region" ? s.region.y : 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const view = await scroll(s, s.region?.x || 0, y);
    checkHeight(initial, view.height, view.clientHeight);
    const end = s.mode === "region" ? s.region.y + s.region.height : view.height;
    if (end > view.height) throw new Error("页面变短，选区超出页面范围。");
    if (view.y > y + 0.01 || view.y + view.clientHeight <= y) throw new Error("页面阻止了预滚动，请重试。");
    if (view.y + view.clientHeight >= end) {
      // Return to the start after lazy loading: the capture uses this final height.
      const first = await scroll(s, s.region?.x || 0, s.region?.y || 0);
      if (s.mode === "full") s.region = { x: 0, y: 0, width: first.width, height: first.height };
      s.stableHeight = first.height;
      return first;
    }
    y = Math.min(end - 1, view.y + view.clientHeight - 32);
  }
  throw new Error("页面过长或持续增长，请缩小选区。");
}

async function saveImage(s, url) {
  await status(s, "saving", "正在保存，若弹出保存窗口请选择位置…");
  check(s);
  const title = (s.tab.title || "page").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim().slice(0, 80) || "page";
  s.downloadId = await chrome.downloads.download({ url, filename: `LongScreenshot/${s.stamp}-${title}.png` });
  await status(s, "saving", "正在保存，若弹出保存窗口请选择位置…");
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    check(s);
    const [item] = await chrome.downloads.search({ id: s.downloadId });
    if (!item || item.state === "interrupted") throw new Error(`下载失败：${item?.error || "记录不存在"}`);
    if (item.state === "complete") {
      s.result = { downloadId: item.id, filename: item.filename, width: s.outputSize.width, height: s.outputSize.height, bytes: item.fileSize };
      s.downloadId = null; s.parts++; return;
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
    for (let attempt = 0; attempt < 2; attempt++) {
      s.attempt = attempt + 1;
      try {
        let view, dataUrl;
        if (s.mode === "region") {
          if (attempt) {
            s.metrics.retries++;
            await status(s, "loading", "所选内容发生变化，正在重新截图…");
          }
          // No canvas exists yet: adopt a coherent current region before Attempt's
          // first committed frame. Bound acquisition even if the page keeps moving.
          for (let sample = 0; sample < 3; sample++) {
            try {
              const resolved = await request(s, "content", "MEASURE");
              s.region = regionFromEdges({ left: resolved.region.x, top: resolved.region.y,
                right: resolved.region.x + resolved.region.width, bottom: resolved.region.y + resolved.region.height }, resolved);
              validateView(s, resolved);
              view = await scroll(s, s.region.x, s.region.y);
              outputGeometry(s.region, view, { width: view.innerWidth, height: view.innerHeight }, s.output === "device" ? "auto" : s.output);
              ({ view, dataUrl } = await capture(s, view));
              break;
            } catch (error) {
              if (!error.layout || sample === 2 || attempt) throw error;
              s.metrics.frameRetries++;
            }
          }
        } else if (attempt) {
          s.metrics.retries++;
          await status(s, "loading", "布局发生变化，正在安全预加载并重新截图…");
          view = await warm(s);
        } else {
          view = await scroll(s, s.region?.x || 0, s.region?.y || 0);
          if (s.mode === "full") s.region = { x: 0, y: 0, width: view.width, height: view.height };
          s.stableHeight = view.height;
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
        const scale = await request(s, "offscreen", "OPEN", { region: s.region, view: relativeView(s, view), dataUrl, output: s.output });
        s.outputSize = scale;
        await request(s, "offscreen", "PART", { start: 0, height: scale.height });
        let y = s.region.y;
        while (y < s.region.y + s.region.height - 0.0001) {
          let x = s.region.x, bandBottom;
          while (x < s.region.x + s.region.width - 0.0001) {
            if (s.metrics.captures >= MAX_STEPS) throw new Error("截图超过 1000 帧，请缩小选区。");
            if (!dataUrl) {
              view = await scroll(s, x, y);
              if (s.mode === "full" && view.height !== s.stableHeight) throw Object.assign(new Error("页面高度仍在变化，请等待加载完成后重试。"), { layout: true });
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
        if (s.mode === "region") {
          await ensureVisible(s);
          validateView(s, await request(s, "content", "MEASURE"));
        }
        await status(s, "encoding", `正在生成图片 · ${scale.width} × ${scale.height} 像素…`);
        const encodeStart = Date.now();
        const { url } = await request(s, "offscreen", "EXPORT");
        s.metrics.encodeMs += Date.now() - encodeStart;
        s.stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const saveStart = Date.now();
        await saveImage(s, url);
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
    if (m.type === "START" && fromPopup) return start(m.mode, m.output);
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
