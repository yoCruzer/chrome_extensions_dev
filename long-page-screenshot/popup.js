const captureButton = document.getElementById("captureButton");
const statusNode = document.getElementById("status");

captureButton.addEventListener("click", async () => {
  setBusy(true, "正在启动截图...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "START_LONG_SCREENSHOT" });

    if (!response?.ok) {
      throw new Error(response?.error || "启动失败。");
    }

    setStatus("截图已开始，完成后会自动下载。");
    window.close();
  } catch (error) {
    setStatus(error?.message || String(error), true);
    setBusy(false);
  }
});

function setBusy(isBusy, message = "") {
  captureButton.disabled = isBusy;
  captureButton.textContent = isBusy ? "截图中..." : "开始长截图";
  setStatus(message);
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}
