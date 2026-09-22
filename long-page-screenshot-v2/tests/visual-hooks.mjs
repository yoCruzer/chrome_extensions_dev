// Test-only fault scheduling: warm-up must not consume capture-time mutations.
export async function installVisualMutation(worker, { restoreAt = 0 } = {}) {
  await worker.evaluate(restoreAt => {
    const original = globalThis.__v2VisualOriginal || chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    globalThis.__v2VisualOriginal = original;
    let calls = 0;
    chrome.tabs.captureVisibleTab = async (...args) => {
      calls++;
      if (calls === 2 || (restoreAt && calls === restoreAt)) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: async ({ first, corrupt }) => {
            if (first) window.armVisualMutation();
            if (corrupt) paint(first ? 987654 : 0);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          },
          args: [{ first: calls === 2, corrupt: !!restoreAt }]
        });
      }
      if (calls === (restoreAt || 2)) {
        chrome.tabs.captureVisibleTab = original;
        delete globalThis.__v2VisualOriginal;
      }
      return original(...args);
    };
  }, restoreAt);
}
