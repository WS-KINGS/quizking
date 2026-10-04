import { deflateRawSync } from "node:zlib";

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(files, { method = 8, flags = 0, declaredSize, badCrc = false } = {}) {
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const plain = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(plain) : plain;
    const crc = (crc32(plain) + Number(badCrc)) >>> 0;
    const size = declaredSize ?? plain.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    directoryParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export const sampleWordXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>1. 中国的首都是哪里？</w:t></w:r></w:p>
<w:p><w:r><w:t>A. 北京</w:t></w:r></w:p>
<w:p><w:r><w:t>B. 上海</w:t></w:r></w:p>
<w:p><w:r><w:t>答案：A</w:t></w:r></w:p>
<w:p><w:r><w:t>解析：北京是中国的首都。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>题目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>答案</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>解析</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>1 + 1 等于多少？</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>基础加法。</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>`;

export function makeDocx(xml = sampleWordXml, options) {
  return zipFiles({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": xml,
  }, options);
}
