(() => {
  if (window.__longScreenshotV2) return;
  window.__longScreenshotV2 = true;
  let session;
  let progress;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function showProgress(status) {
    if (!progress || progress.id !== status.id) return;
    const { host, shadow } = progress;
    host.style.setProperty("visibility", "visible", "important");
    shadow.querySelector("p").textContent = status.message;
    const result = status.result;
    shadow.querySelector("pre").textContent = result
      ? `${result.filename.split(/[\\/]/).pop()}\n${result.filename}\n${result.width} × ${result.height} 像素${result.bytes >= 0 ? ` · ${(result.bytes / 1048576).toFixed(2)} MB` : ""}` : "";
    shadow.querySelector("#cancel").hidden = !status.busy;
    shadow.querySelector("#close").hidden = !!status.busy;
    shadow.querySelector("#show").hidden = !result;
  }

  function progressPanel(id) {
    progress?.host.remove();
    const host = document.createElement("div");
    host.id = "long-screenshot-v2-progress";
    host.style.cssText = "all:initial!important;position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{color-scheme:light}section{width:310px;max-height:45vh;overflow:auto;padding:16px;background:#182231;color:white;border-radius:12px;box-shadow:0 5px 25px #0006;font:14px/1.5 system-ui}p{margin:0 0 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 system-ui}button{padding:7px;cursor:pointer}[hidden]{display:none}</style><section role="status" aria-live="polite"><p></p><pre></pre><button id="cancel">取消</button><button id="show" hidden>在 Finder 中显示</button><button id="close" hidden>关闭</button></section>`;
    progress = { id, host, shadow };
    shadow.querySelector("#cancel").onclick = cancel;
    shadow.querySelector("#close").onclick = () => host.remove();
    shadow.querySelector("#show").onclick = async () => {
      const response = await chrome.runtime.sendMessage({ target: "background", type: "SHOW", id });
      if (!response?.ok) shadow.querySelector("p").textContent = response?.error || "无法显示文件。";
    };
    document.documentElement.append(host);
    showProgress({ id, busy: true, message: "正在准备…" });
  }

  function measure() {
    const root = document.documentElement;
    return { x: scrollX, y: scrollY, innerWidth, innerHeight,
      clientWidth: root.clientWidth, clientHeight: root.clientHeight,
      width: Math.max(root.scrollWidth, document.body?.scrollWidth || 0, root.clientWidth),
      height: Math.max(root.scrollHeight, document.body?.scrollHeight || 0, root.clientHeight),
      dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1 };
  }

  // Element references live only for this document/session, never in the worker.
  function anchorAt(s, x, y) {
    s.host.style.setProperty("visibility", "hidden", "important");
    progress?.host.style.setProperty("visibility", "hidden", "important");
    let element;
    try { element = document.elementFromPoint(x, y); }
    finally {
      s.host.style.removeProperty("visibility");
      progress?.host.style.removeProperty("visibility");
    }
    if (!element || element === s.host || element === progress?.host) throw new Error("无法定位所选内容，请重新点选。");
    const rect = element.getBoundingClientRect();
    return { element, dx: x - rect.left, dy: y - rect.top,
      width: rect.width, height: rect.height,
      insets: { left: x - rect.left, top: y - rect.top, right: rect.right - x, bottom: rect.bottom - y },
      initial: { x: x + scrollX, y: y + scrollY } };
  }

  function resolveRegion(s) {
    if (!s.edges) return null;
    let edges = s.edges;
    if (s.anchors?.first && s.anchors?.second) {
      const point = anchor => {
        if (!anchor.element.isConnected) throw new Error("所选内容锚点已失效，请重新选择区域。");
        const style = getComputedStyle(anchor.element);
        if (style.visibility !== "visible" || Number(style.opacity) === 0) throw new Error("所选内容锚点不可见，请重新选择区域。");
        const r = anchor.element.getBoundingClientRect();
        // Compare to selection geometry, never rebase offsets onto a resized element.
        // One layout unit tolerates rounding noise without accumulating drift.
        if (Math.abs(r.width - anchor.width) > 1 / 64 || Math.abs(r.height - anchor.height) > 1 / 64) {
          throw Object.assign(new Error("所选内容锚点尺寸已变化，请重新选择区域。"), { layout: true });
        }
        if (!r.width || !r.height || anchor.dx > r.width || anchor.dy > r.height) {
          throw Object.assign(new Error("所选内容本身持续变化，请稍后重试。"), { layout: true });
        }
        return { x: r.left + scrollX + anchor.dx, y: r.top + scrollY + anchor.dy };
      };
      const a = point(s.anchors.first), b = point(s.anchors.second);
      edges = { left: a.x, top: a.y, right: b.x, bottom: b.y };
    }
    const region = { x: edges.left, y: edges.top, width: edges.right - edges.left, height: edges.bottom - edges.top };
    if (region.width <= 0 || region.height <= 0) throw Object.assign(new Error("所选内容本身持续变化，请稍后重试。"), { layout: true });
    return region;
  }

  function regionView(s) {
    const view = measure(), region = resolveRegion(s);
    if (!region) return view;
    // Compare only nodes intersecting the selected scope. Ancestor page shells
    // and outside modules must not turn document growth into scope invalidation.
    s.nodeIds ||= new WeakMap();
    s.nextNodeId ||= 1;
    const scope = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (element === s.host || element === progress?.host || /^(SCRIPT|STYLE)$/.test(element.tagName)) continue;
      if (s.anchors?.first && s.anchors?.second && element !== s.anchors.first.element && element !== s.anchors.second.element &&
          element.contains(s.anchors.first.element) && element.contains(s.anchors.second.element)) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== "visible" || Number(style.opacity) === 0 ||
          (style.position === "fixed" && Number(style.zIndex) < 0)) continue;
      const r = element.getBoundingClientRect();
      const x = r.left + scrollX - region.x, y = r.top + scrollY - region.y;
      if (!r.width || !r.height || x >= region.width || y >= region.height || x + r.width <= 0 || y + r.height <= 0) continue;
      if (x < 0 && y < 0 && x + r.width > region.width && y + r.height > region.height && element.children.length) continue;
      if (!s.nodeIds.has(element)) s.nodeIds.set(element, s.nextNodeId++);
      scope.push([s.nodeIds.get(element), ...[x, y, r.width, r.height].map(n => Math.round(n * 64) / 64),
        [...element.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(""),
        element instanceof HTMLImageElement ? element.currentSrc : ""]);
    }
    return { ...view, region, scope: JSON.stringify(scope) };
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
  function onInput(event) { if (event.composedPath().includes(progress?.host)) return; if (session?.capturing) { event.preventDefault(); event.stopImmediatePropagation(); } }

  function begin(id) {
    if (session) throw new Error("页面已有截图任务。");
    session = { id, x: scrollX, y: scrollY, touched: Date.now(), changed: new Map(), candidates: new Set(), capturing: false };
    session.watchdog = setInterval(() => {
      if (session && Date.now() - session.touched > 30_000) restore();
    }, 2000);
    progressPanel(id);
    document.addEventListener("keydown", onKey, true);
  }

  function adjustElement(element, s) {
    if (!(element instanceof HTMLElement) || s.changed.has(element) || element === s.host || element === progress?.host) return;
    const style = getComputedStyle(element);
    const position = style.position;
    if (position !== "fixed" && position !== "sticky") return;
    s.candidates.add(element);
    const rect = element.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    if (style.visibility !== "visible" || Number(style.opacity) === 0 ||
        rect.width < 16 || rect.height < 16 || rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= height || rect.left >= width || Number(style.zIndex) < 0) return;
    // Leave large application shells/backgrounds alone. Only bounded overlays
    // or sticky blocks with an actual inset are likely to repeat over content.
    if (rect.width * rect.height > width * height * 0.65) return;
    const atEdge = rect.top <= 2 || rect.left <= 2 || rect.bottom >= height - 2 || rect.right >= width - 2;
    if (position === "fixed" && !atEdge && !(Number(style.zIndex) > 0)) return;
    if (position === "sticky" && [style.top, style.right, style.bottom, style.left].every(value => value === "auto")) return;
    const changes = position === "fixed" ? { visibility: "hidden", opacity: "0" }
      : { position: "relative", top: "auto", right: "auto", bottom: "auto", left: "auto" };
    s.changed.set(element, Object.keys(changes).map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]));
    for (const [key, value] of Object.entries(changes)) element.style.setProperty(key, value, "important");
  }

  function prepare(s) {
    if (s.capturing) throw new Error("页面已进入截图阶段。");
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

  async function settle(id, x, y, relative) {
    requireSession(id);
    const move = () => {
      const r = relative ? resolveRegion(requireSession(id)) : null;
      window.scrollTo({ left: x + (r?.x || 0), top: y + (r?.y || 0), behavior: "instant" });
    };
    move();
    let previous = "", stable = 0;
    const started = Date.now();
    while (Date.now() - started < 5000) {
      await delay(120);
      const s = requireSession(id);
      // Revisit off-viewport candidates once they become visible while scrolling.
      for (const element of s.candidates) {
        if (!element.isConnected) s.candidates.delete(element);
        else adjustElement(element, s);
      }
      if (relative) move();
      const view = regionView(s);
      const signature = JSON.stringify(view.region ? { ...view, width: 0, height: 0,
        x: view.x - view.region.x, y: view.y - view.region.y, region: { width: view.region.width, height: view.region.height } } : view);
      const imagesLoading = [...document.images].some(img => {
        if (img.complete) return false;
        const rect = img.getBoundingClientRect();
        if (view.region && (rect.right + scrollX <= view.region.x || rect.left + scrollX >= view.region.x + view.region.width ||
            rect.bottom + scrollY <= view.region.y || rect.top + scrollY >= view.region.y + view.region.height)) return false;
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      });
      stable = signature === previous && !imagesLoading ? stable + 1 : 0;
      previous = signature;
      if (stable >= (relative ? 1 : 3)) return view;
    }
    throw Object.assign(new Error(session?.edges ? "所选内容本身持续变化，请稍后重试。"
      : "页面仍在移动或图片尚未加载，请等待页面稳定后重试。"), { layout: !!session?.edges });
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
      <button id="first">点选左上角</button><button id="second">点选右下角</button><button id="capture">开始截图</button><button id="cancel">取消</button><p id="hint">点选跟随内容；修改数字使用固定坐标。Esc 可取消。</p></section>`;
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
    shadow.addEventListener("input", () => { s.anchors = null; update(); });
    for (const [button, keys] of [["first", ["left", "top"]], ["second", ["right", "bottom"]]]) {
      $(button).onclick = () => {
        $("picker").hidden = false;
        $("hint").textContent = "滚动到目标位置后，点击页面设置此角。";
        $("picker").onclick = event => {
          event.preventDefault(); event.stopPropagation();
          try {
            s.anchors ||= {};
            s.anchors[button] = anchorAt(s, event.clientX, event.clientY);
          } catch (error) { $("hint").textContent = error.message; return; }
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
        s.edges = values();
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
      if (m.type === "PROGRESS") { showProgress(m.status); return {}; }
      const s = requireSession(m.id);
      if (m.type === "HIDE_UI") {
        progress?.host.style.setProperty("visibility", "hidden", "important");
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return measure();
      }
      if (m.type === "SHOW_UI") { if (progress) progress.host.style.setProperty("visibility", "visible", "important"); return {}; }
      if (m.type === "TOUCH") return {};
      if (m.type === "PREPARE") { s.edges = m.edges || s.edges; prepare(s); return measure(); }
      if (m.type === "SCROLL") return settle(m.id, m.x, m.y, m.relative);
      if (m.type === "MEASURE") return m.viewportOnly
        ? { ...measure(), anchored: !!(s.anchors?.first && s.anchors?.second) } : regionView(s);
      throw new Error("未知页面消息。");
    })().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message, layout: !!error.layout }));
    return true;
  });
})();
