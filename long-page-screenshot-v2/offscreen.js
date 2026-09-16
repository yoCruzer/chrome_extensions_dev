import { outputGeometry, drawGeometry } from "./capture/geometry.js";

let session;
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
  // Serialize cleanup behind in-flight decoding/encoding.
  queue = queue.then(() => handle(message));
  queue.then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
  queue = queue.catch(() => {});
  return true;
});

async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function handle(m) {
  if (m.type === "OPEN") {
    if (session) throw new Error("拼图任务仍在运行。");
    const bitmap = await decode(m.dataUrl);
    try {
      const scale = outputGeometry(m.region, m.view, bitmap);
      session = { id: m.id, region: m.region, scale, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height };
      return scale;
    } finally { bitmap.close(); }
  }
  if (session?.id !== m.id) throw new Error("过期的拼图任务。");
  if (m.type === "PART") {
    if (session.url) throw new Error("上一分片尚未释放。");
    session.start = m.start;
    session.canvas = new OffscreenCanvas(session.scale.width, m.height);
    session.context = session.canvas.getContext("2d", { alpha: false });
    if (!session.context) throw new Error("无法创建截图画布。");
    return {};
  }
  if (m.type === "FRAME") {
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
    const blob = await session.canvas.convertToBlob({ type: "image/png" });
    session.canvas.width = session.canvas.height = 1;
    session.url = URL.createObjectURL(blob);
    return { url: session.url };
  }
  if (m.type === "RELEASE") {
    URL.revokeObjectURL(session.url);
    session.url = null;
    return {};
  }
  throw new Error("未知拼图消息。");
}
