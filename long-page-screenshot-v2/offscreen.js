import { outputGeometry, drawGeometry } from "./capture/geometry.js";
import { VISUAL, overlapCSS, matchVertical, robustPlacement } from "./capture/visual.js";
import { assessBottomTail } from "./capture/bottom-tail.js";

let session;
let queue = Promise.resolve();

function releaseCanvas() {
  if (!session) return;
  if (session.canvas) session.canvas.width = session.canvas.height = 1;
  session.canvas = session.context = session.start = null;
}

function revokeParts() {
  if (!session?.parts) return;
  for (const part of session.parts) if (part.url) URL.revokeObjectURL(part.url);
  session.parts = [];
}

function closeSession() {
  if (!session) return;
  releaseCanvas();
  revokeParts();
  session = null;
}

addEventListener("pagehide", closeSession);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
  // Serialize cleanup behind in-flight decoding/encoding.
  queue = queue.then(async () => {
    try { return await handle(message); }
    catch (error) {
      // An old message must never tear down the current task.
      if (session?.id === message.id) closeSession();
      throw error;
    }
  });
  queue.then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
  queue = queue.catch(() => {});
  return true;
});

async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Read a bounded strip directly from the bitmap in target-local CSS coordinates.
function strip(bitmap, view, tail, from = 0) {
  const width = Math.min(VISUAL.maxWidth, Math.max(12, Math.floor(view.clientWidth / VISUAL.sampleX)));
  const height = Math.floor(view.clientHeight);
  const rows = Math.min(height, Math.ceil(overlapCSS(height) + 2 * VISUAL.radius + VISUAL.rows));
  const start = tail ? height - rows : Math.max(0, Math.min(height - rows, Math.floor(from)));
  const canvas = new OffscreenCanvas(width, rows);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const sx = bitmap.width / view.innerWidth, sy = bitmap.height / view.innerHeight;
  context.drawImage(bitmap, (view.viewportRect?.left || 0) * sx,
    ((view.viewportRect?.top || 0) + start) * sy, view.clientWidth * sx, rows * sy, 0, 0, width, rows);
  const pixels = context.getImageData(0, 0, width, rows).data;
  const data = new Float32Array(width * rows), colors = new Uint8Array(width * rows * 3);
  for (let i = 0; i < data.length; i++) {
    data[i] = (pixels[i * 4] * 77 + pixels[i * 4 + 1] * 150 + pixels[i * 4 + 2] * 29) / 256;
    colors[i * 3] = pixels[i * 4];
    colors[i * 3 + 1] = pixels[i * 4 + 1];
    colors[i * 3 + 2] = pixels[i * 4 + 2];
  }
  canvas.width = canvas.height = 1;
  return { width, height, start, data, colors };
}

function updateGeometry(height) {
  const region = { ...session.region, height };
  const scale = outputGeometry(region, session.view, { width: session.bitmapWidth, height: session.bitmapHeight }, session.output);
  if (Math.abs(scale.scaleY - session.scale.scaleY) > 1e-9 || scale.width !== session.scale.width ||
      scale.partHeight !== session.scale.partHeight) throw new Error("动态扩展改变了输出比例。");
  session.region = region;
  session.scale = scale;
  return scale;
}

function openPart(start) {
  if (session.canvas) throw new Error("上一分片尚未释放。");
  session.start = start;
  session.canvas = new OffscreenCanvas(session.scale.width, session.scale.partHeight);
  session.context = session.canvas.getContext("2d", { alpha: false });
  if (!session.context) throw new Error("无法创建截图画布。");
}

async function finalizePart() {
  if (!session.canvas) return;
  const actualHeight = Math.min(session.canvas.height, Math.max(0, session.scale.height - session.start));
  if (actualHeight < 1) { releaseCanvas(); return; }
  let canvas = session.canvas;
  if (actualHeight !== canvas.height) {
    const cropped = new OffscreenCanvas(canvas.width, actualHeight);
    const context = cropped.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法裁剪截图分片。");
    context.drawImage(canvas, 0, 0);
    canvas.width = canvas.height = 1;
    canvas = cropped;
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const url = URL.createObjectURL(blob);
  session.parts.push({ url, start: session.start, width: canvas.width, height: actualHeight });
  canvas.width = canvas.height = 1;
  session.canvas = session.context = session.start = null;
}

async function drawIntoParts(bitmap, view, rect) {
  const d = drawGeometry(session.region, view, rect, session.scale, 0);
  let top = d.dy, bottom = d.dy + d.dh;
  while (top < bottom) {
    const partStart = Math.floor(top / session.scale.partHeight) * session.scale.partHeight;
    if (!session.canvas) openPart(partStart);
    if (session.start !== partStart) {
      await finalizePart();
      openPart(partStart);
    }
    const partEnd = partStart + session.scale.partHeight;
    const segmentEnd = Math.min(bottom, partEnd);
    const ratio0 = d.dh ? (top - d.dy) / d.dh : 0;
    const ratio1 = d.dh ? (segmentEnd - d.dy) / d.dh : 1;
    session.context.drawImage(bitmap,
      d.sx, d.sy + d.sh * ratio0, d.sw, d.sh * (ratio1 - ratio0),
      d.dx, top - partStart, d.dw, segmentEnd - top);
    top = segmentEnd;
    if (top >= partEnd) await finalizePart();
  }
}
async function handle(m) {
  if (m.type === "CLOSE") {
    if (session?.id === m.id) closeSession();
    return {};
  }
  if (m.type === "OPEN") {
    if (session) throw new Error("拼图任务仍在运行。");
    const bitmap = await decode(m.dataUrl);
    try {
      const scale = outputGeometry(m.region, m.view, bitmap, m.output);
      session = { continuityPolicy: m.continuityPolicy === "strict" ? "strict" : "robust", id: m.id, region: m.region, scale, output: m.output, view: m.view,
        bitmapWidth: bitmap.width, bitmapHeight: bitmap.height, parts: [] };
      return scale;
    } finally { bitmap.close(); }
  }
  if (session?.id !== m.id) throw new Error("过期的拼图任务。");
  if (m.type === "PART") {
    if (session.canvas || session.parts.length) throw new Error("上一分片尚未释放。");
    if (m.start !== 0 || m.height !== session.scale.partHeight) throw new Error("拼图分片尺寸无效。");
    openPart(0);
    return {};
  }
  if (m.type === "EXTEND") {
    if (m.region.width !== session.region.width) throw new Error("无效的画布扩展。");
    return updateGeometry(Math.max(m.region.height, session.region.height));
  }
  if (m.type === "FULL_FRAME") {
    if (m.firstColumn && !session.previous && Math.abs(m.view.y) > 0.01) throw new Error("页面未到达顶部，已停止以免遗漏内容。");
    const bitmap = await decode(m.dataUrl);
    try {
      if (bitmap.width !== session.bitmapWidth || bitmap.height !== session.bitmapHeight) throw new Error("截图尺寸已变化，请保持窗口和缩放不变。");
      let canonicalY = m.canonicalY ?? 0, novelTop = m.novelTop ?? 0, visual, anchored, fallback, tailDecision;
      if (m.firstColumn && session.previous) {
        const expected = m.view.y - session.previous.documentY;
        const current = strip(bitmap, m.view, false, session.previous.strip.start - Math.max(1, expected - VISUAL.radius));
        if (!m.uncertain) visual = matchVertical(session.previous.strip, current, expected, true, session.continuityPolicy);
        if (!visual || visual.result !== 'matched' || visual.correction !== 0) {
          visual = { ...matchVertical(session.previous.strip, current, expected, false, session.continuityPolicy), path: 'recovery' };
        } else visual.path = 'fast';
        if (visual.result !== 'matched') {
          if (session.continuityPolicy !== "strict" && m.bottomExtent !== undefined) {
            tailDecision = assessBottomTail(m.view, session.previous.end, m.bottomExtent);
            anchored = tailDecision.anchor;
          }
          fallback = !anchored && m.robustFallbackMode
            ? robustPlacement(session.previous, expected, visual, session.continuityPolicy, m.robustFallbackMode)
            : null;
          if (!anchored && !fallback) return { accepted: false, visual, canonicalEnd: session.previous.end,
            ...(tailDecision && !tailDecision.anchor ? { bottomTailReject: { reason: tailDecision.reason, details: tailDecision.details } } : {}) };
        }
        if (fallback) {
          canonicalY = fallback.canonicalY;
          novelTop = fallback.novelTop;
          visual = fallback.visual;
        } else {
          canonicalY = anchored ? anchored.canonicalY : session.previous.canonicalY + visual.matchedOffset;
          novelTop = session.previous.end;
        }
      }
      const localBottom = anchored ? anchored.viewportHeight : Math.min(m.view.clientHeight, m.view.height - m.view.y);
      const end = anchored ? anchored.finalExtent : canonicalY + localBottom;
      if (end <= novelTop || canonicalY > novelTop + 0.01) return { accepted: false, visual: { ...visual, result: 'failed' } };
      if (end > session.region.height) updateGeometry(end);
      const rect = { x: session.region.x, right: session.region.x + session.region.width, y: novelTop, bottom: end };
      await drawIntoParts(bitmap, { ...m.view, y: canonicalY }, rect);
      if (m.firstColumn) session.previous = { strip: strip(bitmap, m.view, true), canonicalY, end, documentY: m.view.y };
      session.canonicalEnd = end;
      return { accepted: true, canonicalY, novelTop, end, right: rect.right, visual, bottomTail: anchored || undefined };
    } finally { bitmap.close(); }
  }
  if (m.type === "FULL_FINALIZE") {
    session.previous = null;
    if (session.canonicalEnd < session.region.height) updateGeometry(session.canonicalEnd);
    return session.scale;
  }

  if (m.type === "FRAME") {
    if (!session.context || !session.canvas) throw new Error("拼图分片尚未创建。");
    const bitmap = await decode(m.dataUrl);
    try {
      if (bitmap.width !== session.bitmapWidth || bitmap.height !== session.bitmapHeight) {
        throw new Error("截图尺寸已变化，请保持窗口和缩放不变。");
      }
      await drawIntoParts(bitmap, m.view, m.rect);
    } finally { bitmap.close(); }
    return {};
  }
  if (m.type === "EXPORT") {
    await finalizePart();
    if (!session.parts.length) throw new Error("没有可导出的拼图分片。");
    return { parts: session.parts.map((part, index) => ({ ...part, index, count: session.parts.length })) };
  }
  if (m.type === "RELEASE") {
    if (m.final) closeSession();
    else releaseCanvas();
    return {};
  }
  throw new Error("未知拼图消息。");
}
