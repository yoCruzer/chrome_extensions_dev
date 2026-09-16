(() => {
  if (window.__longScreenshotV2) return;
  window.__longScreenshotV2 = true;
  let session;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function measure() {
    const root = document.documentElement;
    return { x: scrollX, y: scrollY, innerWidth, innerHeight,
      clientWidth: root.clientWidth, clientHeight: root.clientHeight,
      width: Math.max(root.scrollWidth, document.body?.scrollWidth || 0, root.clientWidth),
      height: Math.max(root.scrollHeight, document.body?.scrollHeight || 0, root.clientHeight),
      dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1 };
  }

  function requireSession(id) {
    if (!session || session.id !== id) throw new Error("截图任务已结束。");
    session.touched = Date.now();
    return session;
  }

  function restore() {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.watchdog);
    s.observer?.disconnect();
    s.removeSelectionListener?.();
    s.host?.remove();
    for (const [element, properties] of s.changed) {
      for (const [key, value, priority] of properties) {
        if (value) element.style.setProperty(key, value, priority);
        else element.style.removeProperty(key);
      }
    }
    // Restore while smooth scrolling and scroll snapping are still disabled.
    window.scrollTo({ left: s.x, top: s.y, behavior: "instant" });
    s.style?.remove();
    document.removeEventListener("keydown", onKey, true);
    for (const name of ["wheel", "touchmove", "pointerdown"]) document.removeEventListener(name, onInput, true);
  }

  function cancel() {
    const id = session?.id;
    restore();
    if (id) chrome.runtime.sendMessage({ target: "background", type: "CANCEL", id }).catch(() => {});
  }

  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
    else if (session?.capturing && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      event.preventDefault();
    }
  }
  function onInput(event) { if (session?.capturing) { event.preventDefault(); event.stopImmediatePropagation(); } }

  function begin(id) {
    if (session) throw new Error("页面已有截图任务。");
    session = { id, x: scrollX, y: scrollY, touched: Date.now(), changed: new Map(), capturing: false };
    session.watchdog = setInterval(() => {
      if (session && Date.now() - session.touched > 30_000) restore();
    }, 2000);
    document.addEventListener("keydown", onKey, true);
  }

  function adjustElement(element, s) {
    if (!(element instanceof HTMLElement) || s.changed.has(element) || element === s.host) return;
    const position = getComputedStyle(element).position;
    const changes = position === "fixed" ? { visibility: "hidden", opacity: "0" }
      : position === "sticky" ? { position: "relative", top: "auto", right: "auto", bottom: "auto", left: "auto" } : null;
    if (!changes) return;
    s.changed.set(element, Object.keys(changes).map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]));
    for (const [key, value] of Object.entries(changes)) element.style.setProperty(key, value, "important");
  }

  function prepare(s) {
    s.removeSelectionListener?.();
    s.host?.remove();
    s.capturing = true;
    s.style = document.createElement("style");
    s.style.textContent = `* { scroll-behavior: auto !important; scroll-snap-type: none !important;
      overflow-anchor: none !important; animation-play-state: paused !important;
      transition: none !important; caret-color: transparent !important; }
      *::-webkit-scrollbar { visibility: hidden !important; }`;
    document.documentElement.append(s.style);
    document.querySelectorAll("*").forEach(element => adjustElement(element, s));
    s.observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        adjustElement(node, s);
        node.querySelectorAll?.("*").forEach(element => adjustElement(element, s));
      }
    });
    s.observer.observe(document.documentElement, { childList: true, subtree: true });
    for (const name of ["wheel", "touchmove", "pointerdown"]) document.addEventListener(name, onInput, { capture: true, passive: false });
  }

  async function settle(id, x, y) {
    window.scrollTo({ left: x, top: y, behavior: "instant" });
    let previous = "", stable = 0;
    const started = Date.now();
    while (Date.now() - started < 5000) {
      await delay(120);
      requireSession(id);
      const view = measure();
      const signature = JSON.stringify(view);
      const imagesLoading = [...document.images].some(img => {
        if (img.complete) return false;
        const rect = img.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      });
      stable = signature === previous && !imagesLoading ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return view;
    }
    throw new Error("页面仍在移动或图片尚未加载，请等待页面稳定后重试。");
  }

  function select(s) {
    const page = measure();
    const host = document.createElement("div");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box} #panel{pointer-events:auto;position:absolute;right:16px;top:16px;width:300px;padding:16px;background:#182231;color:white;border-radius:12px;box-shadow:0 5px 25px #0006;font:14px/1.5 system-ui}
      h2{font-size:16px;margin:0 0 8px} p{margin:8px 0} .fields{display:grid;grid-template-columns:1fr 1fr;gap:8px} label{display:block} input{width:100%;padding:6px;border:1px solid #8796ab;border-radius:4px} button{padding:7px;margin:5px 3px 0 0;cursor:pointer} #hint{font-size:12px;color:#d5e6ff} #outline{position:fixed;border:2px solid #2687ff;background:#2687ff15;pointer-events:none} #picker{position:absolute;inset:0;pointer-events:auto;cursor:crosshair} [hidden]{display:none!important}
      </style><div id="outline"></div><div id="picker" hidden></div><section id="panel">
      <h2>选择长截图区域</h2><p>先点选左上角，滚动页面后再点选右下角；也可直接修改边界。</p>
      <div class="fields"><label>左<input id="left" type="number" min="0" value="0"></label><label>右<input id="right" type="number" min="1" value="${page.clientWidth}"></label><label>上<input id="top" type="number" min="0" value="0"></label><label>下<input id="bottom" type="number" min="1" value="${page.height}"></label></div>
      <button id="first">点选左上角</button><button id="second">点选右下角</button><button id="capture">开始截图</button><button id="cancel">取消</button><p id="hint">滚动不会改变已选边界。Esc 可取消。</p></section>`;
    s.host = host;
    document.documentElement.append(host);
    const $ = id => shadow.getElementById(id);
    const values = () => Object.fromEntries(["left", "right", "top", "bottom"].map(key => [key, Number($(key).value)]));
    const update = () => {
      const v = values();
      $("outline").style.cssText = `left:${v.left - scrollX}px;top:${v.top - scrollY}px;width:${Math.max(0, v.right - v.left)}px;height:${Math.max(0, v.bottom - v.top)}px`;
    };
    window.addEventListener("scroll", update, { passive: true });
    s.removeSelectionListener = () => window.removeEventListener("scroll", update);
    shadow.addEventListener("input", update);
    for (const [button, keys] of [["first", ["left", "top"]], ["second", ["right", "bottom"]]]) {
      $(button).onclick = () => {
        $("picker").hidden = false;
        $("hint").textContent = "滚动到目标位置后，点击页面设置此角。";
        $("picker").onclick = event => {
          event.preventDefault(); event.stopPropagation();
          $(keys[0]).value = Math.round(event.clientX + scrollX);
          $(keys[1]).value = Math.round(event.clientY + scrollY);
          $("picker").hidden = true;
          update();
        };
      };
    }
    $("cancel").onclick = cancel;
    $("capture").onclick = async () => {
      $("capture").disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ target: "background", type: "REGION", id: s.id, edges: values() });
        if (!response?.ok) throw new Error(response?.error || "启动失败。");
      } catch (error) {
        $("hint").textContent = error.message;
        $("capture").disabled = false;
      }
    };
    update();
  }

  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (m?.target !== "content" || sender.id !== chrome.runtime.id) return;
    (async () => {
      if (m.type === "BEGIN") { begin(m.id); if (m.mode === "region") select(session); return measure(); }
      // Idempotent cleanup must not clean up a newer session.
      if (m.type === "FINISH") { if (session?.id === m.id) restore(); return {}; }
      const s = requireSession(m.id);
      if (m.type === "TOUCH") return {};
      if (m.type === "PREPARE") { prepare(s); return measure(); }
      if (m.type === "SCROLL") return settle(m.id, m.x, m.y);
      if (m.type === "MEASURE") return measure();
      throw new Error("未知页面消息。");
    })().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
