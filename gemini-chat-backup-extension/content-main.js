(function () {
  const BRIDGE_EVENT = "gemini-backup-bridge";

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (message?.source !== "gemini-backup-isolated") {
      return;
    }

    try {
      if (message.command === "EXPORT_CURRENT_MD") {
        const snapshot = await captureCurrentConversation();
        sendResult(message.requestId, {
          ok: true,
          type: "md",
          filename: `${safeFilename(snapshot.title)}.md`,
          markdown: snapshot.markdown
        });
        return;
      }

      if (message.command === "BACKUP_HISTORY_ZIP") {
        const limit = Number.isFinite(message.limit) ? message.limit : 9999;
        const archive = await backupHistory({ limit, mode: message.mode });
        sendResult(message.requestId, {
          ok: true,
          type: "zip",
          filename: archive.filename,
          base64: archive.base64
        });
        return;
      }

      throw new Error("未知命令。");
    } catch (error) {
      sendResult(message.requestId, { ok: false, error: error.message || String(error) });
    }
  });

  function sendResult(requestId, response) {
    window.postMessage({ source: BRIDGE_EVENT, requestId, response }, window.location.origin);
  }

  async function backupHistory({ limit, mode }) {
    const originalUrl = normalizedUrl(window.location.href);
    const links = collectHistoryLinks()
      .filter((item) => normalizedUrl(item.href) !== originalUrl)
      .slice(0, limit);

    if (!links.length) {
      throw new Error("未找到可备份的历史会话链接。请确认左侧历史列表已展开。");
    }

    const files = [];
    const seenUrls = new Set();

    for (const link of links) {
      if (seenUrls.has(normalizedUrl(link.href))) {
        continue;
      }
      seenUrls.add(normalizedUrl(link.href));

      await openConversation(link.href);
      await wakeupFullDOMEngine();

      const textLength = getVisibleConversationText().length;
      await sleep(humanDelay(textLength, mode));

      const snapshot = await captureCurrentConversation();
      files.push({
        name: `${safeFilename(snapshot.title || link.title)}.md`,
        content: snapshot.markdown
      });

      if (files.length >= limit) {
        break;
      }
    }

    const zip = new NativeZipEncoder();
    files.forEach((file, index) => {
      zip.addFile(`${String(index + 1).padStart(3, "0")}_${file.name}`, file.content);
    });

    const today = dateStamp();
    const filename =
      mode === "test"
        ? `Gemini_测试备份_3P_${today}.zip`
        : `Gemini_全量历史备份_${today}.zip`;

    return { filename, base64: bytesToBase64(zip.encode()) };
  }

  async function captureCurrentConversation() {
    await wakeupFullDOMEngine();

    const title = extractTitle();
    const turns = extractTurns();
    const userCount = turns.filter((turn) => turn.role === "user").length;
    const aiCount = turns.filter((turn) => turn.role === "ai").length;

    if (!turns.length) {
      throw new Error("当前页面未解析到会话内容。");
    }

    const body = turns
      .map((turn) => `## ${turn.role === "user" ? "User" : "Gemini"}\n\n${turn.text}`)
      .join("\n\n");

    const markdown = [
      `# ${title}`,
      `*备份时间: ${new Date().toLocaleString()}*`,
      `*统计: 用户 ${userCount} 条 / AI ${aiCount} 条*`,
      "---",
      "",
      body,
      ""
    ].join("\n");

    return { title, markdown, userCount, aiCount };
  }

  function extractTurns() {
    const userSelectors = [".query-text", ".user-query"];
    const aiSelectors = [".markdown-main-panel", "[id^='model-response-message-content']"];
    const nodes = [
      ...queryNodes(userSelectors).map((node) => ({ role: "user", node })),
      ...queryNodes(aiSelectors).map((node) => ({ role: "ai", node }))
    ];

    return nodes
      .filter(({ node }) => isVisible(node))
      .sort((a, b) => {
        if (a.node === b.node) {
          return 0;
        }
        return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .map(({ role, node }) => ({ role, text: cleanTurnText(node.innerText || node.textContent || "", role) }))
      .filter((turn) => turn.text);
  }

  function queryNodes(selectors) {
    const seen = new Set();
    const nodes = [];
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!seen.has(node)) {
          seen.add(node);
          nodes.push(node);
        }
      });
    });
    return nodes;
  }

  function cleanTurnText(text, role) {
    let cleaned = text
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();

    if (role === "ai") {
      cleaned = cleaned
        .replace(/(?:^|\n)\s*(分享|复制|重新生成|朗读|更多|volume_up|content_copy|thumb_up|thumb_down|refresh)\s*$/gim, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    return cleaned;
  }

  function extractTitle() {
    const candidates = [
      document.querySelector("title")?.textContent,
      document.querySelector("h1")?.innerText,
      document.querySelector("[data-test-id='conversation-title']")?.innerText,
      document.querySelector("main")?.innerText?.split("\n").find(Boolean)
    ];
    const title = candidates.map((item) => cleanTitle(item || "")).find(Boolean);
    return title || `Gemini_Conversation_${dateStamp()}`;
  }

  function cleanTitle(title) {
    return title
      .replace(/\s+-\s+Gemini\s*$/i, "")
      .replace(/^Gemini\s*[-|]\s*/i, "")
      .trim()
      .slice(0, 80);
  }

  function collectHistoryLinks() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const seen = new Set();
    const links = [];

    anchors.forEach((anchor) => {
      const href = new URL(anchor.getAttribute("href"), window.location.origin).href;
      const url = new URL(href);
      const looksLikeGeminiChat =
        url.origin === window.location.origin &&
        /^\/(?:app|u\/\d+\/app)\//.test(url.pathname) &&
        !url.pathname.endsWith("/app");

      if (!looksLikeGeminiChat || seen.has(normalizedUrl(href))) {
        return;
      }

      const title = cleanTitle(anchor.innerText || anchor.getAttribute("aria-label") || "");
      if (!title) {
        return;
      }

      seen.add(normalizedUrl(href));
      links.push({ href, title });
    });

    return links;
  }

  async function openConversation(href) {
    const link = Array.from(document.querySelectorAll("a[href]")).find((anchor) => {
      const anchorHref = new URL(anchor.getAttribute("href"), window.location.origin).href;
      return normalizedUrl(anchorHref) === normalizedUrl(href);
    });

    if (link) {
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      link.click();
    } else {
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    await waitForUrl(href, 9000);
    await sleep(900);
  }

  async function waitForUrl(targetHref, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (normalizedUrl(window.location.href) === normalizedUrl(targetHref)) {
        return;
      }
      await sleep(150);
    }
  }

  async function wakeupFullDOMEngine() {
    const container = findScrollContainer();
    if (!container) {
      return;
    }

    container.scrollTo({ top: 0, behavior: "auto" });
    await sleep(500);

    let lastTop = -1;
    let stableTicks = 0;
    while (stableTicks < 3) {
      container.scrollTo({ top: container.scrollTop + 1000, behavior: "smooth" });
      await sleep(250);

      if (Math.abs(container.scrollTop - lastTop) < 8 || container.scrollTop + container.clientHeight >= container.scrollHeight - 8) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
      }
      lastTop = container.scrollTop;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    await sleep(600);
  }

  function findScrollContainer() {
    const candidates = [
      document.querySelector("main"),
      document.querySelector("[role='main']"),
      document.scrollingElement,
      document.documentElement
    ].filter(Boolean);

    return candidates.find((node) => node.scrollHeight > node.clientHeight + 80) || document.scrollingElement;
  }

  function getVisibleConversationText() {
    const main = document.querySelector("main") || document.body;
    return main?.innerText || "";
  }

  function humanDelay(textLength, mode) {
    if (mode === "test") {
      return 900 + Math.random() * 500;
    }

    const base = 2800 + Math.random() * 1200;
    const reading = Math.min(4000, Math.floor(textLength / 500) * 800);
    return base + reading;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizedUrl(href) {
    const url = new URL(href, window.location.origin);
    url.hash = "";
    url.search = "";
    return url.href.replace(/\/$/, "");
  }

  function safeFilename(filename) {
    return (filename || "Gemini_Conversation")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  }

  function dateStamp() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  class NativeZipEncoder {
    constructor() {
      this.files = [];
    }

    addFile(name, content) {
      const encodedName = utf8Bytes(name);
      const data = utf8Bytes(content);
      this.files.push({
        name,
        encodedName,
        data,
        crc: crc32(data),
        modified: dosDateTime(new Date())
      });
    }

    encode() {
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      this.files.forEach((file) => {
        const localHeader = concatBytes(
          u32(0x04034b50),
          u16(20),
          u16(0x0800),
          u16(0),
          u16(file.modified.time),
          u16(file.modified.date),
          u32(file.crc),
          u32(file.data.length),
          u32(file.data.length),
          u16(file.encodedName.length),
          u16(0),
          file.encodedName
        );
        localParts.push(localHeader, file.data);

        const centralHeader = concatBytes(
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x0800),
          u16(0),
          u16(file.modified.time),
          u16(file.modified.date),
          u32(file.crc),
          u32(file.data.length),
          u32(file.data.length),
          u16(file.encodedName.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
          file.encodedName
        );
        centralParts.push(centralHeader);
        offset += localHeader.length + file.data.length;
      });

      const centralDirectory = concatBytes(...centralParts);
      const localData = concatBytes(...localParts);
      const endRecord = concatBytes(
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(this.files.length),
        u16(this.files.length),
        u32(centralDirectory.length),
        u32(localData.length),
        u16(0)
      );

      return concatBytes(localData, centralDirectory, endRecord);
    }
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(text);
  }

  function concatBytes(...parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function u16(value) {
    const bytes = new Uint8Array(2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, value, true);
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, value >>> 0, true);
    return bytes;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { date: dosDate, time: dosTime };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  })();
})();
