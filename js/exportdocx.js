/* 墨读 · Word（.docx）导出 —— 纯前端、零依赖
 * 自实现 STORE 模式 ZIP（不依赖 JSZip），按 OOXML 打包，Word / WPS 可直接打开。
 * 仅对外暴露：blocksFromHtml / blocksFromText / docxBytes / docxBlob / fileName。
 */

const enc = new TextEncoder();

/* ── CRC32 ── */
let _crcT = null;
function crcTable() {
  if (_crcT) return _crcT;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  _crcT = t;
  return t;
}
function crc32(bytes) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function concat(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/* ── ZIP（store，无压缩）── */
function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const size = data.length;
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push({ nameBytes, crc, size, offset });
    offset += local.length + nameBytes.length + size;
  }
  const cdStart = offset;
  for (const c of central) {
    const hdr = [0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
    chunks.push(new Uint8Array(hdr), c.nameBytes);
    offset += hdr.length + c.nameBytes.length;
  }
  const cdSize = offset - cdStart;
  const end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0)];
  chunks.push(new Uint8Array(end));
  return concat(chunks);
}

/* ── OOXML 片段 ── */
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function xesc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function runs(text) {
  return String(text).split('\n').map((p, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xesc(p)}</w:t>`).join('');
}

const STYLE_OF = { title: 'Title', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', h4: 'Heading4', p: '', li: 'ListParagraph', quote: 'Quote' };

function para(style, text) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r>${runs(text)}</w:r></w:p>`;
}

function bodyXml(blocks) {
  let out = '';
  for (const b of blocks) {
    if (!b) continue;
    const t = b.text == null ? '' : String(b.text);
    if (b.t === 'hr') { out += '<w:p/>'; continue; }
    if (b.t === 'li') { out += para('ListParagraph', '· ' + t); continue; }
    if (!t.trim()) { if (b.t === 'p') out += '<w:p/>'; continue; }
    out += para(STYLE_OF[b.t] || '', t);
  }
  return out;
}

function documentXml(blocks) {
  return XML_HEAD +
    `<w:document xmlns:w="${W_NS}"><w:body>${bodyXml(blocks)}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';
}

function stylesXml() {
  const h = (id, name, lvl, sz) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:outlineLvl w:val="${lvl}"/><w:spacing w:before="240" w:after="120"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  return XML_HEAD +
    `<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>' +
    h('Heading1', 'heading 1', 0, 32) + h('Heading2', 'heading 2', 1, 28) +
    h('Heading3', 'heading 3', 2, 26) + h('Heading4', 'heading 4', 3, 24) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>' +
    '</w:styles>';
}

function contentTypes() {
  return XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
}

function relsRoot() {
  return XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
}

function relsDoc() {
  return XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xesc(title || '墨读导出')}</dc:title>` +
    '<dc:creator>墨读</dc:creator><cp:lastModifiedBy>墨读</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>';
}

function appXml() {
  return XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>墨读</Application></Properties>';
}

/* ── 对外：blocks → docx 字节 ── */
export function docxBytes(blocks, title) {
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes()) },
    { name: '_rels/.rels', data: enc.encode(relsRoot()) },
    { name: 'docProps/core.xml', data: enc.encode(coreXml(title)) },
    { name: 'docProps/app.xml', data: enc.encode(appXml()) },
    { name: 'word/document.xml', data: enc.encode(documentXml(blocks, title)) },
    { name: 'word/styles.xml', data: enc.encode(stylesXml()) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(relsDoc()) }
  ];
  return zipStore(files);
}

export function docxBlob(blocks, title) {
  return new Blob([docxBytes(blocks, title)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ── 纯文本 → blocks ── */
const HEAD_RE = /^(第\s*[零〇一二三四五六七八九十百千两\d]{1,10}\s*[章回节卷篇部集]|序章|序言|自序|代序|译序|总序|前言|引言|引子|楔子|尾声|后记|跋|附录|导论|导读|终章|大结局)/;

export function blocksFromText(text, opts = {}) {
  const blocks = [];
  if (opts.title) blocks.push({ t: 'title', text: opts.title });
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { blocks.push({ t: 'p', text: '' }); continue; }
    if (opts.markHeadings !== false && line.trim().length <= 46 && HEAD_RE.test(line.trim())) {
      blocks.push({ t: 'h2', text: line.trim() });
    } else {
      blocks.push({ t: 'p', text: line });
    }
  }
  return blocks;
}

/* ── HTML → blocks（用 DOMParser 走块级元素）── */
export function blocksFromHtml(html, opts = {}) {
  const blocks = [];
  if (opts.title) blocks.push({ t: 'title', text: opts.title });
  if (typeof DOMParser === 'undefined') {
    blocks.push({ t: 'p', text: String(html || '').replace(/<[^>]+>/g, ' ') });
    return blocks;
  }
  const doc = new DOMParser().parseFromString('<div id="__r">' + (html || '') + '</div>', 'text/html');
  const root = doc.getElementById('__r');
  if (!root) return blocks;

  const BLOCK = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'DETAILS', 'SUMMARY', 'FIGURE']);
  const HEAD = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4' };
  const SKIP = /(^|\s)(pl-strip|pl-legend|pl-nav|pl-stats|risk-grid)(\s|$)/;

  function walk(el) {
    for (const node of el.childNodes) {
      if (node.nodeType !== 1) continue;
      if (node.classList && SKIP.test(node.className)) continue;
      const tag = node.tagName;
      const hasBlockChild = [...node.children].some((c) => BLOCK.has(c.tagName));
      if (tag === 'UL' || tag === 'OL') {
        for (const li of node.children) { if (li.tagName === 'LI') pushText('li', li.textContent); }
        continue;
      }
      if (tag === 'BR') { continue; }
      if (hasBlockChild) { walk(node); continue; }
      const kind = HEAD[tag] || (tag === 'LI' ? 'li' : tag === 'BLOCKQUOTE' ? 'quote' : 'p');
      pushText(kind, node.textContent);
    }
  }
  function pushText(t, s) {
    const txt = String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
    if (!txt) return;
    if (t === 'h4') { /* 降级为普通加粗段落，避免层级过深 */ }
    blocks.push({ t, text: txt });
  }
  walk(root);
  return blocks;
}

/* ── blocks → 纯文本（App 端降级用）── */
export function blocksToPlain(blocks) {
  return (blocks || []).map((b) => {
    if (!b || b.text == null) return '';
    if (b.t === 'title') return b.text + '\n';
    return b.text;
  }).join('\n');
}

/* ── 文件名清洗 ── */
export function fileName(base, ext) {
  const safe = String(base || '墨读导出').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${safe}-${stamp}.${ext || 'docx'}`;
}