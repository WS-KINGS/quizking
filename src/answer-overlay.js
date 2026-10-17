/**
 * QuizKing read-only answer display. This normal, open DOM overlay does not
 * receive pointer/keyboard input or change the page's focus/visibility APIs.
 * @license MIT
 */
(() => {
  "use strict";
  if (window.__aqh_answer_overlay_injected__) return;
  window.__aqh_answer_overlay_injected__ = true;

  const ROOT_ID = "aqh-answer-overlay";
  let root = null;
  let warning = null;
  let content = null;
  let more = null;
  let reqId = null;
  let snapshot = null;
  let opacity = 0.4;
  let userHidden = false;
  let preparing = false;
  let prepareVersion = 0;
  let recoveryTimer = null;
  const hiddenUi = new Map();

  function clampOpacity(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0.15, Math.min(1, numeric)) : 0.4;
  }

  function style(node, values) {
    for (const [key, value] of Object.entries(values)) node.style.setProperty(key, value, "important");
  }

  function ensureRoot() {
    if (root?.isConnected) return;
    // Reuse our own detached element only; page elements with the same id are
    // never cleared, replaced or treated as extension-owned content.
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      style(root, {
        all: "initial", position: "fixed", right: "12px", bottom: "12px",
        "z-index": "2147483647", "pointer-events": "none", display: "none",
        "max-width": "min(360px, calc(100vw - 24px))", "max-height": "calc(100vh - 24px)",
        "flex-direction": "column", overflow: "hidden", opacity: String(opacity),
        "user-select": "none", animation: "none", transition: "none",
      });
      const shadow = root.attachShadow({ mode: "open" });
      [warning, content, more] = ["warning", "answer", "more"].map((name) => {
        const node = document.createElement("div");
        node.id = name;
        style(node, {
          all: "initial", display: "block", "pointer-events": "none",
          "font-family": "system-ui, sans-serif", "font-size": "12px", "line-height": "1.4",
          color: "#374151", "white-space": "pre-wrap", "overflow-wrap": "anywhere",
          "word-break": "break-all", "min-height": "0", "flex-shrink": "0",
          "text-shadow": "0 0 1px rgba(255, 255, 255, 0.8)",
          "user-select": "none", animation: "none", transition: "none",
        });
        shadow.appendChild(node);
        return node;
      });
      style(content, { "flex-shrink": "1", overflow: "hidden", "-webkit-box-orient": "vertical" });
    }
    document.documentElement.appendChild(root);
  }

  function answerOf(item) {
    let answer = String(item.answer ?? "").trim();
    if (/^(?:\{|`)/.test(answer)) {
      try {
        const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
        if (parsed && typeof parsed === "object" && parsed.answer != null) answer = String(parsed.answer).trim();
      } catch { /* Unstructured model output is displayed as plain text. */ }
    }
    return answer;
  }

  function displayParts(value) {
    if (!value) return { warnings: [], entries: [] };
    const items = Array.isArray(value.items) ? value.items.filter((item) => item && typeof item === "object") : [];
    const pending = Array.isArray(value.pending) ? value.pending.filter((item) => item && typeof item === "object") : [];
    const receivedIds = new Set(items.map((item) => item.id));
    const waiting = pending.filter((item) => !receivedIds.has(item.id));
    const multiple = items.length + waiting.length > 1;
    const warnings = [];
    const lines = [];
    const answers = items.filter((item) => item.ok === true).map(answerOf).filter(Boolean);
    const normalized = new Set(answers.map((answer) => answer.replace(/\s+/g, "")));
    if (normalized.size > 1) warnings.push("答案不一致，请核对。");
    if (value.error || value.state === "error" || items.some((item) => item.ok === false)) warnings.push("存在错误，请核对。");
    if (value.bankNotice) warnings.push("题库有提示，请核对。");
    if (value.error) lines.push("错误：" + String(value.error));
    else if (value.state === "error") lines.push("处理失败：" + String(value.status || "本次请求失败，请重试。"));
    for (const item of items) {
      const label = multiple ? String(item.label || item.model || "服务商") + "：" : "";
      if (item.ok === false) lines.push(label + "错误：" + String(item.error || "本次请求失败，请重试。"));
      else if (item.ok === true) lines.push(label + (answerOf(item) || "未返回单独答案。"));
      else lines.push(label + "等待返回…");
    }
    if (value.bankNotice) lines.push(String(value.bankNotice));
    if (value.state === "working") {
      if (!items.length) lines.push("处理中…");
      else if (waiting.length) lines.push("等待其余 " + waiting.length + " 个结果…");
    } else if (!items.length && !value.error && value.state !== "error") {
      lines.push("本次没有可显示的答案。");
    }
    return { warnings, entries: lines };
  }

  function compactLayout(parts) {
    const viewportWidth = Math.max(1, Number(window.innerWidth) || 1024);
    const viewportHeight = Math.max(1, Number(window.innerHeight) || 768);
    const margin = viewportHeight < 80 || viewportWidth < 80 ? 2 : 12;
    const width = Math.max(1, Math.min(360, viewportWidth - 2 * margin));
    const height = Math.max(1, Math.min(12 * 16.8, viewportHeight - 2 * margin));
    const columns = Math.max(1, Math.floor(width / 14));
    const lineCount = (text) => text ? text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / columns)), 0) : 0;
    let shortened = parts.entries.length > 6;
    let remaining = 400;
    const entries = parts.entries.slice(0, 6).map((entry) => {
      const chars = Array.from(entry);
      const limit = Math.max(0, Math.min(160, remaining));
      remaining -= Math.min(chars.length, limit);
      if (chars.length > limit) { shortened = true; return limit ? chars.slice(0, limit - 1).join("") + "…" : ""; }
      return entry;
    }).filter(Boolean);
    let warningText = parts.warnings.join("\n");
    let bodyText = entries.join("\n");
    const lines = Math.max(1, Math.floor(height / 16.8));
    if (lineCount(warningText) + lineCount(bodyText) > lines || lineCount(bodyText) > 8) shortened = true;
    let moreText = shortened ? (width < 200 ? "完整结果请在侧栏查看" : "内容较长，完整结果请在侧栏查看") : "";
    let bodyLines = Math.min(8, Math.max(0, lines - lineCount(warningText) - lineCount(moreText)));
    let fontSize = 12;
    if (shortened && bodyLines < 1) {
      // For very small windows reserve two visible rows for warnings and the
      // explicit truncation notice, instead of clipping them above the screen.
      warningText = parts.warnings.map((text) => text.startsWith("答案") ? "有分歧" : text.startsWith("存在") ? "有错误" : "题库提示").join(" / ");
      bodyText = "";
      moreText = "完整结果见侧栏";
      fontSize = Math.min(12, height / (warningText ? 2.8 : 1.4), width / Math.max(Array.from(warningText).length, Array.from(moreText).length));
      bodyLines = 0;
    }
    return { warningText, bodyText, moreText, bodyLines, fontSize, width, height, margin };
  }

  function render() {
    if (!root && !snapshot) return;
    ensureRoot();
    const layout = compactLayout(displayParts(snapshot));
    for (const [node, text] of [[warning, layout.warningText], [content, layout.bodyText], [more, layout.moreText]]) {
      if (node.textContent !== text) node.textContent = text;
      node.style.setProperty("font-size", layout.fontSize + "px", "important");
      node.style.setProperty("display", text ? (node === content ? "-webkit-box" : "block") : "none", "important");
    }
    content.style.setProperty("-webkit-line-clamp", String(Math.max(1, layout.bodyLines)), "important");
    content.style.setProperty("max-height", layout.bodyLines * layout.fontSize * 1.4 + "px", "important");
    style(root, { right: layout.margin + "px", bottom: layout.margin + "px", "max-width": layout.width + "px", "max-height": layout.height + "px" });
    root.style.setProperty("opacity", String(opacity), "important");
    root.style.setProperty("display", !preparing && !userHidden && (layout.warningText || layout.bodyText || layout.moreText) ? "flex" : "none", "important");
  }

  function hideExistingUi() {
    for (const id of ["aqh-root", "aqh-fab"]) {
      const node = document.getElementById(id);
      if (!node || hiddenUi.has(node)) continue;
      hiddenUi.set(node, {
        value: node.style.getPropertyValue("display"),
        priority: node.style.getPropertyPriority("display"),
      });
      node.style.setProperty("display", "none", "important");
    }
  }

  function restoreExistingUi() {
    for (const [node, previous] of hiddenUi) {
      if (previous.value) node.style.setProperty("display", previous.value, previous.priority);
      else node.style.removeProperty("display");
    }
    hiddenUi.clear();
  }

  function cancelRecovery() {
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  function restorePreparedUi() {
    cancelRecovery();
    preparing = false;
    restoreExistingUi();
    render();
  }

  function twoFrames() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ready);
      };
      // Background tabs may stop animation frames. Never leave the request
      // waiting or legacy extension controls hidden indefinitely in that case.
      const timeout = setTimeout(() => finish(false), 1500);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => finish(true)));
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const payload = message?.payload;
    switch (message?.type) {
      case "aqh/overlay-ping":
        sendResponse({ ok: true });
        break;
      case "aqh/overlay-prepare": {
        if (typeof payload?.reqId !== "string" || !payload.reqId) {
          sendResponse({ ok: false, error: "缺少截图请求标识。" });
          break;
        }
        const version = ++prepareVersion;
        cancelRecovery();
        reqId = payload.reqId;
        snapshot = null;
        opacity = clampOpacity(payload.opacity ?? opacity);
        preparing = true;
        render();
        hideExistingUi();
        twoFrames().then((ready) => {
          const current = version === prepareVersion && reqId === payload.reqId && preparing;
          if (!current) {
            sendResponse({ ok: false, error: "截图请求已更新或取消。" });
            return;
          }
          if (!ready) {
            snapshot = { reqId, state: "error", error: "页面未及时完成绘制，请返回页面后重试。" };
            restorePreparedUi();
            sendResponse({ ok: false, error: snapshot.error });
            return;
          }
          recoveryTimer = setTimeout(() => {
            if (version !== prepareVersion || reqId !== payload.reqId || !preparing) return;
            snapshot = { reqId, state: "error", error: "截图等待超时，请重试。" };
            reqId = null;
            restorePreparedUi();
          }, 10000);
          sendResponse({ ok: true });
        });
        return true;
      }
      case "aqh/overlay-restore":
        if (!reqId || payload?.reqId !== reqId) {
          sendResponse({ ok: false });
          break;
        }
        restorePreparedUi();
        sendResponse({ ok: true });
        break;
      case "aqh/overlay-result":
        if (!reqId || payload?.reqId !== reqId) {
          sendResponse({ ok: false });
          break;
        }
        snapshot = payload;
        render();
        sendResponse({ ok: true });
        break;
      case "aqh/overlay-toggle":
        if (!reqId && !snapshot) {
          sendResponse({ ok: true, handled: false, hidden: userHidden });
          break;
        }
        userHidden = !userHidden;
        render();
        sendResponse({ ok: true, handled: true, hidden: userHidden });
        break;
      case "aqh/overlay-clear":
        ++prepareVersion;
        reqId = null;
        snapshot = null;
        restorePreparedUi();
        sendResponse({ ok: true });
        break;
      default:
        return;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !Object.prototype.hasOwnProperty.call(changes, "overlayOpacity")) return;
    opacity = clampOpacity(changes.overlayOpacity.newValue);
    render();
  });
  // Layout only: this listener never cancels, synthesizes or intercepts events.
  window.addEventListener("resize", render, { passive: true });
})();
