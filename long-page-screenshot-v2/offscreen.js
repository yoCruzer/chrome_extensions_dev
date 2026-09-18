import { outputGeometry, drawGeometry } from "./capture/geometry.js";
import { VISUAL, overlapCSS, matchVertical } from "./capture/visual.js";
import { bottomTail } from "./capture/bottom-tail.js";

let session;
let queue = Promise.resolve();

function releasePart() {
  if (!session) return;
  if (session.url) URL.revokeObjectURL(session.url);
  if (session.canvas) session.canvas.width = session.canvas.height = 1;
  session.url = session.canvas = session.context = session.start = null;
}

function closeSession() {
  releasePart();
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

function resizeCanvas(height) {
  if (height === session.region.height) return session.scale;
  const region = { ...session.region, height };
  const scale = outputGeometry(region, session.view, { width: session.bitmapWidth, height: session.bitmapHeight }, session.output);
  // Never upscale previously committed pixels when a canonical image is shorter.
  const ratio = Math.min(scale.scaleY, session.scale.scaleY);
  Object.assign(scale, { scaleX: ratio, scaleY: ratio, width: Math.round(region.width * ratio), height: Math.round(height * ratio) });
  const canvas = new OffscreenCanvas(scale.width, scale.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法扩展截图画布。");
  context.drawImage(session.canvas, 0, 0, scale.width, session.canvas.height * ratio / session.scale.scaleY);
  session.canvas.width = session.canvas.height = 1;
  Object.assign(session, { canvas, context, scale, region });
  return scale;
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
      session = { continuityPolicy: m.continuityPolicy === "strict" ? "strict" : "robust", id: m.id, region: m.region, scale, output: m.output, view: m.view, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height };
      return scale;
    } finally { bitmap.close(); }
  }
  if (session?.id !== m.id) throw new Error("过期的拼图任务。");
  if (m.type === "PART") {
    if (session.url || session.canvas) throw new Error("上一分片尚未释放。");
    if (!Number.isInteger(m.start) || m.start < 0 || !Number.isInteger(m.height) ||
        m.height < 1 || m.height > session.scale.partHeight) throw new Error("拼图分片尺寸无效。");
    session.start = m.start;
    session.canvas = new OffscreenCanvas(session.scale.width, m.height);
    session.context = session.canvas.getContext("2d", { alpha: false });
    if (!session.context) throw new Error("无法创建截图画布。");
    return {};
  }
  if (m.type === "EXTEND") {
    if (!session.canvas || m.region.width !== session.region.width) throw new Error("无效的画布扩展。");
    return resizeCanvas(Math.max(m.region.height, session.region.height));
  }
  if (m.type === "FULL_FRAME") {
    if (m.firstColumn && !session.previous && Math.abs(m.view.y) > 0.01) throw new Error("页面未到达顶部，已停止以免遗漏内容。");
    if (m.view.x > m.x + 0.01 || m.view.x + m.view.clientWidth <= m.x) throw new Error("页面未到达所需横向位置，已停止以免遗漏内容。");
    const bitmap = await decode(m.dataUrl);
    try {
      if (bitmap.width !== session.bitmapWidth || bitmap.height !== session.bitmapHeight) throw new Error("截图尺寸已变化，请保持窗口和缩放不变。");
      let canonicalY = m.canonicalY ?? 0, novelTop = m.novelTop ?? 0, visual, anchored;
      if (m.firstColumn && session.previous) {
        const expected = m.view.y - session.previous.documentY;
        const current = strip(bitmap, m.view, false, session.previous.strip.start - Math.max(1, expected - VISUAL.radius));
        if (!m.uncertain) visual = matchVertical(session.previous.strip, current, expected, true, session.continuityPolicy);
        if (!visual || visual.result !== 'matched' || visual.correction !== 0) {
          visual = { ...matchVertical(session.previous.strip, current, expected, false, session.continuityPolicy), path: 'recovery' };
        } else visual.path = 'fast';
        if (visual.result !== 'matched') {
          anchored = session.continuityPolicy !== "strict" && m.bottomExtent !== undefined && bottomTail(m.view, session.previous.end, m.bottomExtent);
          if (!anchored) return { accepted: false, visual, canonicalEnd: session.previous.end };
        }
        canonicalY = anchored ? anchored.canonicalY : session.previous.canonicalY + visual.matchedOffset;
        novelTop = session.previous.end;
      }
      const localBottom = Math.min(m.view.clientHeight, m.view.height - m.view.y);
      const end = canonicalY + localBottom;
      if (end <= novelTop || canonicalY > novelTop + 0.01) return { accepted: false, visual: { ...visual, result: 'failed' } };
      if (end > session.region.height) resizeCanvas(end);
      const rect = { x: m.x, right: Math.min(session.region.width, m.view.x + m.view.clientWidth), y: novelTop, bottom: end };
      const d = drawGeometry(session.region, { ...m.view, y: canonicalY }, rect, session.scale, 0);
      session.context.drawImage(bitmap, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
      if (m.firstColumn) session.previous = { strip: strip(bitmap, m.view, true), canonicalY, end, documentY: m.view.y };
      session.canonicalEnd = end;
      return { accepted: true, canonicalY, novelTop, end, right: rect.right, visual, bottomTail: anchored || undefined };
    } finally { bitmap.close(); }
  }
  if (m.type === "FULL_FINALIZE") {
    session.previous = null;
    return resizeCanvas(session.canonicalEnd);
  }

  if (m.type === "FRAME") {
    if (!session.context || !session.canvas) throw new Error("拼图分片尚未创建。");
    const bitmap = await decode(m.dataUrl);
    try {
      if (bitmap.width !== session.bitmapWidth || bitmap.height !== session.bitmapHeight) {
        throw new Error("截图尺寸已变化，请保持窗口和缩放不变。");
      }
      const d = drawGeometry(session.region, m.view, m.rect, session.scale, session.start);
      if (d.dy < 0 || d.dy + d.dh > session.canvas.height || d.dx + d.dw > session.canvas.width) {
        throw new Error("截图分片边界不一致。");
      }
      session.context.drawImage(bitmap, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
    } finally { bitmap.close(); }
    return {};
  }
  if (m.type === "EXPORT") {
    if (!session.canvas || session.url) throw new Error("没有可导出的拼图分片。");
    const blob = await session.canvas.convertToBlob({ type: "image/png" });
    releasePart();
    session.url = URL.createObjectURL(blob);
    return { url: session.url };
  }
  if (m.type === "RELEASE") {
    releasePart();
    if (m.final) closeSession();
    return {};
  }
  throw new Error("未知拼图消息。");
}
