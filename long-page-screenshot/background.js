const MENU_ID = "capture-long-page-screenshot";
const CONTENT_SCRIPT_FILE = "content.js";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const MAX_CANVAS_PIXELS = 120_000_000;
const MAX_CANVAS_DIMENSION = 30_000;
const MAX_CAPTURE_STEPS = 320;
const PART_OVERLAP_CSS_PX = 160;

const tasks = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "截取整页长截图",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) {
    startCaptureForTab(tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "START_LONG_SCREENSHOT") {
    return false;
  }

  handlePopupStart(sendResponse);
  return true;
});

async function handlePopupStart(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    validateTabForCapture(tab);
    startCaptureForTab(tab).catch((error) => {
      console.error("Long screenshot failed", error);
    });
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: getErrorMessage(error) });
  }
}

async function startCaptureForTab(tab) {
  validateTabForCapture(tab);

  if (tasks.has(tab.id)) {
    throw new Error("这个页面正在截图，请稍后再试。");
  }

  const task = { cancelled: false };
  tasks.set(tab.id, task);

  try {
    await injectContentScript(tab.id);
    await sendToTab(tab.id, { type: "LONG_SCREENSHOT_PREPARE" });

    const page = await sendToTab(tab.id, { type: "LONG_SCREENSHOT_MEASURE" });
    validatePageForCapture(page);

    const captures = [];
    let targetY = 0;
    for (let index = 0; index < page.steps.length; index += 1) {
      if (task.cancelled) {
        throw new Error("截图已取消。");
      }

      const step = page.steps[index];
      await sendToTab(tab.id, {
        type: "LONG_SCREENSHOT_SCROLL_TO",
        y: step.y,
        progress: index / page.steps.length
      });

      const dataUrl = await captureVisibleTab(tab.windowId);
      captures.push({
        dataUrl,
        targetY,
        sourceY: step.sourceY,
        sourceHeight: step.sourceHeight
      });
      targetY += step.sourceHeight;

      await sendToTab(tab.id, {
        type: "LONG_SCREENSHOT_PROGRESS",
        progress: (index + 1) / page.steps.length
      });
    }

    const result = await stitchCaptures({
      captures,
      width: page.captureWidth,
      height: page.captureHeight,
      devicePixelRatio: page.devicePixelRatio,
      parts: page.parts,
      title: tab.title || "long-page-screenshot"
    });

    for (const file of result.files) {
      await chrome.downloads.download({
        url: file.url,
        filename: file.filename,
        saveAs: false
      });
    }

    await sendToTab(tab.id, { type: "LONG_SCREENSHOT_FINISH", ok: true });
  } catch (error) {
    await safeSendToTab(tab.id, {
      type: "LONG_SCREENSHOT_FINISH",
      ok: false,
      error: getErrorMessage(error)
    });
    throw error;
  } finally {
    tasks.delete(tab.id);
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function safeSendToTab(tabId, message) {
  try {
    await sendToTab(tabId, message);
  } catch (error) {
    console.warn("Failed to send cleanup message", error);
  }
}

async function captureVisibleTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function stitchCaptures(payload) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    type: "LONG_SCREENSHOT_STITCH",
    payload
  });

  if (!result || result.error) {
    throw new Error(result?.error || "拼接长截图失败。");
  }

  return result;
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["BLOBS"],
    justification: "Stitch captured screenshots on a canvas and export the final PNG."
  });
}

function validatePageForCapture(page) {
  if (!page || !Array.isArray(page.steps) || page.steps.length === 0) {
    throw new Error("无法读取页面尺寸。");
  }

  if (page.steps.length > MAX_CAPTURE_STEPS) {
    throw new Error(`页面过长，需要 ${page.steps.length} 次截图，已超过 ${MAX_CAPTURE_STEPS} 次上限。`);
  }

  page.parts = buildOutputParts(page);
}

function buildOutputParts(page) {
  if (page.captureWidth > MAX_CANVAS_DIMENSION) {
    throw new Error("页面宽度过大，浏览器无法生成截图画布。");
  }

  const maxPartHeight = Math.max(
    1,
    Math.min(MAX_CANVAS_DIMENSION, Math.floor(MAX_CANVAS_PIXELS / page.captureWidth))
  );

  if (page.captureHeight <= maxPartHeight) {
    return [{
      startY: 0,
      height: page.captureHeight
    }];
  }

  const overlap = Math.min(
    Math.round(PART_OVERLAP_CSS_PX * page.devicePixelRatio),
    Math.floor(maxPartHeight / 4)
  );
  const parts = [];
  let startY = 0;

  while (startY < page.captureHeight) {
    const remainingHeight = page.captureHeight - startY;
    const height = Math.min(maxPartHeight, remainingHeight);
    parts.push({ startY, height });

    if (startY + height >= page.captureHeight) {
      break;
    }

    startY += Math.max(1, height - overlap);
  }

  return parts;
}

function isSupportedPageUrl(url) {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

function validateTabForCapture(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error("没有可截图的当前页面。");
  }

  if (!isSupportedPageUrl(tab.url)) {
    throw new Error("当前页面不支持截图，请在普通网页中使用。");
  }
}

function getErrorMessage(error) {
  return error?.message || String(error);
}
