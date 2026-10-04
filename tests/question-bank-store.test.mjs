import test from "node:test";
import assert from "node:assert/strict";
import { getBank, getAllEntries, importFiles, removeFile, clearBank, MAX_BANK_ENTRIES, MAX_BANK_BYTES } from "../src/question-bank-store.js";

function mockStorage({ used = 0, quota = 10 * 1024 * 1024, failure = false } = {}) {
  const data = {};
  const calls = [];
  globalThis.chrome = { storage: { local: {
    QUOTA_BYTES: quota,
    async get(key) { calls.push(["get", key]); await new Promise((resolve) => setTimeout(resolve, 2)); return structuredClone({ [key]: data[key] }); },
    async set(value) { if (failure) throw new Error("QUOTA_BYTES quota exceeded"); await new Promise((resolve) => setTimeout(resolve, 2)); Object.assign(data, structuredClone(value)); },
    async getBytesInUse(key) { return key === null ? used : 0; },
  } } };
  return { data, calls };
}
const file = (name = "bank.txt", question = "中国首都", answer = "北京") => ({ name, entries: [{ question, answer, reasoning: "" }] });

test("local store", async (t) => {
  await t.test("imports locally, reports sources, removes and clears without reading config", async () => {
    const mock = mockStorage();
    assert.deepEqual(await getBank(), { version: 1, files: [] });
    const imported = await importFiles([file()]);
    assert.equal(imported.files.length, 1);
    assert.equal(getAllEntries(imported)[0].source, "bank.txt · 第 1 题");
    assert.equal(getAllEntries(imported)[0].fileId, imported.files[0].id);
    assert.equal((await removeFile(imported.files[0].id)).files.length, 0);
    await importFiles([file()]);
    assert.equal((await clearBank()).files.length, 0);
    assert.ok(mock.calls.every(([, key]) => key === "questionBank"));
  });
  await t.test("concurrent imports are serialized without lost files and same names append", async () => {
    mockStorage();
    await Promise.all([importFiles([file("same.txt", "题一")]), importFiles([file("same.txt", "题二")]), importFiles([file("three.txt", "题三")])]);
    const bank = await getBank();
    assert.equal(bank.files.length, 3);
    assert.equal(new Set(bank.files.map((item) => item.id)).size, 3);
    assert.deepEqual(getAllEntries(bank).map((entry) => entry.question), ["题一", "题二", "题三"]);
  });
  await t.test("failed batch imports are atomic and do not poison the update queue", async () => {
    mockStorage();
    await assert.rejects(importFiles([file("valid.txt"), { name: "invalid.txt", entries: [] }]), /没有可导入/);
    assert.equal((await getBank()).files.length, 0);
    assert.equal((await importFiles([file()])).files.length, 1);
  });
  await t.test("incomplete Word extraction flags survive persistence", async () => {
    mockStorage();
    const imported = file();
    imported.entries[0].requiresReview = true;
    await importFiles([imported]);
    assert.equal(getAllEntries(await getBank())[0].requiresReview, true);
  });
  await t.test("the total question limit rejects instead of silently truncating", async () => {
    mockStorage();
    const entries = Array.from({ length: MAX_BANK_ENTRIES }, (_, i) => ({ question: `题${i}`, answer: "是" }));
    await importFiles([{ name: "many.txt", entries }]);
    await assert.rejects(importFiles([file("more.txt")]), /5000 道题/);
    assert.equal(getAllEntries(await getBank()).length, MAX_BANK_ENTRIES);
  });
  await t.test("total bank bytes and browser quota are checked before writes", async () => {
    const mock = mockStorage();
    const large = "x".repeat(Math.floor(MAX_BANK_BYTES / 3));
    await importFiles([{ name: "one.txt", entries: [{ question: large, answer: "yes" }] }]);
    await importFiles([{ name: "two.txt", entries: [{ question: large, answer: "yes" }] }]);
    await assert.rejects(importFiles([{ name: "three.txt", entries: [{ question: large, answer: "yes" }] }]), /6 MiB/);
    assert.equal(mock.data.questionBank.files.length, 2);
    mockStorage({ used: 1023, quota: 1024 });
    await assert.rejects(importFiles([file()]), /本地存储空间不足/);
  });
  await t.test("storage errors propagate and malformed stored data is not overwritten", async () => {
    mockStorage({ failure: true });
    await assert.rejects(importFiles([file()]), /保存题库失败/);
    const mock = mockStorage();
    mock.data.questionBank = { version: 9, files: [] };
    await assert.rejects(importFiles([file()]), /题库格式异常/);
    assert.equal(mock.data.questionBank.version, 9);
    assert.deepEqual(await clearBank(), { version: 1, files: [] });
  });
});
