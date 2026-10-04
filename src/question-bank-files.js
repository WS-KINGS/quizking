/** @license MIT — Local TXT / Word question-bank readers, without third-party code. */
import { parseQuestionFile, MAX_FILE_BYTES } from "./question-bank.js";

export const MAX_IMPORT_FILE_BYTES = MAX_FILE_BYTES;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function fail(message) { throw new Error(message); }

function decodeText(bytes) {
  let encoding = "utf-8";
  let offset = 0;
  const warnings = [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
  catch {
    if (encoding !== "utf-8") fail("文本编码无法识别，请将文件另存为 UTF-8 TXT 后重试。");
    try {
      text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      warnings.push("已按 GB18030 中文编码读取；请在试搜预览中核对文字。");
    } catch { fail("文本编码无法识别，请将文件另存为 UTF-8 TXT 后重试。"); }
  }
  if (text.includes("\0")) fail("文件包含二进制内容，不能作为 TXT 题库读取；请另存为 UTF-8 TXT。");
  return { text: text.replace(/^\uFEFF/, ""), warnings };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Read only word/document.xml. Do not expand embedded media or follow external relationships.
export async function readDocxDocument(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  if (bytes.length < 22) fail("Word 文件不完整或不是有效的 .docx 文件。");
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) fail("不是有效的 .docx 文件，请用 Word 另存为 .docx 后重试。");
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail("不支持分卷 Word 文件。");
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) fail("不支持 ZIP64 Word 文件，请另存为普通 .docx。");
  if (directoryOffset + directorySize > end) fail("Word 文件的目录损坏。");
  let offset = directoryOffset;
  let documentEntry;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryOffset + directorySize || u32(offset) !== 0x02014b50) fail("Word 文件的目录损坏。");
    const nameLength = u16(offset + 28);
    const next = offset + 46 + nameLength + u16(offset + 30) + u16(offset + 32);
    if (next > directoryOffset + directorySize) fail("Word 文件的目录损坏。");
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === "word/document.xml") {
      if (documentEntry) fail("Word 文件含有重复正文，无法可靠读取。");
      documentEntry = { flags: u16(offset + 8), method: u16(offset + 10), crc: u32(offset + 16), compressed: u32(offset + 20), size: u32(offset + 24), local: u32(offset + 42) };
    }
    offset = next;
  }
  if (!documentEntry) fail("文件中没有 Word 正文，请确认上传的是 .docx 文档。");
  const entry = documentEntry;
  if (entry.flags & 1) fail("不支持加密 Word 文件，请移除密码后重试。");
  if (entry.size > MAX_DOCUMENT_BYTES || entry.compressed > MAX_IMPORT_FILE_BYTES) fail("Word 正文过大，请拆分为较小的题库文件。");
  if (entry.local + 30 > directoryOffset || u32(entry.local) !== 0x04034b50) fail("Word 文件的正文索引损坏。");
  if (u16(entry.local + 8) !== entry.method || (u16(entry.local + 6) & 1)) fail("Word 文件的压缩信息不一致。");
  const nameLength = u16(entry.local + 26);
  const start = entry.local + 30 + nameLength + u16(entry.local + 28);
  if (start + entry.compressed > directoryOffset) fail("Word 文件的正文不完整。");
  const localName = new TextDecoder().decode(bytes.subarray(entry.local + 30, entry.local + 30 + nameLength));
  if (localName !== "word/document.xml") fail("Word 文件的正文索引不一致。");
  const compressed = bytes.subarray(start, start + entry.compressed);
  let expanded;
  if (entry.method === 0) expanded = compressed;
  else if (entry.method === 8) {
    let decompressor;
    try { decompressor = new DecompressionStream("deflate-raw"); }
    catch { fail("当前浏览器不支持读取此 Word 文件，请更新 Chrome，或将文档另存为 TXT 后导入。"); }
    const reader = new Blob([compressed]).stream().pipeThrough(decompressor).getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_DOCUMENT_BYTES || size > entry.size) {
          await reader.cancel();
          fail("Word 正文解压大小超出限制，请拆分文件后重试。");
        }
        chunks.push(result.value);
      }
    } catch (error) { fail("Word 正文解压失败：" + error.message); }
    finally { reader.releaseLock(); }
    expanded = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { expanded.set(chunk, position); position += chunk.byteLength; }
  } else fail("此 Word 文件使用了不支持的压缩方式，请用 Word 另存为 .docx。");
  if (expanded.byteLength !== entry.size || crc32(expanded) !== entry.crc) fail("Word 正文校验失败，文件可能已损坏。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(expanded); }
  catch { fail("Word 正文编码无效，请重新另存为 .docx。"); }
}

function paragraphText(node) {
  if (node.nodeType !== 1) return "";
  if (node.namespaceURI === WORD_NS) {
    if (["del", "drawing", "pict", "instrText"].includes(node.localName)) return "";
    if (node.localName === "t") return node.textContent || "";
    if (node.localName === "tab") return "\t";
    if (node.localName === "br" || node.localName === "cr") return "\n";
  }
  return Array.from(node.children || []).map(paragraphText).join("");
}

function tableText(table) {
  const rows = Array.from(table.children).filter((node) => node.localName === "tr").map((row) =>
    Array.from(row.children).filter((node) => node.localName === "tc").map((cell) =>
      Array.from(cell.getElementsByTagNameNS(WORD_NS, "p")).map(paragraphText).join("\n").trim()));
  if (!rows.length) return "";
  const labels = rows[0].map((cell) => cell.replace(/[\s：:]/g, ""));
  const questionIndex = labels.findIndex((label) => /^(题目|题干|问题|question)$/i.test(label));
  const answerIndex = labels.findIndex((label) => /^(答案|正确答案|参考答案|answer)$/i.test(label));
  if (questionIndex >= 0 && answerIndex >= 0) {
    const reasoningIndex = labels.findIndex((label) => /^(解析|答案解析|解答|解释|reasoning|explanation)$/i.test(label));
    const optionsIndex = labels.findIndex((label) => /^(选项|options)$/i.test(label));
    return rows.slice(1).filter((row) => row[questionIndex]).map((row) => {
      const lines = ["题目：" + row[questionIndex]];
      if (optionsIndex >= 0 && row[optionsIndex]) lines.push(row[optionsIndex]);
      if (row[answerIndex]) lines.push("答案：" + row[answerIndex]);
      if (reasoningIndex >= 0 && row[reasoningIndex]) lines.push("解析：" + row[reasoningIndex]);
      return lines.join("\n");
    }).join("\n\n");
  }
  return rows.map((row) => row.filter(Boolean).join("\n")).join("\n\n");
}

export function extractWordText(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("Word 正文包含不支持的 XML 声明。");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) fail("Word 正文 XML 损坏，无法读取。");
  const body = doc.getElementsByTagNameNS(WORD_NS, "body")[0];
  if (!body) fail("没有找到可读取的 Word 正文。");
  const parts = [];
  function collect(node) {
    if (node.namespaceURI === WORD_NS && node.localName === "p") parts.push(paragraphText(node));
    else if (node.namespaceURI === WORD_NS && node.localName === "tbl") parts.push(tableText(node));
    else for (const child of node.children || []) collect(child);
  }
  for (const child of body.children) collect(child);
  const warnings = [];
  if (doc.getElementsByTagNameNS(WORD_NS, "drawing").length || doc.getElementsByTagNameNS(WORD_NS, "pict").length) {
    warnings.push("Word 中的图片未识别；请核对依赖图片的题目，本功能不含图片 OCR。");
  }
  if (doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/officeDocument/2006/math", "oMath").length) {
    warnings.push("Word 公式对象未转换；请将公式改为普通文本后重新导入相关题目。");
  }
  if (["object", "altChunk", "footnoteReference", "endnoteReference"].some((tag) => doc.getElementsByTagNameNS(WORD_NS, tag).length)) {
    warnings.push("Word 中的嵌入对象、附加内容或脚注未读取；请核对正文是否完整。");
  }
  if (doc.getElementsByTagNameNS(WORD_NS, "numPr").length) {
    warnings.push("Word 自动编号未保留；请核对题目编号和选项字母，必要时改为普通文字。");
  }
  return { text: parts.join("\n"), warnings, requiresReview: warnings.length > 0 };
}

export async function readQuestionFile(file) {
  const name = String(file?.name || "");
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext === ".doc") fail("旧版 .doc 暂不支持，请在 Word 中另存为 .docx 或 UTF-8 TXT 后上传。");
  if (ext !== ".txt" && ext !== ".docx") fail("仅支持 Word (.docx) 和 TXT (.txt) 题库文件。");
  if (!Number.isFinite(file.size) || file.size <= 0) fail("文件为空，无法导入题库。");
  if (file.size > MAX_IMPORT_FILE_BYTES) fail("单个文件不能超过 4 MB，请拆分题库后上传。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES) fail("单个文件不能超过 4 MB，请拆分题库后上传。");
  const extracted = ext === ".txt" ? decodeText(bytes) : extractWordText(await readDocxDocument(bytes));
  if (!extracted.text.trim()) fail("没有读到正文文字。扫描件或图片型 Word 请先转换为文字题库。");
  const parsed = parseQuestionFile(name, extracted.text);
  if (!parsed.entries.length) fail("没有识别到题目，请按示例整理：题目、选项、答案、解析。");
  return {
    entries: extracted.requiresReview ? parsed.entries.map((entry) => ({ ...entry, requiresReview: true })) : parsed.entries,
    warnings: [...extracted.warnings, ...(parsed.warnings || [])],
  };
}
