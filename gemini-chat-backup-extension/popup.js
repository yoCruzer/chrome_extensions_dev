const statusNode = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button"));

document.getElementById("export-current").addEventListener("click", () => {
  runGeminiBackup({ command: "EXPORT_CURRENT_MD" });
});

document.getElementById("backup-test").addEventListener("click", () => {
  runGeminiBackup({ command: "BACKUP_HISTORY_ZIP", limit: 3, mode: "test" });
});

document.getElementById("backup-all").addEventListener("click", () => {
  runGeminiBackup({ command: "BACKUP_HISTORY_ZIP", limit: 9999, mode: "full" });
});

async function runGeminiBackup(payload) {
  setBusy(true, "正在连接 Gemini 页面...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://gemini.google.com/")) {
      throw new Error("请先打开 https://gemini.google.com/ 的会话页面。");
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      source: "gemini-backup-popup",
      requestId: crypto.randomUUID(),
      ...payload
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "页面未返回备份数据。");
    }

    if (response.type === "md") {
      downloadText(response.filename, response.markdown, "text/markdown;charset=utf-8");
      setBusy(false, `已生成 ${response.filename}`);
      return;
    }

    if (response.type === "zip") {
      downloadBase64(response.filename, response.base64, "application/zip");
      setBusy(false, `已生成 ${response.filename}`);
      return;
    }

    throw new Error("未知响应类型。");
  } catch (error) {
    setBusy(false, error.message || String(error));
  }
}

function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: sanitizeDownloadPath(filename), saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}

function downloadBase64(filename, base64, mimeType) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: sanitizeDownloadPath(filename), saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}

function sanitizeDownloadPath(filename) {
  return filename.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function setBusy(isBusy, message) {
  buttons.forEach((button) => {
    button.disabled = isBusy;
  });
  statusNode.textContent = message;
}
