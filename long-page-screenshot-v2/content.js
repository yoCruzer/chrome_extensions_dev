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

  // A target owns content coordinates; bitmap coordinates remain browser-local.
  function targetView(s) {
    const view = measure(), element = s.target?.element;
    if (!element) return { ...view, targetKind: "window", viewportRect: { left: 0, top: 0 } };
    const r = element.getBoundingClientRect();
    if (!element.isConnected || !r.width || !r.height || getComputedStyle(element).visibility !== "visible") {
      throw Object.assign(new Error("所选滚动容器已失效，请重新选择区域。"), { reasonCode: "TARGET_UNRESOLVABLE" });
    }
    const left = Math.max(0, r.left + element.clientLeft), top = Math.max(0, r.top + element.clientTop);
    const right = Math.min(innerWidth, r.left + element.clientLeft + element.clientWidth);
    const bottom = Math.min(innerHeight, r.top + element.clientTop + element.clientHeight);
    if (right <= left || bottom <= top) throw new Error("所选滚动容器不可见。");
    return { ...view, targetKind: "element", viewportRect: { left, top },
      x: element.scrollLeft + left - r.left - element.clientLeft,
      y: element.scrollTop + top - r.top - element.clientTop,
      clientWidth: right - left, clientHeight: bottom - top,
      width: element.scrollWidth, height: element.scrollHeight };
  }

  function targetPoint(s, x, y) {
    const view = targetView(s);
    return { x: x - view.viewportRect.left + view.x, y: y - view.viewportRect.top + view.y };
  }

  function detectTarget(s) {
    const first = s.anchors?.first?.element, second = s.anchors?.second?.element;
    let selected;
    for (let element = first; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      const style = getComputedStyle(element), r = element.getBoundingClientRect();
      if (element.isConnected && r.width > 0 && r.height > 0 && style.visibility === "visible" &&
          (!second || element.contains(second)) &&
          ((/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) ||
           (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth))) {
        selected = element; break;
      }
    }
    if (selected && !s.targetScrolls.has(selected)) s.targetScrolls.set(selected, { x: selected.scrollLeft, y: selected.scrollTop });
    s.target = selected ? { element: selected } : null;
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
    return { element, scrollLeft: element.scrollLeft || 0, scrollTop: element.scrollTop || 0, dx: x - rect.left, dy: y - rect.top,
      width: rect.width, height: rect.height,
      rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height },
      rx: (x - rect.left) / rect.width, ry: (y - rect.top) / rect.height,
      insets: { left: x - rect.left, top: y - rect.top, right: rect.right - x, bottom: rect.bottom - y },
      initial: { x: x + scrollX, y: y + scrollY } };
  }

  function resolveRegion(s) {
    if (!s.edges) return null;
    let edges = s.edges;
    if (s.anchors?.first && s.anchors?.second) {
      s.anchorDiagnostics = {};
      const point = (anchor, role) => {
        const r = anchor.element.getBoundingClientRect();
        const style = getComputedStyle(anchor.element);
        const diagnostic = s.anchorDiagnostics[role] = {
          connected: anchor.element.isConnected, before: anchor.rect,
          current: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
          mode: "unresolvable", point: null
        };
        if (!diagnostic.connected || style.visibility !== "visible" || Number(style.opacity) === 0 ||
            ![r.width, r.height].every(n => Number.isFinite(n) && n > 0)) {
          throw Object.assign(new Error("所选内容锚点已失效，请重新选择区域。"), {
            reasonCode: "ANCHOR_UNRESOLVABLE", diagnostics: { anchors: s.anchorDiagnostics }
          });
        }
        const unchanged = r.width === anchor.width && r.height === anchor.height;
        let edge = false;
        const offset = (size, original, local, ratio, start, end) => {
          if (size === original) return local;
          const inset = role === "first" ? start : end;
          if (inset <= Math.min(24, original * 0.1)) {
            edge = true;
            return role === "first" ? Math.min(inset, size) : Math.max(0, size - inset);
          }
          return ratio * size;
        };
        const dx = offset(r.width, anchor.width, anchor.dx, anchor.rx, anchor.insets.left, anchor.insets.right);
        const dy = offset(r.height, anchor.height, anchor.dy, anchor.ry, anchor.insets.top, anchor.insets.bottom);
        diagnostic.mode = unchanged ? "exact" : edge ? "edge-affinity" : "ratio";
        diagnostic.point = anchor.element === s.target?.element
          ? { x: anchor.dx - anchor.element.clientLeft + anchor.scrollLeft, y: anchor.dy - anchor.element.clientTop + anchor.scrollTop }
          : targetPoint(s, r.left + dx, r.top + dy);
        return diagnostic.point;
      };
      const a = point(s.anchors.first, "first"), b = point(s.anchors.second, "second");
      edges = { left: a.x, top: a.y, right: b.x, bottom: b.y };
    }
    const region = { x: edges.left, y: edges.top, width: edges.right - edges.left, height: edges.bottom - edges.top };
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) throw Object.assign(new Error("选区无效，请重新选择区域。"), { reasonCode: "REGION_INVALID", diagnostics: { anchors: s.anchorDiagnostics, region } });
    return region;
  }

  function fullProof(s, watch = false) {
    if (!s.fullProof) return;
    const proof = s.fullProof;
    const fail = () => { throw Object.assign(new Error("已截图内容发生变化，需要重新截图。"), { layout: true, reasonCode: "FULL_REFLOW" }); };
    if (proof.invalid) fail();
    for (const [element, before] of proof.nodes) {
      const r = element.getBoundingClientRect();
      const current = [r.left + scrollX, r.top + scrollY, r.width, r.height];
      if (!element.isConnected || current.some((n, i) => Math.abs(n - before[i]) > 0.5)) fail();
    }
    if (!watch) return;
    // Geometric witnesses of painted leaf boxes, not a DOM fingerprint. Appending
    // below them leaves these coordinates valid; insertion/reflow above does not.
    for (const element of document.querySelectorAll("body *")) {
      if (element === progress?.host || element === s.host || element.children.length ||
          ["SCRIPT", "STYLE", "LINK"].includes(element.tagName)) continue;
      const r = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth ||
          !r.width || !r.height || style.visibility !== "visible" || style.position === "fixed") continue;
      proof.nodes.set(element, [r.left + scrollX, r.top + scrollY, r.width, r.height]);
    }
    if (proof.nodes.size > 20000) throw new Error("页面内容过多，请改用选择区域。");
    proof.end = Math.max(proof.end, Math.min(measure().height, scrollY + innerHeight));
  }

  function regionView(s) {
    fullProof(s);
    const view = targetView(s), region = resolveRegion(s);
    if (!region) return view;
    return { ...view, region, anchors: s.anchorDiagnostics };
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
    for (const [element, point] of s.targetScrolls) {
      if (element.isConnected) element.scrollTo({ left: point.x, top: point.y, behavior: "instant" });
    }
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
    session = { id, x: scrollX, y: scrollY, touched: Date.now(), changed: new Map(), targetScrolls: new Map(), candidates: new Set(), capturing: false };
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
        rect.width < 16 || rect.height < 16 || Number(style.zIndex) < 0 ||
        (s.mode !== "region" && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= height || rect.left >= width))) return;
    // Leave large application shells/backgrounds alone. Only bounded overlays
    // or sticky blocks with an actual inset are likely to repeat over content.
    if (rect.width * rect.height > width * height * 0.65) return;
    const atEdge = rect.top <= 2 || rect.left <= 2 || rect.bottom >= height - 2 || rect.right >= width - 2;
    if (position === "fixed" && !atEdge && !(Number(style.zIndex) > 0)) return;
    if (position === "sticky" && [style.top, style.right, style.bottom, style.left].every(value => value === "auto")) return;
    const changes = s.mode === "region" || position === "fixed" ? { visibility: "hidden", opacity: "0" }
      : { position: "relative", top: "auto", right: "auto", bottom: "auto", left: "auto" };
    s.changed.set(element, Object.keys(changes).map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]));
    for (const [key, value] of Object.entries(changes)) element.style.setProperty(key, value, "important");
  }

  function prepare(s) {
    if (s.capturing) throw new Error("页面已进入截图阶段。");
    s.removeSelectionListener?.();
    s.host?.remove();
    s.capturing = true;
    if (!s.style) establishLayout(s);
    for (const name of ["wheel", "touchmove", "pointerdown"]) document.addEventListener(name, onInput, { capture: true, passive: false });
  }

  function establishLayout(s) {
    s.style = document.createElement("style");
    s.style.textContent = `* { scroll-behavior: auto !important; scroll-snap-type: none !important;
      overflow-anchor: none !important; animation-play-state: paused !important;
      transition: none !important; caret-color: transparent !important; }
      *::-webkit-scrollbar { visibility: hidden !important; }`;
    document.documentElement.append(s.style);
    document.querySelectorAll("*").forEach(element => adjustElement(element, s));
    s.observer = new MutationObserver(records => {
      if (s.fullProof) for (const record of records) {
        const proof = s.fullProof;
        if (record.target === progress?.host || record.target === s.host) continue;
        const changed = record.target.nodeType === 3 ? record.target.parentElement : record.target;
        if (changed instanceof HTMLElement && (record.type === "characterData" || record.type === "attributes" || proof.nodes.has(changed))) {
          const r = changed.getBoundingClientRect();
          if (r.width && r.height && r.top + scrollY < proof.end - 0.5 &&
              getComputedStyle(changed).visibility === "visible" && getComputedStyle(changed).position !== "fixed") proof.invalid = true;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node === progress?.host || node === s.host || node === s.style) continue;
          const r = node.getBoundingClientRect();
          if (r.width && r.height && r.top + scrollY < proof.end - 0.5 && getComputedStyle(node).position !== "fixed") proof.invalid = true;
        }
      }
      for (const record of records) for (const node of record.addedNodes) {
        adjustElement(node, s);
        node.querySelectorAll?.("*").forEach(element => adjustElement(element, s));
      }
    });
    s.observer.observe(document.documentElement, { childList: true, subtree: true, ...(s.mode === "full" ? { characterData: true, attributes: true, attributeFilter: ["style", "class", "src", "width", "height"] } : {}) });
  }

  async function settle(id, x, y, relative) {
    requireSession(id);
    const move = () => {
      const s = requireSession(id);
      const view = targetView(s);
      const r = relative ? resolveRegion(s) : null;
      const element = s.target?.element;
      (element || window).scrollTo({ left: x + (r?.x || 0) - (element ? view.x - element.scrollLeft : 0),
        top: y + (r?.y || 0) - (element ? view.y - element.scrollTop : 0), behavior: "instant" });
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
      const signature = JSON.stringify(view.region ? {
        x: view.x - view.region.x, y: view.y - view.region.y,
        width: view.region.width, height: view.region.height } : { x: view.x, y: view.y, innerWidth: view.innerWidth, innerHeight: view.innerHeight });
      const imagesLoading = [...document.images].some(img => {
        if (img.complete) return false;
        const rect = img.getBoundingClientRect();
        const a = targetPoint(s, rect.left, rect.top), b = targetPoint(s, rect.right, rect.bottom);
        if (view.region && (b.x <= view.region.x || a.x >= view.region.x + view.region.width ||
            b.y <= view.region.y || a.y >= view.region.y + view.region.height)) return false;
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      });
      stable = signature === previous && !imagesLoading ? stable + 1 : 0;
      previous = signature;
      if (stable >= (relative ? 1 : 3)) return view;
    }
    throw Object.assign(new Error(session?.edges ? "所选区域持续发生布局变化，请稍后重试。"
      : "页面仍在移动或图片尚未加载，请等待页面稳定后重试。"), { layout: !!session?.edges, reasonCode: "FRAME_NOT_SETTLED" });
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
      let v = values();
      if (s.anchors?.first && s.anchors?.second) {
        try {
          s.edges = v;
          const r = resolveRegion(s);
          v = { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
          for (const key of Object.keys(v)) $(key).value = v[key];
        } catch { /* Start reports invalid anchors. */ }
      }
      const view = targetView(s);
      $("outline").style.cssText = `left:${v.left - view.x + view.viewportRect.left}px;top:${v.top - view.y + view.viewportRect.top}px;width:${Math.max(0, v.right - v.left)}px;height:${Math.max(0, v.bottom - v.top)}px`;
      for (const key of ["left", "right", "top", "bottom"]) $(key).disabled = !!s.target;
      if (s.target) $("hint").textContent = "已选择内部滚动容器；边界显示容器内坐标，请用点选调整。";
    };
    document.addEventListener("scroll", update, { passive: true, capture: true });
    s.removeSelectionListener = () => document.removeEventListener("scroll", update, true);
    shadow.addEventListener("input", () => { s.anchors = null; s.target = null; update(); });
    for (const [button, keys] of [["first", ["left", "top"]], ["second", ["right", "bottom"]]]) {
      $(button).onclick = () => {
        $("picker").hidden = false;
        $("hint").textContent = "滚动到目标位置后，点击页面设置此角。";
        $("picker").onclick = event => {
          event.preventDefault(); event.stopPropagation();
          try {
            s.anchors ||= {};
            s.anchors[button] = anchorAt(s, event.clientX, event.clientY);
            detectTarget(s);
          } catch (error) { $("hint").textContent = error.message; return; }
          const point = targetPoint(s, event.clientX, event.clientY);
          $(keys[0]).value = point.x;
          $(keys[1]).value = point.y;
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
      if (m.type === "BEGIN") { begin(m.id); session.mode = m.mode; if (m.mode === "region") { establishLayout(session); select(session); } return measure(); }
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
      if (m.type === "PREPARE") { s.edges = m.edges || s.edges; prepare(s); return targetView(s); }
      if (m.type === "FULL_RESET") { s.fullProof = { nodes: new Map(), end: 0, invalid: false }; return {}; }
      if (m.type === "MEASURE" && m.watch) fullProof(s, true);
      if (m.type === "SCROLL") return settle(m.id, m.x, m.y, m.relative);
      if (m.type === "BOTTOM") {
        fullProof(s);
        const loading = [...document.images].some(img => {
          const r = img.getBoundingClientRect();
          return !img.complete && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        });
        return { ...measure(), loading };
      }
      if (m.type === "MEASURE") return m.viewportOnly
        ? { ...measure(), anchored: !!(s.anchors?.first && s.anchors?.second) } : regionView(s);
      throw new Error("未知页面消息。");
    })().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message, layout: !!error.layout, reasonCode: error.reasonCode, diagnostics: error.diagnostics }));
    return true;
  });
})();
