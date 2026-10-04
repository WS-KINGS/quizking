/** Local-only persistence. Reads no provider configuration or API keys. */
import { MAX_FILE_BYTES } from "./question-bank.js";

export const MAX_BANK_BYTES = 6 * 1024 * 1024;
export const MAX_BANK_ENTRIES = 5000;
export const MAX_BANK_FILES = 100;
const STORAGE_KEY = "questionBank";
const byteLength = (value) => new TextEncoder().encode(value).length;
let pendingUpdate = Promise.resolve();

function localStorage() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) throw new Error("浏览器本地存储不可用，请在扩展页面中操作。");
  return storage;
}

function emptyBank() { return { version: 1, files: [] }; }

function validateBank(bank) {
  if (bank === undefined) return emptyBank();
  if (!bank || bank.version !== 1 || !Array.isArray(bank.files) || bank.files.some((file) => !file || typeof file.id !== "string" || typeof file.name !== "string" || !Array.isArray(file.entries))) throw new Error("本地题库格式异常，无法读取。请先备份源文件，再清空并重新导入。");
  return bank;
}

export async function getBank() {
  const result = await localStorage().get(STORAGE_KEY);
  return validateBank(result[STORAGE_KEY]);
}

export function getAllEntries(bank) {
  return validateBank(bank).files.flatMap((file) => file.entries.map((entry, index) => ({ ...entry, fileId: file.id, fileName: file.name, source: `${file.name} · 第 ${index + 1} 题` })));
}

function serializeUpdate(action) {
  // Web Locks serializes writes across popup, options and service-worker contexts.
  const run = () => globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request("quizking-question-bank", action)
    : action();
  const result = pendingUpdate.then(run, run);
  pendingUpdate = result.catch(() => {});
  return result;
}

function cleanEntry(entry, name, index) {
  if (!entry || typeof entry.question !== "string" || !entry.question.trim()) throw new Error(`${name} 的第 ${index + 1} 道题缺少题干。`);
  const question = entry.question.trim();
  const answer = entry.answer == null ? "" : String(entry.answer).trim();
  const reasoning = entry.reasoning == null ? "" : String(entry.reasoning).trim();
  if (entry.options != null && typeof entry.options !== "string") throw new Error(`${name} 的选项格式错误，请通过文件导入重新解析。`);
  const options = entry.options?.trim();
  return { question, answer, reasoning, ...(options ? { options } : {}), ...(entry.requiresReview === true ? { requiresReview: true } : {}), fileName: name, source: `${name} · 第 ${index + 1} 题` };
}

async function writeBank(bank) {
  const storage = localStorage();
  if (bank.files.length > MAX_BANK_FILES) throw new Error(`最多保存 ${MAX_BANK_FILES} 个题库文件，请删除部分文件后重试。`);
  const count = bank.files.reduce((sum, file) => sum + file.entries.length, 0);
  if (count > MAX_BANK_ENTRIES) throw new Error(`题库最多保存 ${MAX_BANK_ENTRIES} 道题，请删除部分文件后重试。`);
  const bytes = byteLength(JSON.stringify(bank)) + byteLength(STORAGE_KEY);
  if (bytes > MAX_BANK_BYTES) throw new Error("题库总容量超过 6 MiB，请删除部分文件或拆分题库。");
  if (typeof storage.getBytesInUse === "function") {
    const [used, oldBank] = await Promise.all([storage.getBytesInUse(null), storage.getBytesInUse(STORAGE_KEY)]);
    if (used - oldBank + bytes > (storage.QUOTA_BYTES || 10 * 1024 * 1024)) throw new Error("浏览器本地存储空间不足，请清理部分题库或历史记录后重试。");
  }
  try { await storage.set({ [STORAGE_KEY]: bank }); }
  catch (error) { throw new Error(`保存题库失败：${error?.message || "本地存储不可用"}`); }
  return bank;
}

/** Atomic batch import. Existing files are retained, including files with the same name. */
export function importFiles(files) {
  return serializeUpdate(async () => {
    if (!Array.isArray(files) || !files.length) throw new Error("请先选择需要导入的题库文件。");
    const additions = files.map((file) => {
      const name = String(file?.name || "未命名题库").slice(0, 255);
      if (!Array.isArray(file?.entries) || !file.entries.length) throw new Error(`${name} 没有可导入的题目。`);
      const entries = file.entries.map((entry, index) => cleanEntry(entry, name, index));
      if (byteLength(JSON.stringify(entries)) > MAX_FILE_BYTES) throw new Error(`${name} 的解析内容超过 4 MiB，请拆分后导入。`);
      return { id: globalThis.crypto.randomUUID(), name, importedAt: new Date().toISOString(), entries };
    });
    const bank = await getBank();
    return writeBank({ version: 1, files: [...bank.files, ...additions] });
  });
}

export function removeFile(id) {
  return serializeUpdate(async () => {
    const bank = await getBank();
    return writeBank({ version: 1, files: bank.files.filter((file) => file.id !== id) });
  });
}

export function clearBank() {
  // Clearing also allows recovery from malformed or outdated stored data.
  return serializeUpdate(() => writeBank(emptyBank()));
}
