import test from "node:test";
import assert from "node:assert/strict";
import { readQuestionFile, readDocxDocument, MAX_IMPORT_FILE_BYTES } from "../src/question-bank-files.js";
import { makeDocx, zipFiles, sampleWordXml } from "./helpers/docx-fixture.mjs";

test("TXT upload parses questions, options and answer without a model", async () => {
  const file = new File(["1. 中国的首都是哪里？\r\nA. 北京\r\nB. 上海\r\n答案：A\r\n解析：北京是中国的首都。"], "中文.txt");
  const parsed = await readQuestionFile(file);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].answer, "A");
  assert.match(parsed.entries[0].options, /A\. 北京/);
});

test("UTF-16LE and UTF-16BE BOM files preserve Chinese", async () => {
  const content = "题目：中国的首都？\n答案：北京";
  const le = Buffer.from(content, "utf16le");
  const be = Buffer.from(le).swap16();
  for (const [bom, data] of [[Buffer.from([255, 254]), le], [Buffer.from([254, 255]), be]]) {
    const parsed = await readQuestionFile(new File([bom, data], "题库.txt"));
    assert.equal(parsed.entries[0].answer, "北京");
  }
});

test("GB18030 legacy Chinese TXT is decoded with a warning", async () => {
  // GBK is a subset of GB18030. These bytes encode 题目：北京\n答案：北京.
  const bytes = Buffer.from("cce2c4bfa3bab1b1bea90ab4f0b0b8a3bab1b1bea9", "hex");
  const parsed = await readQuestionFile(new File([bytes], "中文.txt"));
  assert.equal(parsed.entries[0].question, "北京");
  assert.equal(parsed.entries[0].answer, "北京");
  assert.ok(parsed.warnings.some((warning) => warning.includes("GB18030")));
});

test("empty files, unsupported formats, old Word and binary disguised as TXT fail visibly", async () => {
  await assert.rejects(readQuestionFile(new File([], "empty.txt")), /文件为空/);
  await assert.rejects(readQuestionFile(new File(["data"], "old.doc")), /另存为 .docx/);
  await assert.rejects(readQuestionFile(new File(["data"], "bad.pdf")), /仅支持/);
  await assert.rejects(readQuestionFile(new File(["a\0b"], "binary.txt")), /二进制/);
  await assert.rejects(readQuestionFile({ name: "large.txt", size: MAX_IMPORT_FILE_BYTES + 1 }), /4 MB/);
});

test("DOCX stored and deflated archive readers return exact XML", async () => {
  for (const method of [0, 8]) assert.equal(await readDocxDocument(makeDocx(sampleWordXml, { method })), sampleWordXml);
});

test("DOCX reader rejects corrupt CRC, missing document, encryption and unsupported method", async () => {
  await assert.rejects(readDocxDocument(makeDocx(sampleWordXml, { badCrc: true })), /校验失败/);
  await assert.rejects(readDocxDocument(zipFiles({ "unrelated.txt": "data" })), /没有 Word 正文/);
  await assert.rejects(readDocxDocument(makeDocx(sampleWordXml, { flags: 1 })), /加密/);
  await assert.rejects(readDocxDocument(makeDocx(sampleWordXml, { method: 12 })), /不支持的压缩/);
});

test("DOCX reader caps declared and actual expansion sizes", async () => {
  await assert.rejects(readDocxDocument(makeDocx(sampleWordXml, { declaredSize: 17 * 1024 * 1024 })), /正文过大/);
  await assert.rejects(readDocxDocument(makeDocx(sampleWordXml, { declaredSize: 20 })), /超出限制/);
});

test("truncated or forged ZIP indexes fail without out-of-bounds reads", async () => {
  await assert.rejects(readDocxDocument(Buffer.from("not a ZIP")), /不完整/);
  const truncated = makeDocx().subarray(0, 80);
  await assert.rejects(readDocxDocument(truncated), /不是有效/);
  const forged = makeDocx();
  forged.writeUInt32LE(0xfffffffe, forged.byteLength - 6);
  await assert.rejects(readDocxDocument(forged), /目录损坏/);
});

test("missing answers remain explicit and are never fabricated", async () => {
  const parsed = await readQuestionFile(new File(["题目：尚未给出答案的问题"], "题库.txt"));
  assert.equal(parsed.entries[0].answer, "");
  assert.ok(parsed.warnings.some((warning) => warning.includes("缺少答案")));
});
