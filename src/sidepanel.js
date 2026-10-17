(() => {
  "use strict";

  const KEY = "sidepanelResult";
  const COMPACT_KEY = "sidepanelCompact";
  const byId = (id) => document.getElementById(id);
  const status = byId("status");
  const updated = byId("updated");
  const results = byId("results");
  const comparison = byId("comparison");
  const clearButton = byId("clear");
  const viewToggle = byId("view-toggle");
  let changeVersion = 0;
  let preferenceVersion = 0;
  let currentRequest = null;
  let latestResult = null;
  let compact = true;
  let preferenceWrites = Promise.resolve();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function showText(node, text) {
    node.textContent = text ? String(text) : "";
    node.hidden = !text;
  }

  function unwrap(item) {
    let answer = String(item.answer ?? "").trim();
    let reasoning = String(item.reasoning ?? "").trim();
    if (/^(?:\{|`)/.test(answer)) {
      try {
        const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
        if (parsed && typeof parsed === "object") {
          if (parsed.answer != null) answer = String(parsed.answer).trim();
          if (!reasoning && parsed.reasoning != null) reasoning = String(parsed.reasoning).trim();
        }
      } catch { /* Plain model output remains visible as text. */ }
    }
    return { answer, reasoning };
  }

  function card(item, expanded) {
    const wrap = element("article", "result-card");
    wrap.dataset.providerId = String(item.id ?? "");
    const head = element("header", "result-head");
    const provider = element("div", "provider");
    provider.appendChild(element("h2", "", item.label || item.model || "服务商"));
    if (typeof item.ms === "number" && Number.isFinite(item.ms)) {
      provider.appendChild(element("span", "timing", (item.ms / 1000).toFixed(1) + " 秒"));
    }
    head.appendChild(provider);
    if (item.model && item.model !== item.label) head.appendChild(element("p", "model", item.model));
    wrap.appendChild(head);

    const body = element("div", "result-body");
    if (item.ok === null) {
      body.appendChild(element("p", "waiting", "等待返回…"));
    } else if (item.ok === false) {
      body.appendChild(element("p", "error", item.error || "本次请求失败，请检查服务商设置后重试。"));
    } else {
      const { answer, reasoning } = unwrap(item);
      if (answer) {
        body.appendChild(element("p", "answer-label", "答案"));
        body.appendChild(element("p", "answer", answer));
      } else if (!reasoning && item.raw) {
        body.appendChild(element("p", "answer-label", "模型输出"));
        body.appendChild(element("p", "reasoning detail-only", item.raw));
      } else if (!reasoning) {
        body.appendChild(element("p", "no-answer", "模型未返回可显示的答案。"));
      }
      if (!answer && (reasoning || item.raw)) {
        body.appendChild(element("p", "no-answer compact-only", "未返回单独答案，点击「详细」查看输出。"));
      }
      if (reasoning && reasoning !== answer) {
        const details = element("details", "");
        details.open = expanded || !answer;
        details.appendChild(element("summary", "", "解析"));
        details.appendChild(element("p", "reasoning", reasoning));
        body.appendChild(details);
      }
    }
    if (item.source) body.appendChild(element("p", "source", "来源：" + item.source));
    if (item.bankNotice) body.appendChild(element("p", "bank-note", item.bankNotice));
    wrap.appendChild(body);
    return wrap;
  }

  function render(value) {
    latestResult = value || null;
    document.body.dataset.state = value?.state || "empty";
    const expanded = new Set();
    if (value?.reqId === currentRequest) {
      for (const node of results.querySelectorAll(".result-card")) {
        if (node.querySelector("details")?.open) expanded.add(node.dataset.providerId);
      }
    }
    currentRequest = value?.reqId ?? null;
    results.replaceChildren();
    showText(byId("notice"), value?.bankNotice);
    showText(byId("error"), value?.error);
    showText(comparison, "");
    comparison.classList.remove("is-different");
    showText(updated, "");
    clearButton.disabled = !value;
    byId("empty").hidden = !!value;

    if (!value) {
      status.textContent = "等待截图";
      return;
    }

    const stateText = ({ working: "处理中…", finished: "已完成", error: "处理失败" }[value.state]) || "等待结果";
    status.textContent = compact ? stateText : (value.status || stateText);
    if (value.updatedAt) {
      const date = new Date(value.updatedAt);
      if (!Number.isNaN(date.getTime())) showText(updated, "更新于 " + date.toLocaleTimeString("zh-CN", { hour12: false }));
    }

    const received = Array.isArray(value.items) ? value.items.filter((item) => item && typeof item === "object") : [];
    const items = [...received];
    if (value.state === "working" && Array.isArray(value.pending)) {
      const arrivedIds = new Set(received.map((item) => item.id));
      for (const pending of value.pending) {
        if (pending && !arrivedIds.has(pending.id)) items.push({ ...pending, ok: null });
      }
    }

    const answers = received.filter((item) => item.ok === true).map((item) => unwrap(item).answer).filter(Boolean);
    if (answers.length > 1) {
      const normalized = new Set(answers.map((answer) => answer.toUpperCase().replace(/\s+/g, "")));
      const different = normalized.size > 1;
      showText(comparison, different ? (compact ? "答案不一致，请核对。" : "模型答案不一致，请结合题目与解析核对。") : answers.length + " 个结果的答案一致。" );
      comparison.classList.toggle("is-different", different);
    }
    for (const item of items) results.appendChild(card(item, expanded.has(String(item.id ?? ""))));
    if (!items.length && value.state === "finished" && !value.error) {
      results.appendChild(element("p", "no-answer", "本次没有可显示的结果。"));
    }
  }

  function applyCompact(value) {
    compact = value !== false;
    document.body.classList.toggle("is-compact", compact);
    viewToggle.textContent = compact ? "详细" : "精简";
    viewToggle.setAttribute("aria-label", compact ? "展开详细信息" : "切换精简显示");
    render(latestResult);
  }

  viewToggle.addEventListener("click", () => {
    preferenceVersion += 1;
    applyCompact(!compact);
    const nextValue = compact;
    preferenceWrites = preferenceWrites.catch(() => {}).then(() => chrome.storage.local.set({ [COMPACT_KEY]: nextValue }));
    preferenceWrites.catch((error) => showText(byId("error"), "无法保存显示偏好：" + error.message));
  });

  byId("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage().catch((error) => showText(byId("error"), "无法打开设置：" + error.message));
  });
  clearButton.addEventListener("click", async () => {
    try { await chrome.storage.session.remove(KEY); }
    catch (error) { showText(byId("error"), "无法清空结果：" + error.message); }
  });

  // Subscribe before the initial read, so a newer result cannot be overwritten
  // by an earlier asynchronous read when the panel is opened during a request.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, COMPACT_KEY)) {
      preferenceVersion += 1;
      applyCompact(changes[COMPACT_KEY].newValue);
      return;
    }
    if (area !== "session" || !Object.prototype.hasOwnProperty.call(changes, KEY)) return;
    changeVersion += 1;
    render(changes[KEY].newValue);
  });
  const preferenceReadVersion = preferenceVersion;
  chrome.storage.local.get(COMPACT_KEY).then((stored) => {
    if (preferenceVersion === preferenceReadVersion) applyCompact(stored[COMPACT_KEY]);
  }).catch(() => { /* Use the default compact view when preferences cannot be read. */ });
  const readVersion = changeVersion;
  chrome.storage.session.get(KEY).then((stored) => {
    if (changeVersion === readVersion) render(stored[KEY]);
  }).catch((error) => {
    if (changeVersion !== readVersion) return;
    render(null);
    showText(byId("error"), "无法读取结果：" + error.message);
  });
})();
