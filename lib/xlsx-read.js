/**
 * 零依赖表格读取器
 * ------------------------------------------------------------------
 * 与 lib/xlsx.js（零依赖写入器）同源，用于把用户上传的 .xlsx / .csv
 * 解析成二维数组（行→列）。仅依赖 Node 内置 zlib，不引入任何第三方包。
 *
 *   const { readTable } = require('./lib/xlsx-read');
 *   const rows = readTable(buffer, '商品.xlsx');   // rows: Array<Array<string|number>>
 *
 * 能力范围：
 *   - .xlsx：解自己的 ZIP 容器（中央目录 + raw deflate），读取首个工作表；
 *            支持 inlineStr 文本、sharedStrings 文本、数值型单元格。
 *   - .csv ：UTF-8（含 BOM）、英文逗号分隔、双引号转义、字段内换行。
 */
const zlib = require('zlib');

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&');
}

// 列字母 → 索引：A=0, B=1, AA=26
function colIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- 极简 ZIP 读取（仅需解压，无需写回） ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（缺少 ZIP 尾部）');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const files = {};
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const localOff = buf.readUInt32LE(p + 42);
    const lMethod = buf.readUInt16LE(localOff + 8);
    const lComp = buf.readUInt32LE(localOff + 18);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + lComp);
    let data;
    if (lMethod === 0) data = Buffer.from(comp);
    else if (lMethod === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方式: ' + lMethod);
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function readSheetXml(xml, shared) {
  const rowsMap = {};
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let m;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1];
    const inner = m[2];
    const rMatch = /r="([A-Z]+)(\d+)"/.exec(attrs);
    if (!rMatch) continue;
    const col = rMatch[1];
    const row = parseInt(rMatch[2], 10);
    const tMatch = /t="([^"]*)"/.exec(attrs);
    const t = tMatch ? tMatch[1] : '';
    let val;
    if (t === 's') {
      const v = /<v>(\d+)<\/v>/.exec(inner);
      val = v ? (shared[parseInt(v[1], 10)] || '') : '';
    } else if (t === 'inlineStr') {
      let s = ''; let tm;
      const tt = /<t[^>]*>([\s\S]*?)<\/t>/g;
      while ((tm = tt.exec(inner))) s += unescapeXml(tm[1]);
      val = s;
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const raw = v ? v[1] : '';
      const num = Number(raw);
      val = (raw !== '' && Number.isFinite(num)) ? num : raw;
    }
    (rowsMap[row] = rowsMap[row] || []).push({ col, val });
  }
  return Object.keys(rowsMap).map(Number).sort((a, b) => a - b).map((rn) => {
    const cells = rowsMap[rn].sort((a, b) => colIndex(a.col) - colIndex(b.col));
    const maxCol = cells.reduce((mx, c) => Math.max(mx, colIndex(c.col)), 0);
    const arr = new Array(maxCol + 1).fill('');
    for (const c of cells) arr[colIndex(c.col)] = c.val;
    return arr;
  });
}

function readXlsx(buf) {
  const files = readZip(buf);
  let shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let sm;
    while ((sm = siRe.exec(xml))) {
      let s = ''; let tm;
      const tt = /<t[^>]*>([\s\S]*?)<\/t>/g;
      while ((tm = tt.exec(sm[1]))) s += unescapeXml(tm[1]);
      shared.push(s);
    }
  }
  let sheetXml = files['xl/worksheets/sheet1.xml'];
  if (!sheetXml) {
    const keys = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    if (!keys.length) throw new Error('xlsx 中没有工作表');
    sheetXml = files[keys[0]];
  }
  return readSheetXml(sheetXml.toString('utf8'), shared);
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows = [];
  let i = 0, row = [], field = '', inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 把上传的文件 Buffer 解析成二维数组。
 * @param {Buffer} buffer 文件二进制
 * @param {string} filename 原始文件名（用扩展名判断格式）
 * @returns {Array<Array<string|number>>}
 */
function readTable(buffer, filename) {
  const fn = String(filename || '').toLowerCase();
  if (fn.endsWith('.csv')) return parseCsv(buffer.toString('utf8'));
  return readXlsx(buffer);
}

module.exports = { readTable, readXlsx, parseCsv, readZip };
