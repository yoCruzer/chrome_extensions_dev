const BRIDGE_EVENT = "gemini-backup-bridge";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== "gemini-backup-popup") {
    return false;
  }

  const requestId = message.requestId || crypto.randomUUID();
  const timeoutMs = message.command === "EXPORT_CURRENT_MD" ? 45000 : 20 * 60 * 1000;

  waitForPageResponse(requestId, timeoutMs).then(sendResponse);
  window.postMessage(
    {
      source: "gemini-backup-isolated",
      requestId,
      command: message.command,
      limit: message.limit,
      mode: message.mode
    },
    window.location.origin
  );

  return true;
});

function waitForPageResponse(requestId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: "备份超时，Gemini 页面可能未完成加载或已阻止自动化操作。" });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data;
      if (data?.source !== BRIDGE_EVENT || data.requestId !== requestId) {
        return;
      }

      cleanup();
      resolve(data.response);
    }

    window.addEventListener("message", onMessage);
  });
}
