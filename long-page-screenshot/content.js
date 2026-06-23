(() => {
  if (window.__longPageScreenshotInjected) {
    return;
  }

  window.__longPageScreenshotInjected = true;

  const OVERLAY_ID = "__long_page_screenshot_overlay__";
  const SCROLL_SETTLE_DELAY = 350;
  const EXTRA_LAZY_LOAD_DELAY = 250;

  const state = {
    originalX: 0,
    originalY: 0,
    active: false
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  });

  async function handleMessage(message) {
    switch (message?.type) {
      case "LONG_SCREENSHOT_PREPARE":
        prepareCapture();
        return { ok: true };
      case "LONG_SCREENSHOT_MEASURE":
        return measurePage();
      case "LONG_SCREENSHOT_SCROLL_TO":
        await scrollToPosition(message.y);
        updateOverlay(message.progress || 0);
        await hideOverlayForCapture();
        return { ok: true };
      case "LONG_SCREENSHOT_PROGRESS":
        setOverlayVisible(true);
        updateOverlay(message.progress || 0);
        return { ok: true };
      case "LONG_SCREENSHOT_FINISH":
        finishCapture(message);
        return { ok: true };
      default:
        return { ok: false };
    }
  }

  function prepareCapture() {
    if (state.active) {
      throw new Error("这个页面正在截图，请稍后再试。");
    }

    state.originalX = window.scrollX;
    state.originalY = window.scrollY;
    state.active = true;
    showOverlay();
  }

  function measurePage() {
    const documentElement = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const pageWidth = Math.max(
      documentElement.scrollWidth,
      body?.scrollWidth || 0,
      documentElement.clientWidth
    );
    const pageHeight = Math.max(
      documentElement.scrollHeight,
      body?.scrollHeight || 0,
      documentElement.clientHeight
    );
    const cssCaptureWidth = Math.min(viewportWidth, pageWidth);
    const cssCaptureHeight = pageHeight;
    const steps = buildCaptureSteps(pageHeight, viewportHeight, devicePixelRatio);

    return {
      pageWidth,
      pageHeight,
      viewportWidth,
      viewportHeight,
      devicePixelRatio,
      captureWidth: Math.round(cssCaptureWidth * devicePixelRatio),
      captureHeight: Math.round(cssCaptureHeight * devicePixelRatio),
      steps
    };
  }

  function buildCaptureSteps(pageHeight, viewportHeight, devicePixelRatio) {
    const steps = [];
    const maxScrollY = Math.max(0, pageHeight - viewportHeight);

    if (pageHeight <= viewportHeight) {
      return [{
        y: 0,
        sourceY: 0,
        sourceHeight: Math.round(pageHeight * devicePixelRatio)
      }];
    }

    for (let y = 0; y < pageHeight; y += viewportHeight) {
      const scrollY = Math.min(y, maxScrollY);
      const cssSourceY = y === scrollY ? 0 : y - scrollY;
      const cssSourceHeight = Math.min(viewportHeight - cssSourceY, pageHeight - y);

      steps.push({
        y: scrollY,
        sourceY: Math.round(cssSourceY * devicePixelRatio),
        sourceHeight: Math.round(cssSourceHeight * devicePixelRatio)
      });

      if (scrollY === maxScrollY) {
        break;
      }
    }

    return steps;
  }

  async function scrollToPosition(y) {
    window.scrollTo(0, y);
    await delay(SCROLL_SETTLE_DELAY);
    await delay(EXTRA_LAZY_LOAD_DELAY);
  }

  function showOverlay() {
    removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "status");
    overlay.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "width:240px",
      "box-sizing:border-box",
      "padding:14px",
      "border-radius:8px",
      "background:rgba(20,24,31,0.94)",
      "color:#fff",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,0.25)",
      "pointer-events:none"
    ].join(";");

    overlay.innerHTML = [
      '<div style="font-weight:600;margin-bottom:8px;">正在截取长页面</div>',
      '<div data-label style="margin-bottom:8px;color:rgba(255,255,255,0.78);">准备中...</div>',
      '<div style="height:6px;border-radius:999px;background:rgba(255,255,255,0.18);overflow:hidden;">',
      '<div data-bar style="width:0%;height:100%;background:#45c26b;transition:width 160ms ease;"></div>',
      "</div>"
    ].join("");

    document.documentElement.appendChild(overlay);
    updateOverlay(0);
  }

  function updateOverlay(progress) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      return;
    }

    const normalized = Math.max(0, Math.min(1, progress));
    const percent = Math.round(normalized * 100);
    const label = overlay.querySelector("[data-label]");
    const bar = overlay.querySelector("[data-bar]");

    if (label) {
      label.textContent = `进度 ${percent}%`;
    }

    if (bar) {
      bar.style.width = `${percent}%`;
    }
  }

  function setOverlayVisible(isVisible) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.display = isVisible ? "block" : "none";
    }
  }

  async function hideOverlayForCapture() {
    setOverlayVisible(false);
    await waitForNextPaint();
    await waitForNextPaint();
  }

  function finishCapture(message) {
    if (message?.ok === false && message.error) {
      showTemporaryError(message.error);
    } else {
      removeOverlay();
    }

    window.scrollTo(state.originalX, state.originalY);
    state.active = false;
  }

  function showTemporaryError(error) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      return;
    }

    overlay.style.display = "block";
    overlay.style.background = "rgba(132,32,41,0.96)";
    const label = overlay.querySelector("[data-label]");
    if (label) {
      label.textContent = error;
    }

    setTimeout(removeOverlay, 3500);
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForNextPaint() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }
})();
