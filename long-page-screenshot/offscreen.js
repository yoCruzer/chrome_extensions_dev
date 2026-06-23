let generatedUrls = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "LONG_SCREENSHOT_STITCH") {
    return false;
  }

  stitchScreenshots(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error?.message || String(error) }));

  return true;
});

async function stitchScreenshots(payload) {
  const { captures, width, height, parts, title } = payload;
  const outputParts = Array.isArray(parts) && parts.length > 0
    ? parts
    : [{ startY: 0, height }];
  const files = [];
  const urlsForThisRun = [];

  revokeGeneratedUrls();

  for (let index = 0; index < outputParts.length; index += 1) {
    const part = outputParts[index];
    const url = await renderPart({
      captures,
      width,
      startY: part.startY,
      height: part.height
    });
    urlsForThisRun.push(url);

    files.push({
      url,
      filename: buildFilename(title, index, outputParts.length)
    });
  }

  generatedUrls = urlsForThisRun;
  setTimeout(revokeGeneratedUrls, 60_000);

  return { files };
}

async function renderPart({ captures, width, startY, height }) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("无法创建截图画布。");
  }

  const partEndY = startY + height;

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const captureStartY = capture.targetY;
    const captureEndY = capture.targetY + capture.sourceHeight;
    const drawStartY = Math.max(startY, captureStartY);
    const drawEndY = Math.min(partEndY, captureEndY);

    if (drawEndY <= drawStartY) {
      continue;
    }

    const drawHeight = drawEndY - drawStartY;
    const bitmap = await imageBitmapFromDataUrl(capture.dataUrl);
    context.drawImage(
      bitmap,
      0,
      capture.sourceY + drawStartY - captureStartY,
      width,
      drawHeight,
      0,
      drawStartY - startY,
      width,
      drawHeight
    );
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return URL.createObjectURL(blob);
}

async function imageBitmapFromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function sanitizeFilename(value) {
  return String(value || "long-page-screenshot")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "long-page-screenshot";
}

function revokeGeneratedUrls() {
  generatedUrls.forEach((url) => URL.revokeObjectURL(url));
  generatedUrls = [];
}

function buildFilename(title, partIndex, partCount) {
  const baseName = `${formatTimestamp()}-${sanitizeFilename(title)}`;

  if (partCount <= 1) {
    return `${baseName}.png`;
  }

  const partNumber = String(partIndex + 1).padStart(String(partCount).length, "0");
  return `${baseName}-part-${partNumber}-of-${partCount}.png`;
}

function formatTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("-");
}
