/* 文档解析：TXT / DOCX / EPUB / PDF → 纯文本 + 章节结构 */

/* ══════════ vendor 库按需加载（减小首屏体积） ══════════ */
const _libLoading = {};
function loadScriptOnce(src) {
  if (_libLoading[src]) return _libLoading[src];
  _libLoading[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { _libLoading[src] = null; reject(new Error('加载失败：' + src)); };
    document.head.appendChild(s);
  });
  return _libLoading[src];
}

/* ══════════ 文本编码 ══════════ */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ══════════ TXT ══════════ */
async function parseTxt(file) {
  const buf = await file.arrayBuffer();
  return { content: normalize(decodeText(buf)) };
}

/* ══════════ DOCX ══════════ */
async function parseDocx(file) {
  await loadScriptOnce('vendor/mammoth.browser.min.js');
  const buf = await file.arrayBuffer();
  if (!window.mammoth) throw new Error('DOCX 解析库未加载');
  const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return { content: normalize(res.value) };
}

/* ══════════ EPUB ══════════ */
function resolvePath(base, href) {
  const raw = (base + href).split('#')[0];
  const parts = decodeURIComponent(raw).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

const BLOCK_TAGS = new Set(['P','DIV','BR','H1','H2','H3','H4','H5','H6','LI','TR','SECTION','ARTICLE','BLOCKQUOTE','PRE','HR','FIGURE','FIGCAPTION','TD']);

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,nav,svg,head').forEach(e => e.remove());
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push('\n');
    for (const c of node.childNodes) walk(c);
    if (isBlock) out.push('\n');
  };
  walk(doc.body || doc.documentElement);
  return normalize(out.join(''));
}

async function parseEpub(file) {
  await loadScriptOnce('vendor/jszip.min.js');
  const buf = await file.arrayBuffer();
  if (!window.JSZip) throw new Error('EPUB 解析库未加载');
  const zip = await JSZip.loadAsync(buf);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB 文件');
  const containerXml = await containerFile.async('string');
  const cdoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = cdoc.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile.getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfXml = await zip.file(opfPath).async('string');
  const opf = new DOMParser().parseFromString(opfXml, 'application/xml');

  const meta = (name) => {
    const el = opf.getElementsByTagNameNS('*', name)[0];
    return el ? el.textContent.trim() : '';
  };
  const title = meta('title');
  const author = meta('creator');

  const manifest = {};
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    manifest[item.getAttribute('id')] = {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || ''
    };
  }

  const spineItems = [];
  for (const ref of Array.from(opf.getElementsByTagName('itemref'))) {
    const id = ref.getAttribute('idref');
    const m = manifest[id];
    if (m && /html|xml/.test(m.type)) spineItems.push(m);
  }

  const chapters = [];
  for (const item of spineItems) {
    const path = resolvePath(opfDir, item.href);
    const f = zip.file(path);
    if (!f) continue;
    const html = await f.async('string');
    const text = htmlToText(html);
    if (text.length < 20) continue;

    let heading = '';
    try {
      const d = new DOMParser().parseFromString(html, 'text/html');
      const h = d.querySelector('h1, h2, h3, title');
      if (h) heading = h.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
    } catch { }

    chapters.push({ title: heading, text });
  }

  const content = chapters.map(c => c.text).join('\n\n');
  return { content, title, author, epubChapters: chapters };
}

/* ══════════ PDF ══════════ */
function pdfItemsToLines(items) {
  const rows = [];
  for (const it of items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) <= 3.2);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let str = '';
    let prev = null;
    for (const it of row.items) {
      if (prev) {
        const gap = it.transform[4] - (prev.transform[4] + (prev.width || 0));
        const size = it.height || Math.abs(it.transform[3]) || 10;
        const latin = /[A-Za-z0-9]$/.test(str) && /^[A-Za-z0-9]/.test(it.str);
        if (gap > size * 0.28 && latin) str += ' ';
        else if (gap > size * 2.2) str += ' ';
      }
      str += it.str;
      prev = it;
    }
    const clean = str.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    // 过滤页码 / 页眉
    if (/^[-—\s]*\d{1,4}[-—\s]*$/.test(clean)) continue;
    if (/^第?\s*\d{1,4}\s*页$/.test(clean)) continue;
    lines.push(clean);
  }
  return lines;
}

function linesToParagraphs(lines) {
  const out = [];
  let buf = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    buf += line;
    const endPunct = /[。！？；…”』」】．.!?;:'"）)]$/;
    const short = line.length < 18;
    const nextIndent = i + 1 < lines.length && /^\s{2,}/.test(lines[i + 1]);
    if (endPunct.test(line) || short || nextIndent || i === lines.length - 1) {
      out.push(buf);
      buf = '';
    } else {
      // 中文直接拼接，英文补空格
      if (/[A-Za-z0-9]$/.test(buf) && i + 1 < lines.length && /^[A-Za-z0-9]/.test(lines[i + 1])) buf += ' ';
    }
  }
  if (buf.trim()) out.push(buf);
  return out.join('\n');
}

async function parsePdf(file, onProgress) {
  await loadScriptOnce('vendor/pdf.min.js');
  if (!window.pdfjsLib) throw new Error('PDF 解析库未加载');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(linesToParagraphs(pdfItemsToLines(tc.items)));
    onProgress?.(i / doc.numPages, i, doc.numPages);
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  let title = '', author = '';
  try {
    const md = await doc.getMetadata();
    title = md.info?.Title || '';
    author = md.info?.Author || '';
  } catch { }
  const content = normalize(pages.join('\n\n'));
  const perPage = content.length / Math.max(1, doc.numPages);
  return { content, title, author, pageCount: doc.numPages, scanned: perPage < 30 };
}

/* ══════════ 章节切分 ══════════ */
const CN_NUM = '零〇一二三四五六七八九十百千两';

const RE_CN = new RegExp(`^第\\s*[${CN_NUM}\\d]{1,10}\\s*[章回节卷篇部集]`);
const RE_EN = /^(CHAPTER|Chapter|chapter)\s+([IVXLCDM]{1,7}|\d{1,3})\b/;
const RE_SPECIAL = /^(序章|序言|自序|代序|译序|总序|前言|引言|引子|楔子|开场白|尾声|后记|跋|附录|导论|导读|凡例|目录|终章|大结局|写在前面|出版说明)$/;
const RE_SPECIAL2 = /^(序|跋|尾声|后记|附录)\s*[:：]?\s*.{0,14}$/;

export function cnToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (map[ch] !== undefined) { num = map[ch]; }
    else if (unit[ch]) {
      const u = unit[ch];
      section += (num || 1) * u;
      num = 0;
    }
  }
  total = section + num;
  return total || 0;
}

function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > 46) return false;
  if (RE_CN.test(t)) return true;
  if (RE_EN.test(t)) return true;
  if (RE_SPECIAL.test(t)) return true;
  if (t.length <= 16 && RE_SPECIAL2.test(t)) return true;
  return false;
}

export function splitChapters(text) {
  const lines = [];
  let off = 0;
  for (const raw of text.split('\n')) {
    lines.push({ text: raw, start: off });
    off += raw.length + 1;
  }

  let heads = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (isHeading(t)) heads.push({ title: t, start: lines[i].start });
  }

  // 去掉目录页里的重复标题：同名标题保留最靠后的那次
  if (heads.length > 2) {
    const last = new Map();
    heads.forEach((h, i) => last.set(h.title, i));
    heads = heads.filter((h, i) => {
      const li = last.get(h.title);
      if (li === i) return true;
      return heads[li].start - h.start < 600; // 近距离同名，可能是卷名重复，保留
    });
  }

  // 相邻标题过密（如目录页未去净）→ 合并
  if (heads.length >= 2) {
    const dense = heads.filter((h, i) => i > 0 && h.start - heads[i - 1].start < 60);
    if (dense.length > heads.length * 0.5) heads = heads.slice(0, 1);
  }

  const chapters = [];

  if (heads.length < 2) {
    // 无章节标记：按段落边界切块
    const SIZE = 9000;
    let pos = 0;
    let idx = 1;
    while (pos < text.length) {
      let end = Math.min(pos + SIZE, text.length);
      if (end < text.length) {
        const nl = text.indexOf('\n', end);
        if (nl !== -1 && nl - end < 1200) end = nl + 1;
      }
      chapters.push({ title: `第 ${idx} 节`, start: pos, end, auto: true });
      pos = end;
      idx++;
    }
    if (!chapters.length) chapters.push({ title: '全文', start: 0, end: text.length });
    return chapters;
  }

  if (heads[0].start > 40) {
    const lead = text.slice(0, heads[0].start).trim();
    if (lead.length > 0) chapters.push({ title: '卷首', start: 0, end: heads[0].start, lead: true });
  }

  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].start;
    const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
    if (end - start < 5) continue;
    chapters.push({ title: heads[i].title, start, end });
  }
  if (!chapters.length) chapters.push({ title: '全文', start: 0, end: text.length });
  return chapters;
}

/* ══════════ 主入口 ══════════ */
export async function parseFile(file, onProgress) {
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const baseTitle = name.replace(/\.[^.]+$/, '').replace(/[（(]\d+[)）]$/, '').trim();

  let res;
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') res = await parseTxt(file);
  else if (ext === 'docx') res = await parseDocx(file);
  else if (ext === 'epub') res = await parseEpub(file);
  else if (ext === 'pdf') res = await parsePdf(file, onProgress);
  else throw new Error(`不支持的文件格式：.${ext}`);

  const content = res.content || '';
  if (!content.trim() || (ext === 'pdf' && res.scanned)) {
    const e = new Error(ext === 'pdf'
      ? `这个 PDF 是扫描图片版（每页平均只有 ${Math.round(content.length / Math.max(1, res.pageCount || 1))} 个字，基本提取不到正文）。`
      : '文件里没有解析到文字。');
    e.code = 'SCANNED';
    e.partial = content;
    throw e;
  }

  const chapters = splitChapters(content);

  // EPUB 自带分章时，用其标题覆盖
  if (res.epubChapters && chapters.length) {
    let ci = 0;
    for (const ec of res.epubChapters) {
      if (ci >= chapters.length) break;
      if (ec.title && ec.title.length < 60) {
        // 找到该章文本在全书中的位置
        const pos = content.indexOf(ec.text.slice(0, 40));
        let target = chapters.findIndex(c => c.start <= pos && c.end > pos);
        if (target >= 0) chapters[target].title = ec.title;
      }
      ci++;
    }
  }

  return {
    title: (res.title || baseTitle || '未命名').trim(),
    author: (res.author || '').trim(),
    format: ext,
    content,
    chapters,
    charCount: content.length,
    pageCount: res.pageCount || 0
  };
}

/* ══════════ 文本工具 ══════════ */

const STOP = new Set(('的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 他 她 它 们 我们 你们 他们 什么 怎么 为什么 因为 所以 但是 而且 如果 虽然 然后 还是 已经 可以 这个 那个 这样 那样 时候 现在 知道 起来 出来 过来 一下 一些 一样 这么 那么 只是 就是 不是 还有 心里 一面 只见 忙 便 又 却 才 再 更 最 太 只 都 把 被 让 给 对 从 向 往 跟 比 像 似 等 过 着 得 地 之 其 此 该 者 也 矣 焉 哉 呢 吗 吧 啊 呀 哦 嗯 道 说道 问道 笑道 答道 叫道 一面 众人 二人 三人 只见 不在 不得 不可 不能 不曾 不敢 不过 不如 不然 不知 于是 因此 自然 果然 忽然 忽听 原来 如今 今日 明日 昨日 当时 此时 后来 于是 只得 只好 只是 怎样 如何 何以 为何 何处 不知 以为 觉得 心中 心上 口中 眼中 手中 身子 脸上 口中 便 就 又 还 只 才 却 也 都 很 更 最 太 不 没 别 再 可 该 应').split(/\s+/));

export function topWords(text, n = 12, exclude = []) {
  if (!window.Intl || !Intl.Segmenter) return [];
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const freq = new Map();
  const ex = new Set(exclude);
  for (const s of seg.segment(text)) {
    if (!s.isWordLike) continue;
    const w = s.segment.trim();
    if (w.length < 2 || w.length > 5) continue;
    if (STOP.has(w) || ex.has(w)) continue;
    if (/^[0-9a-zA-Z]+$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const arr = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const top = arr.slice(0, n * 3);
  // 去掉被更长词包含且频次接近的短词
  const out = [];
  for (const [w, c] of top) {
    if (out.some(([ow, oc]) => ow.includes(w) && oc > c * 1.4)) continue;
    out.push([w, c]);
    if (out.length >= n) break;
  }
  return out;
}

export function excerpt(text, keyword, radius = 110) {
  const i = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2);
  const s = Math.max(0, i - radius);
  const e = Math.min(text.length, i + keyword.length + radius);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\n+/g, ' ') + (e < text.length ? '…' : '');
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function readingTime(chars) {
  const min = Math.round(chars / 420);
  if (min < 60) return `${min} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
}


/* ══════════ 扫描版 PDF 的 OCR ══════════ */
let _tessLoading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (_tessLoading) return _tessLoading;
  _tessLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve();
    s.onerror = () => {
      _tessLoading = null;
      reject(new Error('OCR 引擎加载失败（需要联网）'));
    };
    document.head.appendChild(s);
  });
  return _tessLoading;
}

/**
 * 把扫描版 PDF 逐页渲染成图片，交给 Tesseract 识别。
 * 慢：每页约 3–8 秒；中文竖排、繁体、旧印刷体识别率一般。
 */
export async function ocrPdf(file, onProgress) {
  await loadScriptOnce('vendor/pdf.min.js');
  if (!window.pdfjsLib) throw new Error('PDF 解析库未加载');
  await loadTesseract();

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;

  onProgress?.({ stage: 'engine', message: '正在加载中文识别模型（首次约 15MB）…' });

  const worker = await window.Tesseract.createWorker('chi_sim', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        onProgress?.({ stage: 'page', progress: m.progress });
      }
    }
  });

  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.({ stage: 'page', page: i, total: doc.numPages, message: `识别第 ${i} / ${doc.numPages} 页` });

    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const result = await worker.recognize(canvas);
    const text = (result?.data?.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text) out += text + '\n\n';

    canvas.width = 0;
    canvas.height = 0;
  }

  await worker.terminate();
  return cleanOcr(out);
}

/** tesseract 识别中文会在字间插空格，这里把它们收回去 */
function cleanOcr(t) {
  return t
    .replace(/([\u4e00-\u9fa5，。！？；：、“”‘’（）《》…—])[ \t]+(?=[\u4e00-\u9fa5，。！？；：、“”‘’（）《》…—])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}
