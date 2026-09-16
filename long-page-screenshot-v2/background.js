import { regionFromEdges, pixelEdge, sameViewport } from "./capture/geometry.js";
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
  if (contexts.length) await chrome.offscreen.closeDocument();
  if (saved?.busy) {
    await chrome.tabs.sendMessage(saved.tabId, { target: "content", type: "FINISH", id: saved.id }).catch(() => {});
    if (saved.downloadId) await chrome.downloads.cancel(saved.downloadId).catch(() => {});
    lastStatus = { ...saved, busy: false, state: "failed", message: "上次任务已中断，页面已恢复。已下载的分片可能不完整，请重新截图。" };
    await chrome.storage.session.set({ status: lastStatus });
  } else if (saved) lastStatus = saved;
})();

function check(s) {
  if (active !== s || s.cancelled || s.finishing) throw new Error(s.reason || "截图已取消。");
  if (Date.now() - s.started > 15 * 60_000) throw new Error("任务超过 15 分钟，请缩小选区后重试。");
}

async function status(s, state, message) {
  check(s);
  s.state = state;
  lastStatus = { id: s.id, tabId: s.tab.id, state, message, busy: true,
    frames: s.frames, parts: s.parts, downloadId: s.downloadId };
  await chrome.storage.session.set({ status: lastStatus });
}

async function request(s, target, type, payload = {}) {
  check(s);
  const message = { target, type, id: s.id, ...payload };
  const response = target === "content"
    ? await chrome.tabs.sendMessage(s.tab.id, message, { frameId: 0 })
    : await chrome.runtime.sendMessage(message);
  check(s);
  if (!response?.ok) throw new Error(response?.error || "截图组件未响应。");
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
  lastStatus = { id: s.id, tabId: s.tab.id, busy: false, frames: s.frames, parts: s.parts,
    state: error ? (s.cancelled ? "cancelled" : "failed") : "complete",
    message: error ? `${error.message}${s.parts ? ` 已保存 ${s.parts} 个分片，整页尚未完成。` : ""}` : `截图完成，已保存 ${s.parts} 个 PNG 分片。` };
  try { await chrome.storage.session.set({ status: lastStatus }); }
  finally { if (active === s) active = null; }
}

async function start(mode) {
  if (!["full", "region"].includes(mode)) throw new Error("未知截图模式。");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):\/\//.test(tab.url || "")) throw new Error("请在普通网页中使用；浏览器内部页面不支持截图。");
  if (active) throw new Error("已有截图任务，请先取消或等待完成。");
  const s = { id: crypto.randomUUID(), tab, mode, started: Date.now(), frames: 0, parts: 0, cancelled: false };
  active = s;
  try {
    await status(s, "preparing", "正在准备页面…");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    s.selectionPage = await request(s, "content", "BEGIN", { mode });
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
  if (tab?.id !== s.tab.id) throw new Error("截图页面已切换，请保持目标标签页在前台。");
}

function validateView(s, view) {
  if (!sameViewport(s.viewport, view) || view.visualScale !== 1) throw new Error("视口或缩放已改变，请保持窗口尺寸与缩放不变。");
  if (view.width !== s.viewport.width) throw new Error("页面宽度发生变化，请等待页面稳定后重试。");
  if (s.mode === "region") validateRegion(s, view);
}

function validateRegion(s, page) {
  if (page.width !== s.selectionPage.width || page.height !== s.selectionPage.height ||
      !sameViewport(s.selectionPage, page) || page.visualScale !== s.selectionPage.visualScale) {
    throw new Error("选择区域后页面尺寸或视口发生变化，请等待加载完成后重新选择区域。");
  }
  regionFromEdges({ left: s.region.x, top: s.region.y,
    right: s.region.x + s.region.width, bottom: s.region.y + s.region.height }, page);
}

async function scroll(s, x, y) {
  await ensureVisible(s);
  const view = await request(s, "content", "SCROLL", { x: Math.floor(x), y: Math.floor(y) });
  validateView(s, view);
  return view;
}

async function capture(s, view) {
  // Chrome allows at most two captureVisibleTab calls per second.
  await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  await ensureVisible(s);
  lastCapture = Date.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(s.tab.windowId, { format: "png" });
  await ensureVisible(s);
  const after = await request(s, "content", "MEASURE");
  validateView(s, after);
  if (after.x !== view.x || after.y !== view.y || after.height !== view.height) throw new Error("截图时页面发生移动或尺寸变化，请重试。");
  return dataUrl;
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

async function savePart(s, url) {
  await status(s, "saving", `正在保存第 ${s.parts + 1} 个分片…`);
  check(s);
  const title = (s.tab.title || "page").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim().slice(0, 80) || "page";
  s.downloadId = await chrome.downloads.download({ url, filename: `LongScreenshot/${s.stamp}-${title}-part-${String(s.parts + 1).padStart(3, "0")}.png`, saveAs: false });
  await status(s, "saving", `正在保存第 ${s.parts + 1} 个分片…`);
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    check(s);
    const [item] = await chrome.downloads.search({ id: s.downloadId });
    if (!item || item.state === "interrupted") throw new Error(`下载失败：${item?.error || "记录不存在"}`);
    if (item.state === "complete") { s.downloadId = null; s.parts++; return; }
    await delay(250);
  }
  throw new Error("下载超过两分钟，请检查浏览器下载设置。");
}

async function run(s) {
  try {
    await status(s, "preparing", "正在准备截图…");
    s.viewport = await request(s, "content", "PREPARE");
    if (s.mode === "region") validateRegion(s, s.viewport);
    if (s.viewport.visualScale !== 1 || s.viewport.clientHeight < 64 || s.viewport.clientWidth < 64) throw new Error("请恢复触控缩放并增大浏览器窗口。");
    let view = await warm(s);
    let dataUrl = await capture(s, view);
    s.offscreen = true;
    // A previous close may have failed even after its session was released.
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length) await chrome.offscreen.closeDocument();
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Incrementally stitch screenshot tiles and encode bounded PNG parts." });
    const scale = await request(s, "offscreen", "OPEN", { region: s.region, view, dataUrl });
    const total = pixelEdge(s.region.y + s.region.height, s.region.y, scale.scaleY);
    if (total < 1) throw new Error("选区高度小于一个输出像素。");
    s.stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (let start = 0; start < total; start += scale.partHeight) {
      const height = Math.min(scale.partHeight, total - start);
      await request(s, "offscreen", "PART", { start, height });
      let y = s.region.y + start / scale.scaleY;
      const end = Math.min(s.region.y + s.region.height, s.region.y + (start + height) / scale.scaleY);
      while (y < end - 0.0001) {
        let x = s.region.x;
        let bandBottom;
        while (x < s.region.x + s.region.width - 0.0001) {
          if (s.frames >= MAX_STEPS) throw new Error("截图超过 1000 帧，请缩小选区。");
          if (!dataUrl) { view = await scroll(s, x, y); dataUrl = await capture(s, view); }
          if (view.height !== s.stableHeight) throw new Error("预加载后页面高度仍在变化，请等待加载完成后重试。");
          const rect = visibleTile(s.region, view, x, y, bandBottom);
          rect.bottom = Math.min(rect.bottom, end);
          bandBottom = rect.bottom;
          await request(s, "offscreen", "FRAME", { view, rect, dataUrl });
          dataUrl = null; // No array of screenshots or completed PNGs.
          s.frames++;
          x = rect.right;
          await status(s, "capturing", `正在截图 ${Math.min(99, Math.floor((y - s.region.y) / s.region.height * 100))}% · ${s.frames} 帧 · Esc 取消`);
        }
        y = bandBottom;
      }
      const { url } = await request(s, "offscreen", "EXPORT");
      await savePart(s, url);
      await request(s, "offscreen", "RELEASE", { final: start + height === total });
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
    if (m.type === "START" && fromPopup) return start(m.mode);
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
        const page = await request(s, "content", "MEASURE");
        s.region = regionFromEdges(m.edges, page);
        validateRegion(s, page);
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
    active.cancelled = true; active.reason = "目标标签页已切换，截图已停止。";
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (active?.tab.id === tabId) {
    active.cancelled = true; active.reason = "目标标签页已关闭。";
    if (active.state === "selecting") void finish(active, new Error(active.reason));
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (active?.tab.id === tabId && change.status === "loading") {
    active.cancelled = true; active.reason = "目标页面已导航或刷新，截图已停止。";
    if (active.state === "selecting") void finish(active, new Error(active.reason));
  }
});
