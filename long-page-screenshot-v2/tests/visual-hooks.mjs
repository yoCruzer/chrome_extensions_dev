// Test-only lifecycle hooks. Production warmup/capture paths stay unchanged.
// Restore BEFORE invoking the previous wrapper so multi-call bitmap faults
// installed by a test keep running on later acquisitions.
export async function armAfterFirstBitmap(worker, armFunction) {
  await worker.evaluate(armFunction => {
    const previous = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async function (...args) {
      chrome.tabs.captureVisibleTab = previous;
      const bitmap = await previous.apply(this, args);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Capture fixture lost its active tab');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: name => {
          if (typeof window[name] !== 'function') throw new Error(`Missing capture fixture arm function: ${name}`);
          window[name]();
        }, args: [armFunction]
      });
      return bitmap;
    };
  }, armFunction);
}

export async function installVisualMutation(worker, { restoreAt = 0 } = {}) {
  if (restoreAt !== 0 && (!Number.isInteger(restoreAt) || restoreAt < 3)) {
    throw new Error('restoreAt must be 0 or an integer >= 3');
  }
  await worker.evaluate(restoreAt => {
    const original = globalThis.__v2VisualOriginal || chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = original;
    delete globalThis.__v2VisualOriginal;
    if (!restoreAt) return;
    globalThis.__v2VisualOriginal = original;
    let calls = 0;
    chrome.tabs.captureVisibleTab = async (...args) => {
      calls++;
      if (calls === 2 || calls === restoreAt) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: async seed => {
            paint(seed);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, args: [calls === 2 ? 987654 : 0]
        });
      }
      if (calls === restoreAt) {
        chrome.tabs.captureVisibleTab = original;
        delete globalThis.__v2VisualOriginal;
      }
      return original(...args);
    };
  }, restoreAt);
  // Arm at the first bitmap's original top, not between the second bitmap's
  // before/after geometry checks. The next SCROLL now owns the layout mutation;
  // a geometry resample cannot consume a scheduled visual-recovery fault.
  await armAfterFirstBitmap(worker, 'armVisualMutation');
}
