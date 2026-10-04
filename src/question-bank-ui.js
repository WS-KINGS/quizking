/** @license MIT — Shared local question-bank upload and management UI. */
import { readQuestionFile } from "./question-bank-files.js";
import { searchQuestionBank } from "./question-bank.js";
import { getBank, importFiles, removeFile, clearBank, getAllEntries } from "./question-bank-store.js";

const root = document.querySelector("[data-question-bank]");
if (root) initialize(root);

function initialize(root) {
  const find = (name) => root.querySelector(`[data-qb="${name}"]`);
  const input = find("files");
  const summary = find("summary");
  const status = find("status");
  const filesBox = find("file-list");
  const enabled = find("enabled");
  const searchInput = find("query");
  const results = find("results");
  let bank = { files: [] };
  let busy = false;
  let refreshVersion = 0;

  const showStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle("qb-error", error);
  };
  function setBusy(value) {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll("button, input").forEach((control) => { control.disabled = value; });
    if (!value && find("clear")) find("clear").disabled = !bank.files.length;
  }
  function textElement(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  }
  function renderFiles() {
    const entries = getAllEntries(bank);
    summary.textContent = `${bank.files.length} 个文件 · ${entries.length} 道题`;
    if (filesBox) {
      filesBox.replaceChildren();
      if (!bank.files.length) filesBox.append(textElement("p", "尚未导入题库。", "muted"));
      for (const file of bank.files) {
        const card = textElement("div", "", "qb-file");
        const detail = textElement("div", "", "qb-file-detail");
        detail.append(textElement("strong", file.name));
        const date = new Date(file.importedAt);
        detail.append(textElement("span", `${file.entries.length} 道题 · ${Number.isNaN(date.getTime()) ? "已导入" : date.toLocaleString("zh-CN")}`, "muted"));
        const remove = textElement("button", "删除", "qb-remove");
        remove.type = "button";
        remove.disabled = busy;
        remove.setAttribute("aria-label", "删除题库文件 " + file.name);
        remove.addEventListener("click", async () => {
          if (busy || !confirm(`删除题库“${file.name}”及其中 ${file.entries.length} 道题？本地原文件不会被删除。`)) return;
          await mutate(async () => { await removeFile(file.id); showStatus("已删除题库文件：" + file.name); });
        });
        card.append(detail, remove);
        filesBox.append(card);
      }
    }
    if (find("clear")) find("clear").disabled = busy || !bank.files.length;
    if (results) preview();
  }
  async function refresh() {
    const version = ++refreshVersion;
    const [storedBank, settings] = await Promise.all([getBank(), chrome.storage.sync.get({ questionBankEnabled: true })]);
    if (version !== refreshVersion) return;
    bank = storedBank;
    if (enabled) enabled.checked = settings.questionBankEnabled !== false;
    renderFiles();
  }
  async function mutate(action) {
    setBusy(true);
    try { await action(); await refresh(); }
    catch (error) { showStatus(error?.message || "操作失败，请重试。", true); }
    finally { setBusy(false); }
  }
  function preview() {
    if (!results) return;
    const query = searchInput.value.trim();
    results.replaceChildren();
    if (!query) { results.append(textElement("p", "粘贴题干和选项，查看题库匹配结果。", "muted")); return; }
    const matches = searchQuestionBank(getAllEntries(bank), query, { limit: 5 });
    if (!matches.length) { results.append(textElement("p", "没有匹配到题目；实际答题时将继续调用模型。", "muted")); return; }
    for (const match of matches) {
      const entry = match.entry;
      const card = textElement("article", "", "qb-result");
      const label = entry.requiresReview ? "文档内容需核对 · 仅供参考" : match.conflict ? "存在答案冲突，请核对" : match.exact ? (entry.answer ? "精确匹配" : "精确匹配 · 未提供答案") : "相似题目 · 仅供参考";
      card.append(textElement("div", label, match.conflict ? "qb-error" : "qb-match-label"));
      card.append(textElement("p", entry.question, "qb-question"));
      if (entry.options?.length) card.append(textElement("p", Array.isArray(entry.options) ? entry.options.join("\n") : String(entry.options), "qb-answer"));
      card.append(textElement("p", "答案：" + (entry.answer || "未提供"), "qb-answer"));
      if (entry.reasoning) card.append(textElement("p", "解析：" + entry.reasoning, "qb-answer"));
      card.append(textElement("div", "来源：" + (entry.fileName || entry.source || "本地题库"), "muted"));
      results.append(card);
    }
  }

  find("upload").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const selected = Array.from(input.files || []);
    input.value = "";
    if (!selected.length || busy) return;
    await mutate(async () => {
      const accepted = [];
      const messages = [];
      for (let index = 0; index < selected.length; index++) {
        const file = selected[index];
        showStatus(`正在读取 ${index + 1}/${selected.length}：${file.name}。请保持窗口打开。`);
        try {
          const parsed = await readQuestionFile(file);
          accepted.push({ name: file.name, entries: parsed.entries });
          for (const warning of parsed.warnings) messages.push(file.name + "：" + warning);
        } catch (error) { messages.push(file.name + "：导入失败，" + error.message); }
      }
      let savedCount = 0;
      if (accepted.length) {
        try { await importFiles(accepted); savedCount = accepted.length; }
        catch (error) { messages.push("保存失败，所选文件未导入：" + error.message); }
      }
      const count = savedCount ? accepted.reduce((sum, file) => sum + file.entries.length, 0) : 0;
      const headline = savedCount ? `已导入 ${savedCount} 个文件，共 ${count} 道题。` : "没有文件成功导入。";
      showStatus([headline, ...messages].join("\n"), savedCount !== selected.length);
    });
  });
  if (enabled) enabled.addEventListener("change", async () => {
    const checked = enabled.checked;
    await mutate(async () => {
      try { await chrome.storage.sync.set({ questionBankEnabled: checked }); }
      catch (error) { enabled.checked = !checked; throw error; }
      showStatus(checked ? "已启用题库优先，即时生效。" : "已停用题库优先，即时生效；已导入题库保留。");
    });
  });
  find("clear")?.addEventListener("click", async () => {
    if (busy || !bank.files.length || !confirm("清空所有已导入题库？此操作不能撤销，本地原文件不会被删除。")) return;
    await mutate(async () => { await clearBank(); showStatus("题库已清空。"); });
  });
  find("search")?.addEventListener("click", preview);
  searchInput?.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); preview(); } });
  find("manage")?.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#question-bank") }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "local" && changes.questionBank) || (area === "sync" && changes.questionBankEnabled)) {
      refresh().catch((error) => showStatus("题库刷新失败：" + error.message, true));
    }
  });
  setBusy(true);
  refresh().catch((error) => showStatus("题库加载失败：" + error.message, true)).finally(() => setBusy(false));
}
