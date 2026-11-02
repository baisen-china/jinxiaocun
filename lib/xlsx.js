/**
 * 零依赖 XLSX 生成器
 * ------------------------------------------------------------------
 * 只用 Node 内置 zlib 手写 ZIP 容器 + Office Open XML，生成真正的 .xlsx
 * （Excel / WPS / Numbers 均可直接打开），不引入任何第三方包。
 *
 * 用法：
 *   const { buildWorkbook } = require('./lib/xlsx');
 *   const buf = buildWorkbook([
 *     { name: '概览', rows: [['指标', '数值'], ['总应收', 1234.5]] }
 *   ]);
 *
 * 约定：每个 sheet 的第一行视为表头（加粗）；数字型单元格写为数值，
 *       其余按文本写入；空值单元格跳过。
 */
const zlib = require('zlib');

// ---------- CRC32（ZIP 需要） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---------- 极简 ZIP 打包 ----------
function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 版本
    local.writeUInt16LE(0x0800, 6);       // 通用标志：UTF-8 文件名
    local.writeUInt16LE(method, 8);       // 压缩方式
    local.writeUInt16LE(0, 10);           // 修改时间
    local.writeUInt16LE(0x21, 12);        // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, end]);
}

// ---------- XML 工具 ----------
function xmlEscape(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/`/g, '&#96;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colLetter(n) { // 1 -> A, 27 -> AA
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 显示宽度：中文/全角按 2 计
function dispWidth(v) {
  const s = String(v == null ? '' : v);
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

function sheetXml(rows) {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
  // 列宽：取该列最长内容，限制在 10~42
  const widths = [];
  for (let c = 0; c < maxCols; c++) {
    let w = 8;
    for (const r of rows) w = Math.max(w, dispWidth(r[c]));
    widths.push(Math.min(42, Math.max(10, w + 2)));
  }
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;

  const body = rows.map((row, ri) => {
    const cells = row.map((v, ci) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = colLetter(ci + 1) + (ri + 1);
      const style = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}"${style}><v>${v}</v></c>`;
      }
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}
<sheetData>${body}</sheetData>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="微软雅黑"/></font><font><b/><sz val="11"/><name val="微软雅黑"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF4FF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FFD5DCE8"/></top><bottom style="thin"><color rgb="FFD5DCE8"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs>
</styleSheet>`;

function safeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { n = `${base.slice(0, 28)}(${i++})`; }
  used.add(n.toLowerCase());
  return n;
}

/**
 * 生成 xlsx 文件内容
 * @param {Array<{name:string, rows:Array<Array<string|number>>}>} sheets
 * @returns {Buffer}
 */
function buildWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('至少需要一个工作表');
  const used = new Set();
  const normalized = sheets.map(s => ({
    name: safeSheetName(s.name, used),
    rows: (s.rows || []).filter(r => Array.isArray(r))
  }));

  const files = [];
  files.push({
    name: '[Content_Types].xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${normalized.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`, 'utf8')
  });
  files.push({
    name: '_rels/.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8')
  });
  files.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${normalized.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`, 'utf8')
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${normalized.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8')
  });
  files.push({ name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') });
  normalized.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows), 'utf8') });
  });

  return zip(files);
}

module.exports = { buildWorkbook, zip };
