/* 墨读 · 主控制器
 * 职责：路由与视图切换、阅读器渲染、笔记/标记、助手问答、拆书入口、创作面板、文内批注、
 *       导入流程、设置/备份/导出、朗读与快捷键。
 * 依赖：./db.js（IndexedDB 存储）、./parse.js（多格式解析 + 分章）、./ai.js（模型调用 + 本地规则）。
 * 组织：以「══════ 分区注释 ══════」分节；全局仅一个 state 单例；函数用「动词+名词」命名。
 * 改动指引：交互/流程 → 本文件；界面结构 → index.html + styles.css；分析/提示词 → ai.js；存储 → db.js。
 */
import * as db from './db.js';
import { parseFile, escapeHtml, cnToNum, readingTime, ocrPdf, splitChapters } from './parse.js';
import * as ai from './ai.js';

/* 全局错误兜底：记录未捕获异常，避免个别错误导致白屏且无从排查 */
window.addEventListener('error', (e) => {
  console.error('[墨读] 未捕获错误：', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[墨读] 未处理的 Promise 拒绝：', e.reason);
});

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const throttle = (fn, ms) => {
  let last = 0, timer = null;
  const wrapped = (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...a); }, ms); }
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
};

const state = {
  books: [],
  book: null,
  content: '',
  chapter: 0,
  marks: [],
  notes: [],
  selection: null,
  editingMark: null,
  panelTab: 'assistant',
  noteFilter: 'all',
  chat: [],
  outline: null,
  searchQuery: '',
  lastScrollSave: 0,
  busy: false
};

const HL_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
const USAGE_KEY = 'modu.usage';
let session = { cost: 0, tokens: 0, count: 0 };

function loadUsage() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch { return {}; }
}

function recordUsage(u) {
  session.cost += u.cost;
  session.tokens += u.total;
  session.count++;

  const all = loadUsage();
  all.cost = (all.cost || 0) + u.cost;
  all.tokens = (all.tokens || 0) + u.total;
  all.prompt = (all.prompt || 0) + u.prompt;
  all.completion = (all.completion || 0) + u.completion;
  all.count = (all.count || 0) + 1;
  all.last = Date.now();
  if (state.book) {
    all.books = all.books || {};
    const bk = all.books[state.book.id] || { cost: 0, tokens: 0, count: 0, title: state.book.title };
    bk.cost += u.cost;
    bk.tokens += u.total;
    bk.count += 1;
    bk.title = state.book.title;
    all.books[state.book.id] = bk;
  }
  localStorage.setItem(USAGE_KEY, JSON.stringify(all));

  updateUsageUI();
  if (!$('#settingsMask').hidden) renderUsageBox();
}

const usageProgress = throttle((p) => {
  const el = $('#usageHint');
  if (!el) return;
  if (p.phase === 'error') { el.classList.remove('live'); return; }
  const s = ai.getAI();
  const pin = Number(s.priceIn) || 0;
  const pout = Number(s.priceOut) || 0;
  const cost = p.promptTokens / 1e6 * pin + p.outputTokens / 1e6 * pout;
  const t = p.promptTokens + p.outputTokens;
  el.textContent = `生成中 ≈ ¥${cost.toFixed(4)} · ${(t / 1000).toFixed(1)}k`;
  el.classList.add('live');
}, 120);

function updateUsageUI() {
  usageProgress.cancel();
  const el = $('#usageHint');
  if (!el) return;
  el.classList.remove('live');
  if (!session.count) { el.textContent = ''; return; }
  const t = session.tokens >= 1000 ? (session.tokens / 1000).toFixed(1) + 'k' : session.tokens;
  el.textContent = `本次 ¥${session.cost.toFixed(4)} · ${t} tokens`;
}

function renderUsageBox() {
  const all = loadUsage();
  const box = $('#usageBox');
  if (!box) return;
  box.innerHTML = `
    <div class="usage-row"><span>累计请求</span><b>${all.count || 0} 次</b></div>
    <div class="usage-row"><span>输入 tokens</span><b>${(all.prompt || 0).toLocaleString()}</b></div>
    <div class="usage-row"><span>输出 tokens</span><b>${(all.completion || 0).toLocaleString()}</b></div>
    <div class="usage-row"><span>累计费用（估）</span><b>¥${(all.cost || 0).toFixed(4)}</b></div>
    <div class="usage-row"><span>本次会话</span><b>¥${session.cost.toFixed(4)}</b></div>
    ${(() => {
      const bk = state.book ? (all.books || {})[state.book.id] : null;
      if (!bk) return '';
      const t = (bk.title || '').length > 8 ? bk.title.slice(0, 8) + '…' : bk.title;
      return `<div class="usage-row"><span>本书 · ${escapeHtml(t)}</span><b>¥${bk.cost.toFixed(4)}</b></div>`;
    })()}`;
}

/* ══════════════════════ 启动 ══════════════════════ */
async function init() {
  await db.openDB();
  ai.onUsage(recordUsage);
  ai.onProgress(usageProgress);
  await ai.probeProxy();
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
    const st = $('#dropzone strong'), sp = $('#dropzone span');
    if (st) st.textContent = '点击选择文件';
    if (sp) sp.textContent = '支持 TXT / DOCX / EPUB / PDF';
  }
  loadPrefs();
  await loadBooks();
  document.body.classList.toggle('ai-on', ai.aiReady());
  $('#chatHint').textContent = ai.aiReady()
    ? '已接入 ' + (ai.getAI().model || '') + ' · 回答会标注原文出处'
    : '本地模式：可定位、检索、看框架。接入大模型后可深度解释。';
  if (IS_APP) {
    document.documentElement.classList.add('in-app');
  }

  const last = await db.getKV('lastBook');
  if (last) {
    await openBook(last, { restore: true });
  } else {
    showWelcome();
  }
}

/* ══════════════════════ 阅读偏好 ══════════════════════ */
const PREF_KEY = 'modu.prefs';
let prefs = { size: 18, lh: 1.9, theme: 'paper', family: 'serif', indent: true, width: 700 };

function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    prefs = { ...prefs, ...s };
  } catch { }
  applyPrefs();
}
function savePrefs() { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }
function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--reader-size', prefs.size + 'px');
  root.style.setProperty('--reader-lh', prefs.lh);
  root.style.setProperty('--reader-w', prefs.width + 'px');
  root.style.setProperty('--reader-font',
    prefs.family === 'kai' ? '"Kaiti SC","STKaiti","KaiTi",var(--serif)'
      : prefs.family === 'sans' ? 'var(--sans)' : 'var(--serif)');
  $('#fontVal').textContent = prefs.size;
  $('#lineRange').value = prefs.lh;
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.fontfamily === prefs.family));
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === prefs.theme));
  $('#indentSwitch').classList.toggle('on', prefs.indent);
}
const applyPrefsDebounced = debounce(applyPrefs, 80);

/* ══════════════════════ 书架 ══════════════════════ */
async function loadBooks() {
  state.books = await db.listBooks();
  renderShelf();
}

function renderShelf() {
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  $('#shelfCount').textContent = state.books.length || '';
  $('#shelfEmpty').hidden = state.books.length > 0;

  const ordered = [...state.books].sort((a, b) => (b.kind === 'draft' ? 1 : 0) - (a.kind === 'draft' ? 1 : 0));
  for (const b of ordered) {
    const pct = b.progress?.percent ? Math.round(b.progress.percent * 100) : 0;
    const card = document.createElement('div');
    card.className = 'book-card' + (state.book?.id === b.id ? ' active' : '');
    card.innerHTML = `
      <div class="book-spine" style="background:${spineColor(b)}"></div>
      <div class="book-body">
        <div class="book-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</div>
        <div class="book-meta">
          ${b.kind === 'draft' ? '<span class="draft-tag">我的稿</span>' : ''}
          <span>${(b.format || '').toUpperCase()}</span>
          <span>·</span>
          <span>${pct}%</span>
          ${b.author ? `<span>·</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(b.author)}</span>` : ''}
        </div>
        <div class="book-progress"><i style="width:${Math.max(pct, 1.5)}%"></i></div>
      </div>
      <button class="book-del" title="移除">✕</button>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.book-del')) return;
      openBook(b.id);
      $('#sidebar').classList.remove('open');
    });
    card.querySelector('.book-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`从书架移除《${b.title}》？\n该书的标记和笔记也会一并删除。`)) return;
      await db.removeBook(b.id);
      if (state.book?.id === b.id) { state.book = null; showWelcome(); }
      await db.setKV('lastBook', null);
      await loadBooks();
      toast('已移除');
    });
    shelf.appendChild(card);
  }
}

function spineColor(b) {
  const palette = ['#a8402a', '#5a6b5d', '#7a6450', '#4d5f74', '#8a5a4a', '#6b5b7a'];
  let h = 0;
  for (const c of (b.title || '')) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return palette[h % palette.length];
}

/* ══════════════════════ 打开书 ══════════════════════ */
async function openBook(id, opts = {}) {
  const book = state.books.find(b => b.id === id) || await db.getBook(id);
  if (!book) return;
  state.book = book;
  state.content = await db.getText(id);
  state.marks = await db.listMarks(id);
  state.notes = await db.listNotes(id);
  state.chat = [];
  state.searchQuery = '';
  state.notes = state.notes || [];

  $('#welcome').hidden = true;
  $('#readerWrap').hidden = false;
  $('#shelfView').hidden = true;
  $('#tocView').hidden = false;
  $('#tocBookTitle').textContent = book.title;
  $('#tocBookMeta').textContent = [
    book.author, `${book.chapters.length} 章`, `${(book.charCount / 10000).toFixed(1)} 万字`, readingTime(book.charCount)
  ].filter(Boolean).join(' · ');
  const _nc = $('#bookNoteCount'); if (_nc) _nc.textContent = state.marks.length + state.notes.length;
  $('#btnBookFramework').textContent = '拆书';

  renderTOC();
  renderChat();

  const start = Math.min(book.progress?.chapter ?? 0, book.chapters.length - 1);
  renderReader(start, opts.restore ? { ratio: book.progress?.ratio || 0, silent: true } : {});

  await db.setKV('lastBook', id);
  await db.putBook({ ...book, lastReadAt: Date.now() });
}

function showWelcome() {
  $('#sidebar').classList.remove('open');
  $('#welcome').hidden = false;
  $('#readerWrap').hidden = true;
  $('#shelfView').hidden = false;
  $('#tocView').hidden = true;
  closePanel();
  state.book = null;
  renderShelf();
}

/* ══════════════════════ 目录 ══════════════════════ */
/* ══════════ 选段分析：目录点选起止章 ══════════ */
let rangeSel = { active: false, a: null, b: null };

function paintRangeSel() {
  const a = rangeSel.a, b = rangeSel.b;
  $$('#tocList .toc-item').forEach(el => {
    const i = +el.dataset.i;
    el.classList.toggle('range-sel', i === a || i === b);
    el.classList.toggle('range-in', a != null && b != null && i > a && i < b);
  });
}

function renderRangeBar() {
  const bar = $('#rangeBar'), txt = $('#rangeBarText'), go = $('#btnRangeGo');
  if (!bar) return;
  if (!rangeSel.active) { bar.hidden = true; return; }
  bar.hidden = false;
  if (rangeSel.a == null) { txt.textContent = '点选起点章节'; go.disabled = true; }
  else if (rangeSel.b == null) { txt.textContent = `起点：第 ${rangeSel.a + 1} 章，再点终点`; go.disabled = true; }
  else { txt.textContent = `第 ${rangeSel.a + 1}–${rangeSel.b + 1} 章 · 共 ${rangeSel.b - rangeSel.a + 1} 章`; go.disabled = false; }
}

function pickRange(i) {
  if (rangeSel.a == null) { rangeSel.a = i; rangeSel.b = null; }
  else if (rangeSel.b == null) {
    rangeSel.b = i;
    if (rangeSel.b < rangeSel.a) { const t = rangeSel.a; rangeSel.a = rangeSel.b; rangeSel.b = t; }
  } else { rangeSel.a = i; rangeSel.b = null; }
  renderRangeBar();
  paintRangeSel();
}

function enterRangeMode() {
  rangeSel = { active: true, a: null, b: null };
  renderRangeBar();
  paintRangeSel();
  toast('在目录里点两个章节，选中一段');
}

function exitRangeMode() {
  rangeSel = { active: false, a: null, b: null };
  renderRangeBar();
  paintRangeSel();
}

function renderTOC() {
  const list = $('#tocList');
  list.innerHTML = '';
  $('#tocCount').textContent = state.book.chapters.length;
  state.book.chapters.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'toc-item' + (i === state.chapter ? ' active' : '');
    btn.dataset.i = i;
    const words = c.end - c.start;
    btn.innerHTML = `<span class="n">${i + 1}</span><span class="t">${escapeHtml(cleanTitle(c.title))}</span>
      <span class="w">${words > 999 ? (words / 10000).toFixed(1) + '万' : words}</span>`;
    btn.addEventListener('click', () => {
      if (rangeSel.active) { pickRange(i); return; }
      renderReader(i);
      $('#sidebar').classList.remove('open');
    });
    list.appendChild(btn);
  });
}

function cleanTitle(t) {
  return (t || '').replace(/\s+/g, ' ').trim() || '未命名章节';
}

/* ══════════════════════ 阅读渲染 ══════════════════════ */
function renderReader(idx, opts = {}) {
  if (!state.book) return;
  idx = Math.max(0, Math.min(idx, state.book.chapters.length - 1));
  state.chapter = idx;
  const ch = state.book.chapters[idx];
  const reader = $('#reader');
  const frag = document.createDocumentFragment();

  // 章节头
  const head = document.createElement('div');
  head.className = 'chap-head';
  const isAuto = ch.auto;
  head.innerHTML = `
    <div class="ord">${isAuto ? 'SECTION' : 'CHAPTER'} ${String(idx + 1).padStart(2, '0')}</div>
    <h2>${escapeHtml(cleanTitle(ch.title))}</h2>
    <div class="rule"></div>`;
  if (inlineMode && inlineNotes.length) {
    const chNotes = inlineNotes.filter(n => n.len === 0 && n.at >= ch.start && n.at < ch.end);
    if (chNotes.length) {
      const chips = document.createElement('div');
      chips.className = 'inline-chips';
      chNotes.forEach(n => {
        const c = document.createElement('button');
        c.className = `inline-chip ${n.level}`;
        c.textContent = n.title;
        c.dataset.body = n.body;
        c.title = n.body;
        chips.appendChild(c);
      });
      head.appendChild(chips);
    }
  }
  frag.appendChild(head);

  // 段落
  const raw = state.content.slice(ch.start, ch.end);
  const marks = state.marks.filter(m => m.end > ch.start && m.start < ch.end)
    .sort((a, b) => a.start - b.start);
  const inline = (inlineMode && inlineNotes.length)
    ? inlineNotes.filter(n => n.len > 0 && n.at + n.len > ch.start && n.at < ch.end)
    : [];

  let cursor = ch.start;
  let first = true;
  for (const line of raw.split('\n')) {
    const lead = line.length - line.trimStart().length;
    const val = line.trim();
    const pStart = cursor + lead;
    cursor += line.length + 1;
    if (!val) continue;
    const norm = (x) => x.replace(/\s+/g, '');
    if (first && val.length < 70 && norm(cleanTitle(ch.title)).startsWith(norm(val).slice(0, 10))) { first = false; continue; }
    first = false;
    frag.appendChild(buildParagraph(val, pStart, marks, inline));
  }

  const end = document.createElement('div');
  end.className = 'chapter-end';
  end.textContent = '· 本章终 ·';
  frag.appendChild(end);

  reader.innerHTML = '';
  reader.appendChild(frag);
  reader.style.textIndent = prefs.indent ? '' : '0';

  // 导航按钮
  $('#btnPrevChapter').disabled = idx === 0;
  $('#btnNextChapter').disabled = idx === state.book.chapters.length - 1;
  $('#topbarTitle').textContent = `${state.book.title} · ${cleanTitle(ch.title)}`;

  // 目录高亮
  $$('#tocList .toc-item').forEach(el => el.classList.toggle('active', +el.dataset.i === idx));
  const active = $('#tocList .toc-item.active');
  if (active && !opts.silent) active.scrollIntoView({ block: 'nearest' });

  const sc = $('#readerScroll');
  sc.style.scrollBehavior = 'auto';
  if (opts.offset != null) {
    sc.scrollTop = 0;
    requestAnimationFrame(() => scrollToOffset(opts.offset));
  } else if (opts.ratio != null) {
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (opts.ratio || 0);
  } else {
    sc.scrollTop = 0;
  }
  sc.style.scrollBehavior = '';
  updateProgress();
}

/* ══════════ 文内批注 ══════════ */
let inlineMode = false;
let inlineNotes = [];

function toggleInline() {
  if (!state.book) return;
  inlineMode = !inlineMode;
  if (inlineMode) {
    if (!inlineNotes.length) inlineNotes = ai.buildInlineNotes(state.book, state.content);
    toast(`已标出 ${inlineNotes.length} 处建议`);
  } else {
    hideInlineTip();
  }
  const ib = $('#btnInline'); if (ib) ib.classList.toggle('on', inlineMode);
  renderReader(state.chapter);
}

let inlineTip = null;
function showInlineTip(el) {
  hideInlineTip();
  const body = el.dataset.body || '';
  if (!body) return;
  inlineTip = document.createElement('div');
  inlineTip.className = 'inline-tip';
  inlineTip.innerHTML = `<button class="it-close">✕</button><div class="it-body">${escapeHtml(body)}</div>`;
  document.body.appendChild(inlineTip);
  const r = el.getBoundingClientRect();
  const tipW = Math.min(320, window.innerWidth - 24);
  let x = Math.min(Math.max(8, r.left), window.innerWidth - tipW - 12);
  let y = r.bottom + 8;
  if (y + 140 > window.innerHeight) y = Math.max(8, r.top - 150);
  inlineTip.style.left = x + 'px';
  inlineTip.style.top = y + 'px';
  inlineTip.style.width = tipW + 'px';
  inlineTip.querySelector('.it-close').addEventListener('click', hideInlineTip);
}
function hideInlineTip() {
  if (inlineTip) { inlineTip.remove(); inlineTip = null; }
}

function buildParagraph(text, pStart, marks, inline) {
  const p = document.createElement('p');
  p.className = 'para' + (prefs.indent ? '' : ' no-indent');
  p.dataset.s = pStart;
  const pEnd = pStart + text.length;

  const textSpan = (s, e) => {
    const span = document.createElement('span');
    span.dataset.s = s;
    span.textContent = text.slice(s - pStart, e - pStart);
    return span;
  };

  const segs = [
    ...marks.map(m => ({ s: m.start, e: m.end, k: 'mark', d: m })),
    ...(inline || []).map(n => ({ s: n.at, e: n.at + n.len, k: 'in', d: n }))
  ].filter(x => x.e > pStart && x.s < pEnd).sort((a, b) => a.s - b.s);

  let cur = pStart;
  for (const seg of segs) {
    const ms = Math.max(seg.s, cur);
    const me = Math.min(seg.e, pEnd);
    if (me <= cur) continue;
    if (ms > cur) p.appendChild(textSpan(cur, ms));
    if (seg.k === 'mark') {
      const m = seg.d;
      const mark = document.createElement('mark');
      mark.className = `hl c-${m.color || 'yellow'}${m.note ? ' has-note' : ''}`;
      mark.dataset.id = m.id;
      mark.dataset.s = ms;
      mark.textContent = text.slice(ms - pStart, me - pStart);
      mark.title = m.note ? m.note.slice(0, 120) : '点击查看 / 编辑笔记';
      p.appendChild(mark);
    } else {
      const n = seg.d;
      const sp = document.createElement('span');
      sp.className = `in-note ${n.level}`;
      sp.dataset.s = ms;
      sp.dataset.body = n.body;
      sp.textContent = text.slice(ms - pStart, me - pStart);
      sp.title = n.title + ' · 点击看建议';
      p.appendChild(sp);
    }
    cur = me;
  }
  if (cur < pEnd) p.appendChild(textSpan(cur, pEnd));
  if (!p.childNodes.length) p.textContent = text;
  return p;
}

function updateProgress() {
  const ch = state.book.chapters[state.chapter];
  const sc = $('#readerScroll');
  const ratio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0;
  const abs = ch.start + (ch.end - ch.start) * Math.min(1, Math.max(0, ratio));
  $('#progressFill').style.width = (abs / state.content.length * 100).toFixed(2) + '%';
}

/* 滚动：保存进度 */
const saveProgress = debounce(async () => {
  if (!state.book) return;
  const ch = state.book.chapters[state.chapter];
  const sc = $('#readerScroll');
  const ratio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0;
  state.book.progress = {
    chapter: state.chapter,
    ratio,
    percent: Math.min(1, (ch.start + (ch.end - ch.start) * ratio) / state.content.length)
  };
  await db.putBook(state.book);
  const card = $('#shelf .book-card.active');
  if (card) card.querySelector('.book-progress i').style.width = Math.max(1.5, state.book.progress.percent * 100) + '%';
}, 600);

$('#readerScroll').addEventListener('scroll', () => {
  updateProgress();
  saveProgress();
}, { passive: true });

/* 滚动到指定字符位置 */
function scrollToOffset(offset) {
  const reader = $('#reader');
  const els = $$('[data-s]', reader);
  let target = null;
  for (const el of els) {
    const s = +el.dataset.s;
    if (s <= offset) target = el; else break;
  }
  if (!target) target = els[0];
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1400);
}

function chapterAt(offset) {
  const chs = state.book.chapters;
  let lo = 0, hi = chs.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < chs[mid].start) hi = mid - 1;
    else if (offset >= chs[mid].end) lo = mid + 1;
    else return { index: mid, chapter: chs[mid] };
  }
  best = Math.max(0, Math.min(lo, chs.length - 1));
  return { index: best, chapter: chs[best] };
}

function gotoOffset(offset) {
  const { index } = chapterAt(offset);
  if (index !== state.chapter) renderReader(index, { offset });
  else {
    scrollToOffset(offset);
  }
  closePanelIfMobile();
}

/* ══════════════════════ 选中 → 工具条 ══════════════════════ */
let selRange = null;

function absPos(node, offset) {
  if (!node) return null;
  if (node.nodeType === 3) {
    let el = node.parentElement;
    while (el && el.dataset.s === undefined) el = el.parentElement;
    if (el) return +el.dataset.s + offset;
    return null;
  }
  const child = node.childNodes[offset];
  if (child) {
    if (child.nodeType === 3) {
      let el = child.parentElement;
      while (el && el.dataset.s === undefined) el = el.parentElement;
      if (el) return +el.dataset.s;
    }
    const w = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    const t = w.nextNode();
    if (t) return absPos(t, 0);
    return child.dataset?.s !== undefined ? +child.dataset.s : null;
  }
  const last = node.lastChild;
  if (last) return absPos(last, last.nodeType === 3 ? last.length : last.childNodes.length);
  return null;
}

const handleSelection = debounce(() => {
  const sel = window.getSelection();
  const toolbar = $('#selToolbar');
  if (!sel || sel.isCollapsed || !sel.rangeCount) { toolbar.hidden = true; return; }
  const range = sel.getRangeAt(0);
  const reader = $('#reader');
  if (!reader.contains(range.commonAncestorContainer)) { toolbar.hidden = true; return; }

  const start = absPos(range.startContainer, range.startOffset);
  const end = absPos(range.endContainer, range.endOffset);
  if (start == null || end == null || end - start < 1 || end - start > 3000) { toolbar.hidden = true; return; }

  state.selection = { start: Math.min(start, end), end: Math.max(start, end) };
  selRange = range.cloneRange();

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) { toolbar.hidden = true; return; }

  toolbar.hidden = false;
  const tw = toolbar.offsetWidth || 330;
  const th = toolbar.offsetHeight || 36;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 10;
  let below = false;
  if (top < 60) { top = rect.bottom + 10; below = true; }
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';
  toolbar.classList.toggle('below', below);

  // 选区正好落在一个已有标记上 → 显示"取消标记"
  const hit = state.marks.find(m => m.start <= state.selection.start && m.end >= state.selection.end);
  $('[data-act="remove"]', toolbar).hidden = !hit;
  toolbar.dataset.markId = hit?.id || '';
}, 130);

document.addEventListener('selectionchange', handleSelection);

/* 点击工具条（mousedown 阻止默认，保住选区） */
$('#selToolbar').addEventListener('mousedown', (e) => e.preventDefault());

$('#selToolbar').addEventListener('click', async (e) => {
  const sw = e.target.closest('.sw');
  const act = e.target.closest('.sel-act');
  if (!state.selection) return;

  if (sw) {
    await createMark(state.selection, sw.dataset.color);
    $('#selToolbar').hidden = true;
    window.getSelection()?.removeAllRanges();
    return;
  }
  if (!act) return;
  const a = act.dataset.act;
  const text = state.content.slice(state.selection.start, state.selection.end);

  if (a === 'copy') {
    await copyText(text);
    toast('已复制 ' + text.length + ' 字');
  } else if (a === 'note') {
    const existing = state.marks.find(m => Math.abs(m.start - state.selection.start) < 2 && Math.abs(m.end - state.selection.end) < 2);
    const m = existing || await createMark(state.selection, 'yellow');
    openNoteModal(m);
  } else if (a === 'explain') {
    openPanel('assistant');
    askExplain(text, state.selection.start, state.selection.end);
  } else if (a === 'ask') {
    openPanel('assistant');
    $('#chatInput').value = `这段怎么理解：「${text.slice(0, 80)}${text.length > 80 ? '…' : ''}」`;
    $('#chatInput').focus();
  } else if (a === 'remove') {
    const id = $('#selToolbar').dataset.markId;
    if (id) { await removeMark(id); toast('已取消标记'); }
  }
  $('#selToolbar').hidden = true;
});

async function createMark(sel, color) {
  const m = {
    id: db.uid(),
    bookId: state.book.id,
    chapterIndex: chapterAt(sel.start).index,
    start: sel.start,
    end: sel.end,
    text: state.content.slice(sel.start, sel.end),
    color: color || 'yellow',
    note: '',
    createdAt: Date.now()
  };
  await db.putMark(m);
  state.marks.push(m);
  state.marks.sort((a, b) => a.start - b.start);
  renderReader(state.chapter, { ratio: currentRatio(), silent: true });
  updateBookNoteCount();
  return m;
}

async function removeMark(id) {
  await db.deleteMark(id);
  state.marks = state.marks.filter(m => m.id !== id);
  renderReader(state.chapter, { ratio: currentRatio(), silent: true });
  updateBookNoteCount();
  renderNotes();
}

function currentRatio() {
  const sc = $('#readerScroll');
  return sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0;
}

function updateBookNoteCount() {
  const _nc = $('#bookNoteCount'); if (_nc) _nc.textContent = state.marks.length + state.notes.length;
}

/* 点击已有标记 */
$('#reader').addEventListener('click', (e) => {
  const mark = e.target.closest('mark.hl');
  if (mark) {
    const m = state.marks.find(x => x.id === mark.dataset.id);
    if (m) openNoteModal(m);
    return;
  }
  const inn = e.target.closest('.in-note, .inline-chip');
  if (inn) showInlineTip(inn);
});

/* ══════════════════════ 笔记弹窗 ══════════════════════ */
let noteColor = 'yellow';

function openNoteModal(mark) {
  state.editingMark = mark;
  noteColor = mark.color || 'yellow';
  $('#noteQuote').textContent = mark.text;
  $('#noteText').value = mark.note || '';
  renderNoteColors();
  $('#noteMask').hidden = false;
  setTimeout(() => $('#noteText').focus(), 50);
}

function renderNoteColors() {
  let box = $('#noteColors');
  if (!box) {
    box = document.createElement('div');
    box.id = 'noteColors';
    box.className = 'note-colors';
    $('#noteQuote').after(box);
  }
  box.innerHTML = HL_COLORS.map(c =>
    `<button class="sw ${c}${c === noteColor ? ' on' : ''}" data-c="${c}" title="${c}"></button>`
  ).join('');
}

$('#noteMask').addEventListener('click', async (e) => {
  const sw = e.target.closest('.sw');
  if (sw) {
    noteColor = sw.dataset.c;
    renderNoteColors();
    const m = state.editingMark;
    if (m) { m.color = noteColor; await db.putMark(m); renderReader(state.chapter, { ratio: currentRatio(), silent: true }); }
    return;
  }
  if (e.target.id === 'noteMask') closeNoteModal();
});

$('#noteClose').addEventListener('click', closeNoteModal);
function closeNoteModal() { $('#noteMask').hidden = true; state.editingMark = null; }

$('#noteSave').addEventListener('click', async () => {
  const m = state.editingMark;
  if (!m) return;
  m.note = $('#noteText').value.trim();
  m.color = noteColor;
  m.updatedAt = Date.now();
  await db.putMark(m);
  closeNoteModal();
  renderReader(state.chapter, { ratio: currentRatio(), silent: true });
  renderNotes();
  updateBookNoteCount();
  toast(m.note ? '笔记已保存' : '已保存标记');
});

$('#noteDelete').addEventListener('click', async () => {
  const m = state.editingMark;
  if (!m) return;
  await removeMark(m.id);
  closeNoteModal();
  toast('已删除');
});

/* ══════════════════════ 面板 ══════════════════════ */
function openPanel(tab) {
  const panel = $('#panel');
  panel.hidden = false;
  if (tab) switchTab(tab);
  if (tab === 'search') setTimeout(() => $('#searchInput').focus(), 60);
}
function closePanel() { $('#panel').hidden = true; }
function closePanelIfMobile() { if (window.innerWidth <= 900) closePanel(); }

function switchTab(tab) {
  state.panelTab = tab;
  $$('#panelTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['assistant', 'notes', 'search', 'materials', 'create'].forEach(t => $('#tab-' + t).hidden = t !== tab);
  if (tab === 'notes') renderNotes();
  if (tab === 'materials') renderMaterials();
  if (tab === 'create') renderCreateList();
  if (tab === 'search') { $('#searchInput').focus(); renderSearch(); }
}

$('#panelTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) switchTab(b.dataset.tab);
});
$('#btnClosePanel').addEventListener('click', closePanel);
$('#btnAssistant').addEventListener('click', () => openPanel('assistant'));
$('#btnSearch').addEventListener('click', () => openPanel('search'));

/* ══════════════════════ 助手 ══════════════════════ */
function renderChat() {
  const box = $('#chat');
  box.innerHTML = '';
  if (!state.chat.length) {
    const b = state.book;
    addBotMessage(ai.mdToHtml(`我在读《${b.title.replace(/[*_`]/g, '')}》。你可以：

- **定位**：「读第三回」「下一章」「回到开头」
- **追问**：「黛玉进贾府时看到了什么」「这句话什么意思」
- **结构**：「本章脉络」「全书框架」「写作借鉴」

也可以直接在正文里选中一段，点「解释」。
${ai.aiReady() ? '' : '\n> 现在是本地模式：定位与检索可用，语义解释需要先在设置里接入大模型。'}`), { save: false });
    return;
  }
  for (const m of state.chat) {
    if (m.role === 'user') addUserMessage(m.content, false);
    else addBotMessage(m.html || mdOrHtml(m.content), { save: false });
  }
  box.scrollTop = box.scrollHeight;
}

function mdOrHtml(s) {
  return /<(p|div|ul|ol|h[1-4]|blockquote|table)\b/i.test(s) ? s : ai.mdToHtml(s || '');
}

function addUserMessage(text, save = true) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  $('#chat').appendChild(el);
  scrollChat();
  if (save) state.chat.push({ role: 'user', content: text });
}

function addBotMessage(html, opts = {}) {
  const el = document.createElement('div');
  el.className = 'msg bot';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = html;
  el.appendChild(bubble);
  let toolsHtml = opts.tools || '';
  if (opts.save !== false && !toolsHtml.includes('data-save')) {
    toolsHtml += '<button class="mini-btn" data-save-msg="1">存为笔记</button>';
  }
  if (toolsHtml) {
    const t = document.createElement('div');
    t.className = 'msg-tools';
    t.innerHTML = toolsHtml;
    el.appendChild(t);
  }
  if (opts.note) {
    const n = document.createElement('div');
    n.className = 'msg-note';
    n.textContent = opts.note;
    el.appendChild(n);
  }
  $('#chat').appendChild(el);
  scrollChat();
  if (opts.save !== false) {
    state.chat.push({ role: 'bot', content: opts.raw || bubble.textContent, html: bubble.innerHTML });
  }
  return bubble;
}

function scrollChat() {
  const box = $('#chat');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

$('#quickChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) sendChat(b.dataset.q);
});

$('#btnSend').addEventListener('click', () => sendChat($('#chatInput').value));
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('#chatInput').value); }
});
$('#chatInput').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 110) + 'px';
});

async function sendChat(raw) {
  const q = (raw || '').trim();
  if (!q || !state.book) return;
  if (state.busy) { toast('上一个问题还在处理…'); return; }
  $('#chatInput').value = '';
  $('#chatInput').style.height = 'auto';
  openPanel('assistant');
  addUserMessage(q);

  try {
    const handled = await routeQuery(q);
    if (handled) return;
  } catch (err) {
    addBotMessage(`<p style="color:var(--accent)">${escapeHtml(aiExplainError(err))}</p>`);
  }
}

/* 意图路由 */
async function routeQuery(q) {
  // 1) 导航类
  const nav = matchNav(q);
  if (nav) {
    if (nav.type === 'handled') return true;
    if (nav.type === 'chapter') {
      const idx = nav.index;
      const ch = state.book.chapters[idx];
      const preview = state.content.slice(ch.start, ch.start + 900).replace(/\s+/g, ' ');
      renderReader(idx);
      addBotMessage(
        `<p>已翻到 <strong>${escapeHtml(cleanTitle(ch.title))}</strong>。这一章约 ${(ch.end - ch.start).toLocaleString()} 字，预计 ${Math.max(1, Math.round((ch.end - ch.start) / 420))} 分钟。</p>
         <blockquote>${escapeHtml(preview.slice(0, 260))}…</blockquote>`,
        {
          tools: `<button class="mini-btn" data-jump="${idx}">跳回本章开头</button>
                  <button class="mini-btn" data-copy="${ch.start}" data-len="600">复制开头 600 字</button>`,
          note: nav.how
        }
      );
      return true;
    }
    if (nav.type === 'next' || nav.type === 'prev') {
      if (nav.type === 'next' && state.chapter < state.book.chapters.length - 1) renderReader(state.chapter + 1);
      if (nav.type === 'prev' && state.chapter > 0) renderReader(state.chapter - 1);
      const ch = state.book.chapters[state.chapter];
      addBotMessage(`<p>${nav.type === 'next' ? '下一章' : '上一章'}：<strong>${escapeHtml(cleanTitle(ch.title))}</strong></p>`, {
        tools: `<button class="mini-btn" data-jump="${state.chapter}">看看开头</button>`
      });
      return true;
    }
  }

  // 2) 框架类
  if (/框架|结构|脉络|主线|大纲|拆.{0,3}(书|这本|全书|整本)|梳理.{0,4}(全书|整本|本章|这一章)|讲什么|讲了什么|主要内容|(本章|这一章|这章).{0,4}(怎么写|怎么讲|写什么)/.test(q)) {
    const isChapter = /本章|这一章|这章/.test(q);
    await showOutline(isChapter ? 'chapter' : 'book', q);
    addBotMessage(`<p>${isChapter ? '本章脉络' : '全书框架'}已经整理好了，在右侧面板里。</p>`, {
      tools: `<button class="mini-btn" data-outline="${isChapter ? 'chapter' : 'book'}">再看一次</button>`
    });
    return true;
  }

  // 2.5) 写作借鉴
  if (/写作|借鉴|仿写|技法|文笔|怎么写|写法|笔法|能抄|可抄|抄什么/.test(q)) {
    await showOutline('writing', q);
    addBotMessage(`<p>从写作者角度的拆解已经整理好了，在右侧面板里。</p>`, {
      tools: `<button class="mini-btn" data-outline="writing">再看一次</button>`
    });
    return true;
  }

  // 3) 解释类："解释 xxx"
  const em = q.match(/^(解释|说说|讲讲|理解|分析)[一下：:\s]*(.+)$/);
  if (em && em[2].length <= 120) {
    const target = em[2].replace(/[「」"']/g, '');
    const pos = state.content.indexOf(target);
    if (pos >= 0) await askExplain(target, pos, pos + target.length, false);
    else await askGeneric(q, target);
    return true;
  }

  // 4) 其它 → 检索增强问答
  await askGeneric(q);
  return true;
}

function matchNav(q) {
  if (/^(继续|接着读|下一页|下一节)/.test(q)) return { type: 'next' };
  if (/^(上一章|上一节|往前)/.test(q)) return { type: 'prev' };
  if (/^(回到)?(开头|最开始|第一页|全书开头)/.test(q)) return { type: 'chapter', index: 0, how: '' };

  const explicit = /^(读|看|打开|跳到|翻到|去|念)/.test(q);
  const question = /讲什么|讲了什么|什么意思|为什么|怎么样|如何|是谁|分析|评价|概括|内容/.test(q);
  if (question && !explicit) return null;

  const m = q.match(/第\s*([0-9零〇一二三四五六七八九十百千两]+)\s*([章回节卷篇部集])/);
  if (m) {
    const numStr = m[1], unit = m[2];
    const n = cnToNum(numStr);
    let idx = state.book.chapters.findIndex(c => c.title.replace(/\s/g, '').includes(`第${numStr}${unit}`));
    if (idx < 0 && n > 0) idx = n - 1;
    if (idx < 0 || idx >= state.book.chapters.length) {
      addBotMessage(`<p>这本书里没找到「第${numStr}${unit}」。全书共 ${state.book.chapters.length} 章，可以试试「读第 ${Math.min(n, state.book.chapters.length)} 章」。</p>`);
      return { type: 'handled' };
    }
    return { type: 'chapter', index: idx, how: '' };
  }

  const cn = q.match(/^(读|看|打开|跳到|翻到|去)\s*(.{1,20})$/);
  if (cn) {
    const key = cn[2].trim();
    const idx = state.book.chapters.findIndex(c => cleanTitle(c.title).includes(key));
    if (idx >= 0) return { type: 'chapter', index: idx, how: '' };
  }
  return null;
}

/* 解释选中文字 */
async function askExplain(text, start, end, echo = true) {
  const { chapter } = chapterAt(start);
  const ctx = state.content.slice(Math.max(chapter.start, start - 700), Math.min(chapter.end, end + 700));
  openPanel('assistant');
  if (echo) addUserMessage(`解释：「${text.length > 60 ? text.slice(0, 60) + '…' : text}」`);

  if (!ai.aiReady()) {
    const html = ai.localExplain(state.book, state.content, text, chapter.title);
    addBotMessage(`<div class="local-badge">本地模式</div>${html}`, {
      tools: `<button class="mini-btn" data-goto="${start}">回到原文</button>
              <button class="mini-btn" data-settings="1">接入大模型</button>`,
      note: '未配置模型，只能给出文本内证据'
    });
    return;
  }

  const bubble = addBotMessage('<span class="typing"><i></i><i></i><i></i></span>', { save: false });
  let acc = '';
  state.busy = true;
  try {
    await ai.askAI(ai.promptExplain(state.book, chapter.title, text, ctx), {
      maxTokens: 1400,
      onDelta: (d) => { acc += d; bubble.innerHTML = ai.mdToHtml(acc); scrollChat(); }
    });
    bubble.innerHTML = ai.mdToHtml(acc) + (ai.wasTruncated() ? truncatedNote() : '');
    state.chat.push({ role: 'bot', content: acc, html: bubble.innerHTML });
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    tools.innerHTML = `<button class="mini-btn" data-goto="${start}">回到原文</button>
                       <button class="mini-btn" data-copy-html="1">复制解释</button>
                       <button class="mini-btn" data-save-msg="1">存为笔记</button>`;
    bubble.parentElement.appendChild(tools);
  } catch (err) {
    updateUsageUI();
    showChatError(bubble, err, () => askExplain(text, start, end, false));
  } finally {
    state.busy = false;
  }
}

/* 把模型/网络错误翻译成小白能看懂的话 */
function aiExplainError(err) {
  const m = (err && err.message) || '未知错误';
  if (/API Key|鉴权|401/.test(m)) return 'API Key 不对或失效了。请到「设置 → 大模型」重新填一次 Key。';
  if (/尚未配置/.test(m)) return '还没配置大模型。到「设置 → 大模型」填好接口地址、模型名和 Key 再用。';
  if (/404|接口地址|模型名/.test(m)) return '接口地址或模型名填错了。到设置里核对服务商、地址与模型名。';
  if (/超时|timeout|已取消|abort/i.test(m)) return '模型响应太慢或中途断了。稍等一会，点「重试」即可。';
  if (/余额|欠费|quota|insufficient|限流|rate limit/i.test(m)) return '模型账户可能余额不足或被限流，请到服务商后台看看。';
  if (/Failed to fetch|NetworkError|跨域|CORS|load failed|网络错误|网络不佳/i.test(m)) return '连不上模型服务，多半是浏览器跨域限制或网络问题。用本应用的启动脚本运行可绕过跨域；也可检查接口地址是否正确。';
  return '调用模型出错了：' + m;
}
/* 在气泡里渲染一条友好错误 + 重试按钮 */
function showChatError(bubble, err, retry) {
  bubble.innerHTML = `<p style="color:var(--accent);margin:0">${escapeHtml(aiExplainError(err))}</p>`;
  const bar = document.createElement('div');
  bar.className = 'msg-tools';
  const btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.textContent = '重试';
  btn.dataset.retryChat = '1';
  if (typeof retry === 'function') btn._retry = retry; else btn.disabled = true;
  bar.appendChild(btn);
  const set = document.createElement('button');
  set.className = 'mini-btn';
  set.textContent = '检查设置';
  set.dataset.settings = '1';
  bar.appendChild(set);
  (bubble.parentElement || bubble).appendChild(bar);
}

/* 通用问答 */
async function askGeneric(q, forcedKeyword) {
  let keyword = forcedKeyword || extractKeyword(q);
  let passages = searchPassages(keyword, { limit: 6, dedupe: true });

  // 整句检索不到时，拆成实词逐个试
  if (!passages.length && !forcedKeyword) {
    for (const k of pickKeywords(q)) {
      const r = searchPassages(k, { limit: 6, dedupe: true });
      if (r.length) { passages = r; keyword = k; break; }
    }
  }

  if (!ai.aiReady()) {
    if (!passages.length) {
      addBotMessage(`<p>书里没有直接出现「${escapeHtml(keyword)}」。</p>
        <p style="font-size:11.5px;color:var(--ink-3)">本地模式只做字面检索。换个更短的词，或接入大模型后按语义回答。</p>`,
        { tools: `<button class="mini-btn" data-settings="1">去设置</button>` });
      return;
    }
    const list = passages.map(p => `
      <div class="card" data-goto="${p.start}">
        <div class="card-head"><span class="card-chapter">${escapeHtml(cleanTitle(p.chapter))}</span></div>
        <div class="card-text">${p.html}</div>
        <div class="card-actions"><button data-goto="${p.start}">跳转</button><button data-copy-text="${p.start}">复制文段</button></div>
      </div>`).join('');
    addBotMessage(`<p>「<strong>${escapeHtml(keyword)}</strong>」在书中找到 ${passages.length} 处相关段落：</p>${list}`,
      { note: '本地模式 · 字面检索' });
    return;
  }

  const history = state.chat.slice(-7, -1)
    .filter(m => m && m.content)
    .map(m => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: String(m.content).slice(0, 1000) }));

  const bubble = addBotMessage('<span class="typing"><i></i><i></i><i></i></span>', { save: false });
  let acc = '';
  state.busy = true;
  try {
    await ai.askAI(ai.promptChat(state.book, q, passages.map(p => ({
      chapter: cleanTitle(p.chapter), text: p.raw
    })), cleanTitle(state.book.chapters[state.chapter].title), history), {
      maxTokens: 2000,
      onDelta: (d) => { acc += d; bubble.innerHTML = ai.mdToHtml(acc); scrollChat(); }
    });
    bubble.innerHTML = ai.mdToHtml(acc) + (ai.wasTruncated() ? truncatedNote() : '');
    state.chat.push({ role: 'bot', content: acc, html: bubble.innerHTML });
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const seen = new Set();
    const jumpBtns = passages.filter(p => {
      if (seen.has(p.chapter)) return false;
      seen.add(p.chapter); return true;
    }).slice(0, 3).map(p => `<button class="mini-btn" data-goto="${p.start}">${escapeHtml(cleanTitle(p.chapter).slice(0, 10))}</button>`).join('');
    tools.innerHTML = `<button class="mini-btn" data-copy-html="1">复制回答</button><button class="mini-btn" data-save-msg="1">存为笔记</button>` + jumpBtns
      + `<button class="mini-btn" data-follow="展开讲讲">展开讲讲</button><button class="mini-btn" data-follow="举个例子">举个例子</button>`;
    bubble.parentElement.appendChild(tools);
  } catch (err) {
    updateUsageUI();
    showChatError(bubble, err, () => askGeneric(q, forcedKeyword));
  } finally {
    state.busy = false;
  }
}

const QW = new Set(['什么','怎么','为什么','如何','哪些','多少','是不是','有没有','这本书','本书','里面','其中','时候','看到','看见','知道','觉得','我们','他们','她们','可以','一个','这个','那个','讲了','说的','表达','意思','主要','内容','一下','帮我','请问','想知道']);

function pickKeywords(q) {
  const cleaned = q.replace(/[？?。，,、！!\s“”"'「」：:；;]/g, '');
  if (!window.Intl || !Intl.Segmenter) return [cleaned];
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const out = [];
  for (const s of seg.segment(cleaned)) {
    if (!s.isWordLike) continue;
    const w = s.segment.trim();
    if (w.length < 2 || w.length > 8) continue;
    if (QW.has(w)) continue;
    if (/^[0-9a-zA-Z]+$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  out.sort((a, b) => b.length - a.length);
  return out.length ? out.slice(0, 8) : [cleaned];
}

function extractKeyword(q) {
  let k = q.replace(/[？?。，,、！!\s]/g, '');
  k = k.replace(/^(请问|我想知道|帮我看看|帮我查|书里|书中|里面|关于)/, '');
  k = k.replace(/(是什么|什么意思|是谁|怎么样|为什么|如何|讲的是什么|讲了什么)$/, '');
  if (k.length > 14) k = k.slice(0, 14);
  return k || q;
}

/* 检索 */
function searchPassages(query, { limit = 30, dedupe = false } = {}) {
  if (!query) return [];
  const content = state.content;
  const lower = content.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return [];
  const results = [];
  let idx = 0;
  let guard = 0;
  const perChapter = new Map();

  while ((idx = lower.indexOf(q, idx)) !== -1 && guard++ < 5000) {
    const { index, chapter } = chapterAt(idx);
    const cnt = (perChapter.get(index) || 0) + 1;
    perChapter.set(index, cnt);
    if (!dedupe || cnt <= 3) {
      const s = Math.max(chapter.start, idx - 120);
      const e = Math.min(chapter.end, idx + q.length + 160);
      const raw = content.slice(s, e).replace(/\s+/g, ' ');
      const html = escapeHtml(raw).replace(
        new RegExp(escapeRegExp(query), 'gi'),
        m => `<em>${m}</em>`
      );
      results.push({ start: idx, chapter: cleanTitle(chapter.title), chapterIndex: index, raw, html, count: perChapter.get(index) });
    }
    if (results.length >= limit) break;
    idx += q.length;
  }
  return results;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const searchCache = { q: '', res: [] };
function renderSearch() {
  const q = $('#searchInput').value.trim();
  const box = $('#searchResults');
  if (!q) {
    box.innerHTML = '';
    $('#searchMeta').textContent = state.book ? `全书 ${(state.book.charCount / 10000).toFixed(1)} 万字` : '';
    return;
  }
  if (searchCache.q !== q || !searchCache.res.length) {
    searchCache.q = q;
    searchCache.res = searchPassages(q, { limit: 80 });
  }
  const res = searchCache.res;
  $('#searchMeta').textContent = res.length ? `找到 ${res.length} 处` : '没有找到';

  if (!res.length) {
    box.innerHTML = `<div class="notes-empty">没有匹配「${escapeHtml(q)}」的文段。<br>换个更短的词试试。</div>`;
    return;
  }
  box.innerHTML = res.map(r => `
    <div class="sr-item" data-goto="${r.start}">
      <div class="sr-head">${escapeHtml(r.chapter)}</div>
      <div class="sr-text">${r.html}</div>
    </div>`).join('');
}

$('#searchInput').addEventListener('input', debounce(renderSearch, 200));
$('#searchResults').addEventListener('click', (e) => {
  const item = e.target.closest('[data-goto]');
  if (item) gotoOffset(+item.dataset.goto);
});
$('#chat').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-jump],[data-goto],[data-copy],[data-copy-text],[data-copy-html],[data-settings],[data-outline],[data-save-note],[data-save-msg],[data-follow],[data-retry-chat]');
  if (!t) return;
  if (t.dataset.retryChat) {
    const cb = t._retry, bar = t.closest('.msg-tools');
    if (bar) bar.remove();
    if (typeof cb === 'function') cb();
    return;
  }
  if (t.dataset.follow) { sendChat(t.dataset.follow); return; }
  if (t.dataset.jump) { renderReader(+t.dataset.jump); closePanelIfMobile(); }
  if (t.dataset.goto) { gotoOffset(+t.dataset.goto); }
  if (t.dataset.copy) {
    const s = +t.dataset.copy, len = +(t.dataset.len || 500);
    await copyText(state.content.slice(s, s + len));
    toast('已复制');
  }
  if (t.dataset.copyText) {
    const s = +t.dataset.copyText;
    await copyText(state.content.slice(s, s + 500).replace(/\s+/g, ' ').trim());
    toast('已复制文段');
  }
  if (t.dataset.copyHtml) {
    const html = t.closest('.msg').querySelector('.bubble').innerText;
    await copyText(html);
    toast('已复制');
  }
  if (t.dataset.settings) openSettings();
  if (t.dataset.outline) showOutline(t.dataset.outline);
  if (t.dataset.saveMsg) {
    const msg = t.closest('.msg');
    const bubble = msg.querySelector('.bubble');
    const prev = msg.previousElementSibling;
    const q = prev && prev.classList.contains('user') ? prev.innerText.replace(/\s+/g, ' ').slice(0, 26) : '问答';
    const note = {
      id: db.uid(),
      bookId: state.book.id,
      chapterIndex: state.chapter,
      title: 'AI · ' + q,
      body: bubble.innerHTML,
      kind: 'ai',
      createdAt: Date.now()
    };
    await db.putNote(note);
    state.notes.push(note);
    updateBookNoteCount();
    renderNotes();
    toast('已存为笔记');
  }
  if (t.dataset.saveNote) {
    const [s, e2] = t.dataset.saveNote.split('|').map(Number);
    const text = state.content.slice(s, e2);
    const html = t.closest('.msg').querySelector('.bubble').innerHTML;
    const note = {
      id: db.uid(), bookId: state.book.id, chapterIndex: chapterAt(s).index,
      title: '解释：' + text.slice(0, 24) + (text.length > 24 ? '…' : ''),
      body: html, markdown: html, createdAt: Date.now()
    };
    note.quote = text;
    await db.putNote(note);
    state.notes.push(note);
    updateBookNoteCount();
    toast('已存为笔记');
  }
});

/* ══════════════════════ 素材库 ══════════════════════ */
let matFilter = 'all';
const MAT_NAME = { action: '动作', face: '神态', sense: '生理', beat: '对话', mood: '氛围', system: '设定', mix: '综合' };

async function renderMaterials() {
  const box = $('#materialsList');
  if (!box) return;
  const all = await db.listMaterials();
  const list = matFilter === 'all' ? all : all.filter(m => m.kind === matFilter);

  if (!list.length) {
    box.innerHTML = `<div class="notes-empty">还没有素材。<br>打开一本书 → 写作 → 「收进素材」，句子会攒在这里，跨书可用。</div>`;
    return;
  }

  box.innerHTML = list.map(m => `
    <div class="note-card mat-card" data-mat-id="${m.id}">
      <button class="note-del" data-del-mat="${m.id}" title="删除">✕</button>
      <div class="note-quote">${escapeHtml(m.text)}</div>
      <div class="note-meta">
        <span>${escapeHtml(m.bookTitle || '')}</span>
        <span>${MAT_NAME[m.kind] || '综合'}</span>
      </div>
    </div>`).join('');
}

async function saveMaterial(el) {
  const text = decodeURIComponent(el.dataset.mat || '');
  if (!text) return;
  await db.putMaterial({
    id: db.uid(),
    text,
    kind: el.dataset.matKind || 'mix',
    chapter: decodeURIComponent(el.dataset.matCh || ''),
    bookId: state.book?.id || '',
    bookTitle: state.book?.title || '',
    at: Number(el.dataset.matAt) || 0,
    createdAt: Date.now()
  });
  el.textContent = '已收';
  el.disabled = true;
  toast('已收进素材');
}

$('#matFilter')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  matFilter = b.dataset.m;
  $$('#matFilter button').forEach(x => x.classList.toggle('on', x === b));
  renderMaterials();
});

$('#materialsList')?.addEventListener('click', async (e) => {
  const d = e.target.closest('[data-del-mat]');
  if (!d) return;
  e.stopPropagation();
  await db.deleteMaterial(d.dataset.delMat);
  renderMaterials();
  toast('已删除');
});

$('#btnExportMat')?.addEventListener('click', async () => {
  const all = await db.listMaterials();
  if (!all.length) return toast('素材库是空的');
  const md = ['# 素材库', '', ...all.map(m =>
    `> ${m.text}\n\n— 《${m.bookTitle || ''}》${m.chapter ? ' · ' + m.chapter : ''}　[${MAT_NAME[m.kind] || '综合'}]\n`
  )].join('\n');
  await deliverText(`素材库-${dateStamp()}.md`, md);
});

/* ══════════════════════ 创作生成 ══════════════════════ */
let createScope = 'book';
let createType = 'plot';
let createFilter = 'all';
let createContext = null;
let lastCreateText = '';
const CREATE_NAME = { plot: '情节', char: '人物', scene: '描写' };

function createScopeInfo() {
  if (createScope === 'chapter') {
    const ch = state.book.chapters[state.chapter];
    return { label: `第 ${state.chapter + 1} 章`, excerpt: state.content.slice(ch.start, ch.end).slice(0, 4000) };
  }
  if (createScope === 'selection' && state.selection && state.selection.end - state.selection.start > 0) {
    const t = state.content.slice(state.selection.start, state.selection.end);
    return { label: '选中文段', excerpt: t.slice(0, 4000) };
  }
  return { label: '全书', excerpt: ai.bookDigest(state.book, state.content).slice(0, 4000) };
}

async function generateCreate() {
  if (!state.book) return;
  if (!ai.aiReady()) { toast('需要先在设置里接入模型'); return; }
  if (createScope === 'selection' && (!state.selection || state.selection.end - state.selection.start < 1)) {
    toast('先在正文选中一段文字'); return;
  }
  const { label, excerpt } = createScopeInfo();
  const req = ($('#createReq')?.value || '').trim();
  const out = $('#createOut'), btn = $('#btnCreate');
  if (!out) return;

  btn.disabled = true; btn.textContent = '生成中…';
  $('#btnCreateSave').hidden = true;
  out.innerHTML = '<p class="outline-loading">正在生成…</p>';

  const msgs = ai.promptCreate(state.book, label, createType, req, excerpt, createContext ? createContext.text : '');
  let acc = '';
  try {
    await ai.askAI(msgs, {
      maxTokens: 2200,
      onDelta: (d) => {
        acc += d;
        out.innerHTML = ai.mdToHtml(acc);
      }
    });
    lastCreateText = acc;
    out.innerHTML = ai.mdToHtml(acc);
    $('#btnCreateSave').hidden = false;
  } catch (err) {
    out.innerHTML = `<p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
  }
  btn.disabled = false; btn.textContent = '生成';
}

async function saveCreate() {
  if (!lastCreateText.trim()) return;
  const { label } = createScopeInfo();
  await db.putCreation({
    id: db.uid(), bookId: state.book.id, bookTitle: state.book.title,
    type: createType, scope: createScope, scopeLabel: label,
    prompt: ($('#createReq')?.value || '').trim(),
    text: lastCreateText.trim(), createdAt: Date.now()
  });
  lastCreateText = '';
  $('#btnCreateSave').hidden = true;
  createContext = null;
  $('#createContextTip').hidden = true;
  renderCreateList();
  toast('已保存到创作库');
}

async function renderCreateList() {
  const box = $('#createList');
  if (!box) return;
  const all = await db.listCreations();
  const list = createFilter === 'all' ? all : all.filter(c => c.type === createFilter);
  if (!list.length) {
    box.innerHTML = '<div class="notes-empty">还没有保存的设定。<br>生成一条后点「保存这条设定」，它会攒在这里，可以据此继续生成。</div>';
    return;
  }
  box.innerHTML = list.map(c => `
    <div class="note-card create-card" data-create-id="${c.id}">
      <button class="note-del" data-del-create="${c.id}" title="删除">✕</button>
      <div class="note-quote">${escapeHtml(c.text.slice(0, 160))}${c.text.length > 160 ? '…' : ''}</div>
      <div class="note-meta">
        <span>${CREATE_NAME[c.type] || '设定'}</span>
        <span>${escapeHtml(c.scopeLabel || '')}</span>
        <span>${escapeHtml(c.bookTitle || '')}</span>
        <span>${fmtDate(c.createdAt)}</span>
      </div>
      <div class="create-card-acts">
        <button class="mini-btn" data-continue-create="${c.id}">据此继续生成</button>
      </div>
    </div>`).join('');
}

$('#createScope').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b) return;
  createScope = b.dataset.scope;
  $$('#createScope button').forEach(x => x.classList.toggle('on', x === b));
});
$('#createType').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  createType = b.dataset.type;
  $$('#createType button').forEach(x => x.classList.toggle('on', x === b));
});
$('#createFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  createFilter = b.dataset.c;
  $$('#createFilter button').forEach(x => x.classList.toggle('on', x === b));
  renderCreateList();
});
$('#btnCreate').addEventListener('click', generateCreate);
$('#btnCreateSave').addEventListener('click', saveCreate);
$('#createContextTip').addEventListener('click', () => {
  createContext = null;
  $('#createContextTip').hidden = true;
  toast('已清除带入的设定');
});
$('#createList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-create]');
  if (del) {
    e.stopPropagation();
    await db.deleteCreation(del.dataset.delCreate);
    renderCreateList();
    toast('已删除');
    return;
  }
  const cont = e.target.closest('[data-continue-create]');
  if (cont) {
    const all = await db.listCreations();
    const c = all.find(x => x.id === cont.dataset.continueCreate);
    if (!c) return;
    createContext = { id: c.id, text: c.text };
    $('#createContextTip').hidden = false;
    $('#createOut').innerHTML = '';
    $('#createReq').value = c.prompt || '';
    switchTab('create');
    toast('已带入这条设定，调整后点生成');
  }
});
$('#btnExportCreate').addEventListener('click', async () => {
  const all = await db.listCreations();
  if (!all.length) return toast('创作库是空的');
  const md = ['# 创作库', '', ...all.map(c =>
    `## ${CREATE_NAME[c.type] || '设定'} · ${c.scopeLabel || ''}\n\n${c.text}\n\n— 《${c.bookTitle || ''}》 ${fmtDate(c.createdAt)}\n`
  )].join('\n');
  await deliverText(`创作库-${dateStamp()}.md`, md);
});

/* ══════════════════════ 笔记面板 ══════════════════════ */
function renderNotes() {
  if (!state.book) return;
  const box = $('#notesList');
  const f = state.noteFilter;

  let items = [];
  if (f !== 'ai') {
    for (const m of state.marks) {
      if (f === 'note' && !m.note) continue;
      items.push({ kind: 'mark', at: m.start, chapterIndex: chapterAt(m.start).index, data: m });
    }
  }
  if (f !== 'highlight') {
    for (const n of state.notes) {
      if (f === 'ai' && n.kind !== 'ai') continue;
      items.push({ kind: 'note', at: 0, chapterIndex: n.chapterIndex, data: n });
    }
  }
  items.sort((a, b) => a.chapterIndex - b.chapterIndex || a.at - b.at);

  if (!items.length) {
    box.innerHTML = `<div class="notes-empty">${f === 'note' ? '还没有写过笔记。<br>选中文字 → 点「笔记」。' : '还没有标记。<br>选中正文任意一段，就能高亮或记笔记。'}</div>`;
    return;
  }

  let html = '';
  let lastCh = -1;
  for (const it of items) {
    if (it.chapterIndex !== lastCh) {
      lastCh = it.chapterIndex;
      const ch = state.book.chapters[lastCh];
      html += `<div class="note-group-title">${escapeHtml(cleanTitle(ch?.title || '未分章'))}</div>`;
    }
    if (it.kind === 'mark') {
      const m = it.data;
      html += `<div class="note-card c-${m.color}" data-goto="${m.start}">
        <button class="note-del" data-del-mark="${m.id}" title="删除">✕</button>
        <div class="note-quote">${escapeHtml(m.text)}</div>
        ${m.note ? `<div class="note-mine">${escapeHtml(m.note)}</div>` : ''}
        <div class="note-meta"><span>${fmtDate(m.createdAt)}</span>${m.note ? '<span>笔记</span>' : '<span>标记</span>'}</div>
      </div>`;
    } else {
      const n = it.data;
      const kindLabel = n.kind === 'ai' ? 'AI 回答' : n.kind === 'chapter' ? '章节脉络' : n.kind === 'writing' ? '写作借鉴' : n.kind === 'checkup' ? '稿件体检' : n.kind === '拆书批注' ? '拆书批注' : '整段笔记';
      html += `<div class="note-card" style="border-left-color:var(--ink-3)" data-note="${n.id}">
        <button class="note-del" data-del-note="${n.id}" title="删除">✕</button>
        <div class="note-mine" style="border:none;padding-top:0;margin-top:0;font-family:var(--serif)">${escapeHtml(n.title)}</div>
        <div class="note-meta"><span>${fmtDate(n.createdAt)}</span><span>${kindLabel}</span>${n.at != null ? `<button class="mini-btn" data-goto="${n.at}">回原文</button>` : ''}</div>
      </div>`;
    }
  }
  box.innerHTML = html;
}

function setupContinue(container, msgs, accRef, maxTokens, note = true) {
  const wrap = document.createElement('div');
  wrap.className = 'cont-wrap';
  if (note) {
    const n = document.createElement('p');
    n.className = 'trunc-note';
    n.textContent = '内容到这里被模型截断了（达到输出上限）。可以继续写，也可以点底部「重新生成」换个写法。';
    wrap.appendChild(n);
  }
  const btn = document.createElement('button');
  btn.className = 'mini-btn cont-btn';
  btn.textContent = '继续写 ↘';
  wrap.appendChild(btn);
  container.appendChild(wrap);

  let acc = accRef.value || '';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '续写中…';
    const box = document.createElement('div');
    box.className = 'cont-body';
    container.appendChild(box);

    let add = '';
    try {
      await ai.continueAI(msgs, acc, {
        maxTokens,
        onDelta: (d) => { add += d; box.innerHTML = ai.mdToHtml(add); container.scrollTop = container.scrollHeight; }
      });
      acc = acc + add;
      accRef.value = acc;
      box.innerHTML = ai.mdToHtml(add);
      container.appendChild(wrap); // 按钮始终在最新内容下面
      if (ai.wasTruncated()) {
        btn.textContent = '继续写 ↘';
        btn.disabled = false;
      } else {
        btn.remove();
      }
    } catch (e) {
      box.innerHTML = `<p style="color:var(--accent)">续写失败：${escapeHtml(e.message)}</p>`;
      btn.textContent = '重试';
      btn.disabled = false;
    }
  });
}

function truncatedNote() {
  return `<p class="trunc-note">内容到这里被模型截断了（达到输出上限）。可以点底部「重新生成」，或把要求拆成两次问。</p>`;
}

function fmtDate(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

$('#noteFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.noteFilter = b.dataset.f;
  $$('#noteFilter button').forEach(x => x.classList.toggle('on', x === b));
  renderNotes();
});

$('#notesList').addEventListener('click', async (e) => {
  const dm = e.target.closest('[data-del-mark]');
  if (dm) {
    e.stopPropagation();
    await removeMark(dm.dataset.delMark);
    renderNotes();
    toast('已删除');
    return;
  }
  const dn = e.target.closest('[data-del-note]');
  if (dn) {
    e.stopPropagation();
    if (!confirm('删除这条笔记？')) return;
    await db.deleteNoteDB(dn.dataset.delNote);
    state.notes = state.notes.filter(n => n.id !== dn.dataset.delNote);
    renderNotes();
    updateBookNoteCount();
    toast('已删除');
    return;
  }
  const card = e.target.closest('[data-goto]');
  if (card) { gotoOffset(+card.dataset.goto); return; }
  const nc = e.target.closest('[data-note]');
  if (nc) {
    const n = state.notes.find(x => x.id === nc.dataset.note);
    if (n) showOutlineHTML('笔记 · ' + n.title, n.body, null, n);
  }
});


/* ══════════════════════ 框架梳理 ══════════════════════ */
let reuseRange = 'all';

const outlineCache = new Map();

function reuseRangeOf(key) {
  const chs = state.book.chapters;
  if (key === 'chapter') {
    const ch = chs[state.chapter];
    return { start: ch.start, end: ch.end, label: '本章 · ' + cleanTitle(ch.title) };
  }
  if (key === 'arc') {
    const a = Math.max(0, state.chapter - 2);
    const b = Math.min(chs.length - 1, state.chapter + 2);
    return {
      start: chs[a].start,
      end: chs[b].end,
      label: `第 ${a + 1}–${b + 1} 章 · 约一条小故事线`
    };
  }
  return { start: 0, end: state.content.length, label: '全书' };
}

let ckRefId = '';

async function renderCheckupPage(body) {
  const book = state.book;
  const ck = ai.checkupData(book, state.content);
  const others = state.books.filter(b => b.id !== book.id && b.kind !== 'draft');

  let ref = null;
  if (ckRefId) {
    const rb = state.books.find(b => b.id === ckRefId);
    if (rb) {
      const rc = await db.getText(rb.id);
      if (rc) ref = Object.assign({}, ai.checkupData(rb, rc), { title: rb.title });
    }
  }

  body.innerHTML = `
    <div class="ck-head">
      <div>
        <div class="ck-kicker">MANUSCRIPT CHECKUP</div>
        <p class="ck-sub">按网文的留存标准量，不评文笔。规则算的，不花钱。</p>
      </div>
      ${others.length ? `<select id="ckRefSel" class="ck-sel">
        <option value="">对比：无</option>
        ${others.map(b => `<option value="${b.id}"${b.id === ckRefId ? ' selected' : ''}>对比《${escapeHtml(b.title.slice(0, 12))}》</option>`).join('')}
      </select>` : ''}
    </div>
    <div id="ckBody">${ai.checkupHTML(book, ck, ref)}</div>
    <div id="ckAI"></div>`;

  $('#outlineHint').textContent = '本地规则 · 不调用模型';
  $('#btnOutlineCopy').disabled = false;
  $('#btnOutlineSave').disabled = false;

  state.outline = { type: 'checkup', chapterIndex: 0, md: ai.checkupText(book, ck), html: body.innerHTML };

  $('#ckRefSel')?.addEventListener('change', async (e) => {
    ckRefId = e.target.value;
    await renderCheckupPage(body);
  });

  if (!ai.aiReady()) return;

  const aiBox = $('#ckAI');
  aiBox.innerHTML = '<h3>编辑意见</h3><p class="outline-loading">正在读稿…</p>';
  try {
    let acc = '';
    const msgs = ai.promptReview(book, ai.bookDigest(book, state.content), ck, ck.stats);
    await ai.askAI(msgs, {
      maxTokens: 1600,
      onDelta: (d) => { acc += d; aiBox.innerHTML = '<h3>编辑意见</h3>' + ai.mdToHtml(acc); }
    });
    aiBox.innerHTML = '<h3>编辑意见</h3>' + ai.mdToHtml(acc);
    state.outline.md = ai.checkupText(book, ck) + '\n\n' + acc;
    state.outline.html = body.innerHTML;
  } catch (err) {
    aiBox.innerHTML = `<h3>编辑意见</h3><p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
  }
}

function renderReuse(key = reuseRange) {
  reuseRange = key;
  const box = $('#wReuse');
  if (!box || !state.book) return;
  const r = ai.reuseScan(state.book, state.content, reuseRangeOf(key));
  box.innerHTML = ai.reuseHTML(r, key);
}

async function showOutline(type, question, force = false) {
  if (!state.book) return;
  const isChapter = type === 'chapter';
  const isWriting = type === 'writing';
  const ch = state.book.chapters[state.chapter];
  const title = isChapter
    ? `本章脉络 · ${cleanTitle(ch.title)}`
    : isWriting
      ? (state.book.kind === 'draft' ? `稿件体检 · ${state.book.title}` : `写作借鉴 · ${state.book.title}`)
      : `拆书 · ${state.book.title}`;

  $('#outlineMask').hidden = false;
  $('#outlineTitle').textContent = title;
  $('#outlineHint').textContent = ai.aiReady() ? '模型生成' : '本地统计 · 未接入模型';
  const body = $('#outlineBody');
  body.scrollTop = 0;
  const btnCopy = $('#btnOutlineCopy'), btnSave = $('#btnOutlineSave');

  // 命中缓存：不重复调用模型，也不重复花钱（先内存，再 IndexedDB）
  const cacheKey = `${state.book.id}|${type}|${isChapter ? state.chapter : 0}`;
  let cached = outlineCache.get(cacheKey);
  if (!cached && !force && state.book.kind !== 'draft') {
    cached = await db.getKV('outline.' + cacheKey);
    if (cached) outlineCache.set(cacheKey, cached);
  }
  if (!force && state.book.kind !== 'draft' && cached) {
    const c = cached;
    body.innerHTML = c.html;
    applySavedCore(body, state.book.id);
    state.outline = { type, chapterIndex: state.chapter, md: c.md, html: c.html, cacheKey };
    if (c.form) {
      const p = $('#fwPremise'), g = $('#fwGenre');
      if (p) p.value = c.form.premise || '';
      if (g) g.value = c.form.genre || g.value;
    }
    $('#outlineHint').innerHTML = '<span class="regen-link" id="regenBtn">已生成过 · 点此重新生成</span>';
    btnCopy.disabled = false; btnSave.disabled = false;
    return;
  }

  $('#outlineHint').textContent = ai.aiReady() ? '模型生成' : '本地统计 · 未接入模型';
  btnCopy.disabled = true; btnSave.disabled = true;
  state.outline = { type, chapterIndex: state.chapter, md: '', html: '', cacheKey };

  let failed = false;
  const finish = () => {
    applySavedCore(body, state.book.id);
    const pane = body.querySelector('#wAnalyze');
    state.outline.html = pane ? pane.innerHTML : body.innerHTML;
    if (!failed) {
      const entry = {
        html: state.outline.html,
        md: state.outline.md || '',
        form: {
          premise: $('#fwPremise')?.value || '',
          genre: $('#fwGenre')?.value || ''
        }
      };
      outlineCache.set(cacheKey, entry);
      if (state.book.kind !== 'draft') db.setKV('outline.' + cacheKey, entry);
    }
    btnCopy.disabled = false; btnSave.disabled = false;
  };

  if (isWriting) {
    if (state.book.kind === 'draft') {
      await renderCheckupPage(body);
      return;
    }

    body.innerHTML = `
      <div class="w-nav">
        <a data-wjump="wDiag">写法诊断</a><i>·</i>
        <a data-wjump="wReuse">能搬的文段</a><i>·</i>
        <a data-wjump="wFrameworks">写作框架</a>
      </div>
      <div id="wAnalyze"><div id="wDiag"></div><div id="aiCoach"></div><div id="wReuse"></div></div>
      <details class="w-fw-wrap">
        <summary>写作框架 · 六套骨架</summary>
        <div id="wFrameworks"></div>
      </details>`;

    const analyze = body.querySelector('#wAnalyze');
    const view = Object.assign({}, state.book, { content: state.content });
    const stats = ai.styleStats(state.content, state.book);
    analyze.querySelector('#wDiag').innerHTML = ai.localWriting(view, state.content, stats);

    renderReuse('all');
    body.querySelector('#wFrameworks').innerHTML = ai.localFrameworks();

    if (!ai.aiReady()) { finish(); return; }

    const aiBox = analyze.querySelector('#aiCoach');
    aiBox.innerHTML = `<h3>写作教练</h3><p class="outline-loading">正在拆解这本书的写法…</p>`;
    try {
      let acc = '';
      const wMsgs = ai.promptWriting(state.book, ai.bookDigest(state.book, state.content), stats);
      await ai.askAI(wMsgs, {
        maxTokens: 4500,
        onDelta: (d) => {
          acc += d;
          aiBox.innerHTML = '<h3>写作教练</h3>' + ai.mdToHtml(acc);
        }
      });
      state.outline.md = acc;
      aiBox.innerHTML = '<h3>写作教练</h3>' + ai.mdToHtml(acc);
      if (ai.wasTruncated()) setupContinue(aiBox, wMsgs, { value: acc }, 4500);
    } catch (err) {
      failed = true;
      aiBox.innerHTML = `<h3>写作教练</h3><p style="color:var(--accent)">${escapeHtml(aiExplainError(err))}</p>`;
      $('#outlineHint').innerHTML = '<span class="regen-link" id="regenBtn">生成失败，点此重试</span>';
    }
    finish();
    return;
  }

  if (isChapter) {
    const text = state.content.slice(ch.start, ch.end);
    const card = ai.chapterCardHTML(state.book, ch, text);
    if (!ai.aiReady()) {
      body.innerHTML = ai.localChapterOutline(state.book, ch, text) + card;
      finish();
      return;
    }
    body.innerHTML = `<p class="outline-loading">正在读这一章…</p>` + card;
    try {
      let acc = '';
      const chMsgs = ai.promptChapter(state.book, { title: cleanTitle(ch.title) }, text);
      await ai.askAI(chMsgs, {
        maxTokens: 2800,
        onDelta: (d) => {
          acc += d;
          body.innerHTML = ai.mdToHtml(acc) + card;
          body.scrollTop = body.scrollHeight;
        }
      });
      state.outline.md = acc;
      body.innerHTML = ai.mdToHtml(acc) + card;
      if (ai.wasTruncated()) setupContinue(body, chMsgs, { value: acc }, 2800);
    } catch (err) {
      failed = true;
      body.innerHTML = `<p style="color:var(--accent)">${escapeHtml(aiExplainError(err))}</p>
        <p style="font-size:11.5px;color:var(--ink-3)">下面是本地生成的章节统计，可先用着。</p>` +
        ai.localChapterOutline(state.book, ch, text) + card;
      $('#outlineHint').innerHTML = '<span class="regen-link" id="regenBtn">生成失败 · 点此重试</span>';
    }
    finish();
    return;
  }

  // 拆书：核心梗 → 结构层级 → 情节 → 人物 → 写法
  body.innerHTML = `
    <div class="pl-nav">
      <a data-wjump="secCore">核心梗</a><i>·</i>
      <a data-wjump="secVol">大纲</a><i>·</i>
      <a data-wjump="secChar">人物</a><i>·</i>
      <a data-wjump="secOpen">黄金三章</a><i>·</i>
      <a data-wjump="secEmo">情绪节奏</a><i>·</i>
      <a data-wjump="secPick">推荐</a><i>·</i>
      <a data-wjump="secWrite">写法</a><i>·</i>
      <a data-wjump="secAI">模型</a>
    </div>
    <div id="secCore"></div>
    <div id="secVol"></div>
    ${ai.characterHTML(state.book, state.content)}
    ${ai.openingHTML(state.book, state.content)}
    ${ai.emotionHTML(state.book, state.content)}
    ${ai.writeHTML(state.book, state.content)}
    <div id="secAI"></div>
    <div id="secMine">
      <div class="ch-sub">套用到我的书</div>
      <button class="mini-btn" data-apply>填写我的故事</button>
      <span class="apply-tip">借这本书的分卷，生成你自己的核心梗、分卷、黄金三章（会调用模型）</span>
      <div class="apply-form" hidden>
        <label class="apply-field">题材<input id="apGenre" placeholder="都市 / 玄幻 / 悬疑"></label>
        <label class="apply-field">一句话核心梗<textarea id="apPremise" rows="2" placeholder="谁，原本怎样，因为什么，最后成了什么"></textarea></label>
        <button class="mini-btn" data-apply-go>生成我的骨架</button>
      </div>
      <div id="applyOut"></div>
    </div>`;

  const coreEl = body.querySelector('#secCore');
  const volEl = body.querySelector('#secVol');
  const aiBox = body.querySelector('#secAI');
  const coreKey = 'modu.core.' + state.book.id;
  const savedCore = localStorage.getItem(coreKey) || '';

  const renderCore = (c, opt) => {
    if (document.activeElement && document.activeElement.matches('[data-core-edit]')) return;
    const merged = Object.assign({}, c, { sentence: savedCore || c.sentence });
    body._core = merged;
    coreEl.innerHTML = ai.coreCardHTML(merged, Object.assign(
      { ignored: localStorage.getItem(coreKey + '.ignore') === '1' }, opt || {}
    ));
  };
  const renderVols = (html) => {
    volEl.innerHTML = '<h3 id="secVolH">大纲 · 分卷与阶段</h3>'
      + '<p class="ch-hint">分卷是宏观骨架，不能乱动；卷里具体怎么打、跟谁聊，是随时可换的微观剧情。</p>'
      + html;
  };

  renderVols(ai.volTableHTML(ai.localVolumes(state.book, state.content), true));

  if (!ai.aiReady()) {
    renderCore({ sentence: savedCore, start: '', turn: '', end: '' }, { offline: true });
    body.querySelector('.ch-gen')?.remove();
    body.querySelector('#secMine')?.remove();
    finish();
    return;
  }

  renderCore({ sentence: '', start: '', turn: '', end: '' }, { pending: true });
  aiBox.innerHTML = `<h3 id="secAIH">模型意见</h3><p class="outline-loading">正在按连载的方式读这本书…</p>`;

  try {
    let acc = '';
    const bStats = ai.styleStats(state.content, state.book);
    const bFit = ai.netFitness(state.book, state.content);
    const bookMsgs = ai.promptBook(state.book, ai.bookDigest(state.book, state.content), bStats, bFit);
    await ai.askAI(bookMsgs, {
      maxTokens: 2400,
      onDelta: (d) => {
        acc += d;
        const core = ai.parseCore(acc);
        if (core && (core.sentence || core.start)) renderCore(core);
        const vt = ai.parseVolTable(acc);
        if (vt) renderVols(ai.volTableHTML(vt, false));
        const tail = ai.tailFromAnalysis(acc);
        aiBox.innerHTML = '<h3 id="secAIH">模型意见</h3>' +
          (tail
            ? ai.annotateChapters(ai.mdToHtml(tail), state.book)
            : '<p class="outline-loading">正在搭骨架…核心梗和分卷排在前面。</p>');
      }
    });
    state.outline.md = acc;
    const rep = ai.parseReport(acc);
    if (rep.core || rep.verdict) {
      db.putReport({ id: state.book.id, title: state.book.title, at: Date.now(), ...rep });
    }
    const tail = ai.tailFromAnalysis(acc);
    if (tail) {
      aiBox.innerHTML = '<h3 id="secAIH">模型意见</h3>' + ai.annotateChapters(ai.mdToHtml(tail), state.book);
    } else {
      // 模型没按格式给：整段照原样显示，别把内容吞掉
      aiBox.innerHTML = '<h3 id="secAIH">模型意见</h3>' + ai.annotateChapters(ai.mdToHtml(acc), state.book);
      const core = ai.parseCore(acc);
      if (!core || !core.sentence) {
        coreEl.innerHTML = ai.coreCardHTML({ sentence: savedCore, start: '', turn: '', end: '' }, { mismatch: true });
      }
    }
    if (ai.wasTruncated()) setupContinue(aiBox, bookMsgs, { value: acc }, 2400);
  } catch (err) {
    failed = true;
    aiBox.innerHTML = `<h3 id="secAIH">模型意见</h3><p style="color:var(--accent)">${escapeHtml(aiExplainError(err))}</p>`;
    $('#outlineHint').innerHTML = '<span class="regen-link" id="regenBtn">生成失败，点此重试</span>';
  }
  finish();
}

async function showRangeOutline(a, b) {
  if (!state.book) return;
  const chs = state.book.chapters;
  if (a < 0 || b >= chs.length || a > b) return;
  const subBook = Object.assign({}, state.book, {
    chapters: chs.slice(a, b + 1),
    charCount: chs.slice(a, b + 1).reduce((sum, c) => sum + (c.end - c.start), 0)
  });
  const content = state.content;
  const cacheKey = `${state.book.id}|range|${a}-${b}`;

  $('#outlineMask').hidden = false;
  $('#outlineTitle').textContent = `选段分析 · 第 ${a + 1}–${b + 1} 章`;
  $('#outlineHint').textContent = ai.aiReady() ? '模型生成' : '本地统计 · 未接入模型';
  const body = $('#outlineBody');
  body.scrollTop = 0;
  $('#btnOutlineCopy').disabled = false;
  $('#btnOutlineSave').disabled = false;
  state.outline = { type: 'range', chapterIndex: state.chapter, rangeA: a, rangeB: b, md: '', html: '', cacheKey };

  const buildLocal = () => {
    const open = ai.openingHTML(subBook, content).replace(
      '<h3 id="secOpen">黄金三章</h3>',
      '<h3 id="secOpen">选段开头三章</h3>');
    return `
      <div class="pl-nav">
        <a data-wjump="secOpen">开头</a><i>·</i>
        <a data-wjump="secEmo">情绪节奏</a><i>·</i>
        <a data-wjump="secPick">推荐</a><i>·</i>
        <a data-wjump="secChar">人物</a><i>·</i>
        <a data-wjump="secWrite">写法</a><i>·</i>
        <a data-wjump="secAI">模型</a>
      </div>
      <p class="range-banner">《${escapeHtml(state.book.title)}》第 ${a + 1}–${b + 1} 章 · 共 ${b - a + 1} 章，下面所有章号都是选段内相对序号</p>
      ${open}
      ${ai.emotionHTML(subBook, content)}
      ${ai.characterHTML(subBook, content)}
      ${ai.writeHTML(subBook, content)}
      <div id="secAI"></div>`;
  };

  let cached = outlineCache.get(cacheKey);
  if (!cached && state.book.kind !== 'draft') {
    cached = await db.getKV('outline.' + cacheKey);
    if (cached) outlineCache.set(cacheKey, cached);
  }
  if (cached && state.book.kind !== 'draft') {
    body.innerHTML = cached.html;
    state.outline = { ...state.outline, md: cached.md || '', html: cached.html };
    $('#outlineHint').innerHTML = '<span class="regen-link" id="regenBtn">已生成过 · 点此重新生成</span>';
    return;
  }

  body.innerHTML = buildLocal();
  body.querySelector('.ch-gen')?.remove();
  const aiBox = body.querySelector('#secAI');
  if (!ai.aiReady()) { aiBox?.remove(); return; }

  aiBox.innerHTML = '<h3>模型意见</h3><p class="outline-loading">正在读这段…</p>';
  try {
    let acc = '';
    const stats = ai.styleStats(content, subBook);
    const fit = ai.netFitness(subBook, content);
    const msgs = ai.promptRange(subBook, content, stats, fit);
    await ai.askAI(msgs, {
      maxTokens: 1600,
      onDelta: (d) => {
        acc += d;
        aiBox.innerHTML = '<h3>模型意见</h3>' + ai.annotateChapters(ai.mdToHtml(acc), subBook);
      }
    });
    state.outline.md = acc;
    aiBox.innerHTML = '<h3>模型意见</h3>' + ai.annotateChapters(ai.mdToHtml(acc), subBook);
    const entry = { html: body.innerHTML, md: acc };
    outlineCache.set(cacheKey, entry);
    if (state.book.kind !== 'draft') db.setKV('outline.' + cacheKey, entry);
  } catch (err) {
    aiBox.innerHTML = `<p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
  }
}

function applySavedCore(container, bookId) {
  const el = container.querySelector('[data-core-edit]');
  if (!el) return;
  const v = localStorage.getItem('modu.core.' + bookId);
  if (v) el.textContent = v;
}

function buildSampleText() {
  // 用于词频统计的均匀采样，避免只统计开头
  const step = Math.max(1, Math.floor(state.content.length / 120000));
  if (step === 1) return state.content;
  let out = '';
  for (let i = 0; i < state.content.length; i += step) out += state.content[i];
  return out;
}

function showOutlineHTML(title, html, md, noteObj) {
  $('#outlineMask').hidden = false;
  $('#outlineTitle').textContent = title;
  $('#outlineBody').innerHTML = html;
  $('#outlineHint').textContent = '';
  $('#btnOutlineCopy').disabled = false;
  $('#btnOutlineSave').disabled = true;
  state.outline = { type: 'note', md: md || '', html, note: noteObj, chapterIndex: state.chapter };
}

$('#outlineHint').addEventListener('click', (e) => {
  if (e.target.closest('#regenBtn')) {
    const t = state.outline?.type;
    if (t) showOutline(t, null, true);
  }
});

$('#outlineBody').addEventListener('click', async (e) => {
  const wj = e.target.closest('[data-wjump]');
  if (wj) {
    const el = document.getElementById(wj.dataset.wjump);
    const bd = $('#outlineBody');
    if (el) {
      const pad = bd.querySelector('.pl-nav') ? 46 : 12;
      const top = el.getBoundingClientRect().top - bd.getBoundingClientRect().top + bd.scrollTop - pad;
      bd.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    return;
  }
  const cc = e.target.closest('[data-chars]');
  if (cc) { await generateChars(cc); return; }

  const ckc = e.target.closest('[data-ck-copy]');
  if (ckc) {
    const vals = ['目标', '阻碍', '转折', '收束'].map(k => {
      const t = document.querySelector(`[data-ck="${k}"]`);
      return (t && t.value.trim()) ? `${k}：${t.value.trim()}` : `${k}：__`;
    }).join('\n');
    await copyText(vals); toast('章纲已复制');
    return;
  }
  const cks = e.target.closest('[data-ck-save]');
  if (cks) {
    const vals = ['目标', '阻碍', '转折', '收束'].map(k => {
      const t = document.querySelector(`[data-ck="${k}"]`);
      return (t && t.value.trim()) ? `${k}：${t.value.trim()}` : '';
    }).filter(Boolean).join('\n');
    if (!vals) { toast('先填两格再存'); return; }
    await db.putMaterial({
      id: db.uid(), bookId: state.book.id, kind: '章纲',
      text: `《${state.book.title}》第 ${state.chapter + 1} 章 章纲\n${vals}`,
      ref: `第 ${state.chapter + 1} 章`, createdAt: Date.now()
    });
    toast('已存为素材');
    return;
  }
  const ci = e.target.closest('[data-core-ignore]');
  if (ci) {
    const key = 'modu.core.' + state.book.id + '.ignore';
    const on = localStorage.getItem(key) !== '1';
    localStorage.setItem(key, on ? '1' : '0');
    const coreEl = document.getElementById('secCore');
    const c = $('#outlineBody')._core || { sentence: '', start: '', turn: '', end: '' };
    if (coreEl) coreEl.innerHTML = ai.coreCardHTML(c, { ignored: on });
    return;
  }

  const ap = e.target.closest('[data-apply]');
  if (ap) {
    const form = ap.parentElement.querySelector('.apply-form');
    if (form) form.hidden = !form.hidden;
    return;
  }
  const ag = e.target.closest('[data-apply-go]');
  if (ag) { await generateApply(ag); return; }
  const ca = e.target.closest('[data-copy-apply]');
  if (ca) {
    const raw = ca.parentElement.dataset.raw || '';
    if (raw) { await copyText(raw); toast('已复制'); }
    return;
  }

  const cc2 = e.target.closest('[data-copy-core]');
  if (cc2) {
    const el = $('#outlineBody').querySelector('[data-core-edit]');
    const v = (el && el.textContent || '').trim();
    if (v) { await copyText(v); toast('核心梗已复制'); }
    return;
  }

  const rv = e.target.closest('[data-reuse]');
  if (rv) { renderReuse(rv.dataset.reuse); return; }

  const ga = e.target.closest('[data-goto-at]');
  if (ga) {
    const at = Number(ga.dataset.gotoAt) || 0;
    $('#outlineMask').hidden = true;
    gotoOffset(at);
    return;
  }

  const na = e.target.closest('[data-note-at]');
  if (na) {
    const at = Number(na.dataset.noteAt) || 0;
    const text = (na.dataset.noteText || '').trim();
    if (!text) return;
    const note = {
      id: db.uid(), bookId: state.book.id, chapterIndex: chapterAt(at).index,
      title: '拆书批注 · ' + text.slice(0, 36), body: text, at,
      kind: '拆书批注', createdAt: Date.now()
    };
    await db.putNote(note);
    state.notes.push(note);
    updateBookNoteCount();
    renderNotes();
    toast('已存为批注，可在笔记里跳回原文');
    return;
  }

  const st = e.target.closest('[data-mat]');
  if (st) { await saveMaterial(st); return; }

  const wt = e.target.closest('[data-wtab]');
  if (wt) {
    const body = $('#outlineBody');
    body.querySelectorAll('[data-wtab]').forEach(b => b.classList.toggle('on', b === wt));
    const a = body.querySelector('#wAnalyze');
    const f = body.querySelector('#wFrameworks');
    if (a) a.hidden = wt.dataset.wtab !== 'analyze';
    if (f) f.hidden = wt.dataset.wtab !== 'frameworks';
    return;
  }
  const gen = e.target.closest('[data-fw]');
  if (gen) await generateFramework(gen.dataset.fw, gen);
});

$('#outlineBody').addEventListener('input', (e) => {
  const el = e.target.closest('[data-core-edit]');
  if (!el || !state.book) return;
  localStorage.setItem('modu.core.' + state.book.id, el.textContent.trim());
});

$('#outlineBody').addEventListener('keydown', (e) => {
  if (e.target.matches('[data-core-edit]') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

$('#outlineBody').addEventListener('blur', (e) => {
  const el = e.target.closest && e.target.closest('[data-core-edit]');
  if (!el || !state.book) return;
  const text = el.textContent.trim();
  localStorage.setItem('modu.core.' + state.book.id, text);

  const card = el.closest('.core-card');
  if (!card) return;
  const c = { sentence: text, start: '', turn: '', end: '' };
  if (localStorage.getItem('modu.core.' + state.book.id + '.ignore') === '1') {
    const hint = card.querySelector('.core-hint');
    if (hint) hint.textContent = '校验已关闭。点「重新校验」恢复。';
    return;
  }
  const ck = ai.coreChecks(c);
  const len = card.querySelector('.core-len');
  if (len) { len.textContent = ck.len + ' 字'; len.classList.toggle('over', ck.long); }
  const names = ['开始', '转折', '结束'];
  const flags = [ck.startOk, ck.turnOk, ck.endOk];
  card.querySelectorAll('.ck-chip').forEach((ch, i) => {
    if (i > 2) return;
    ch.classList.toggle('ok', flags[i]);
    ch.classList.toggle('no', !flags[i]);
    ch.textContent = (flags[i] ? '✓ ' : '✕ ') + names[i];
  });
  const hint = card.querySelector('.core-hint');
  if (hint) hint.textContent = ai.coreHint(c);
}, true);

function cacheOutlineNow() {
  const o = state.outline;
  if (!o || !o.cacheKey) return;
  const c = outlineCache.get(o.cacheKey) || { md: o.md || '', form: {} };
  c.html = $('#outlineBody').innerHTML;
  c.md = o.md || c.md || '';
  outlineCache.set(o.cacheKey, c);
  db.setKV('outline.' + o.cacheKey, c);
}

async function generateChars(btn) {
  if (!state.book || !ai.aiReady()) return;
  const box = document.getElementById('charCards');
  if (!box) return;
  const wanted = [...document.querySelectorAll('[data-ch-sel]:checked')]
    .map(x => x.dataset.chSel).filter(Boolean);
  const cast = ai.pickCast(state.book, state.content, 6)
    .filter(r => wanted.includes(r.name)).slice(0, 4);
  if (!cast.length) { toast('先勾选要拆的人'); return; }

  btn.disabled = true;
  btn.textContent = '正在拆…';
  box.innerHTML = '<div class="ch-cards"><p class="outline-loading">正在读这几个人的段落…</p></div>';

  const samples = cast.map(r => ai.castSamples(state.book, state.content, r)).join('\n\n');
  const anchors = cast.map(r => state.book.chapters[r.first - 1].start);
  const msgs = ai.promptCharacters(state.book, cast, samples);
  let acc = '';
  try {
    await ai.askAI(msgs, {
      maxTokens: 2600,
      onDelta: (d) => {
        acc += d;
        box.innerHTML = `<div class="ch-cards">${ai.charCardsHTML(acc, false, anchors)}</div>`;
      }
    });
    box.innerHTML = `<div class="ch-cards">${ai.charCardsHTML(acc, true, anchors)}</div>`;
    if (ai.wasTruncated()) {
      const n = document.createElement('p');
      n.className = 'trunc-note';
      n.textContent = '人物卡被截断了。可以重新生成，或只拆两个人。';
      box.appendChild(n);
    }
    cacheOutlineNow();
  } catch (err) {
    box.innerHTML = `<p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
    btn.disabled = false;
    btn.textContent = '重试';
  }
}

async function generateApply(btn) {
  if (!ai.aiReady()) { toast('需要先在设置里接入模型'); return; }
  const premise = ($('#apPremise')?.value || '').trim();
  if (!premise) { toast('先写一句你的核心梗'); $('#apPremise')?.focus(); return; }
  const genre = ($('#apGenre')?.value || '').trim();
  const out = $('#applyOut');
  if (!out) return;

  const vols = ai.parseVolTable(state.outline?.md || '') || [];
  const volText = vols.map(r => r.join('｜')).join('\n');

  btn.disabled = true;
  btn.textContent = '生成中…';
  out.innerHTML = '<p class="outline-loading">正在搭你的骨架…</p>';

  let acc = '';
  try {
    await ai.askAI(ai.promptApply(state.book, genre, premise, volText), {
      maxTokens: 1600,
      onDelta: (d) => { acc += d; out.innerHTML = ai.mdToHtml(acc); }
    });
    out.innerHTML = ai.mdToHtml(acc)
      + '<div class="apply-acts"><button class="mini-btn" data-copy-apply>复制</button></div>';
    out.dataset.raw = acc;
    cacheOutlineNow();
  } catch (err) {
    out.innerHTML = `<p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
    btn.disabled = false;
    btn.textContent = '重试';
  }
}

async function generateFramework(id, btn) {
  const fw = ai.WRITING_FRAMEWORKS.find(f => f.id === id);
  if (!fw) return;
  const premise = ($('#fwPremise')?.value || '').trim();
  const genre = $('#fwGenre')?.value || '';
  const box = $('#fwRes-' + id);
  if (!box) return;

  if (!premise) {
    toast('先写一句"谁，想要什么，被什么挡住"');
    $('#fwPremise')?.focus();
    return;
  }
  if (!ai.aiReady()) {
    toast('需要先在设置里接入模型');
    return;
  }

  box.hidden = false;
  box.innerHTML = '<p class="outline-loading">正在按这个骨架搭…</p>';
  btn.disabled = true;
  try {
    let acc = '';
    const fwMsgs = ai.promptFramework(fw, genre, premise);
    await ai.askAI(fwMsgs, {
      maxTokens: 3400,
      onDelta: (d) => {
        acc += d;
        box.innerHTML = ai.mdToHtml(acc);
      }
    });
    box.innerHTML = ai.mdToHtml(acc);
    if (ai.wasTruncated()) setupContinue(box, fwMsgs, { value: acc }, 3400, false);
    state.outline.md = (state.outline.md || '') + '\n\n## ' + fw.name + '\n\n' + acc;
    box.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    box.innerHTML = `<p style="color:var(--accent)">失败：${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

$('#btnBookFramework').addEventListener('click', () => showOutline('book'));
$('#outlineClose').addEventListener('click', () => { $('#outlineMask').hidden = true; });
$('#outlineMask').addEventListener('click', (e) => { if (e.target.id === 'outlineMask') $('#outlineMask').hidden = true; });

$('#btnOutlineCopy').addEventListener('click', async () => {
  const text = $('#outlineBody').innerText;
  await copyText(text);
  toast('已复制');
});

$('#btnOutlineSave').addEventListener('click', async () => {
  if (!state.outline) return;
  const now = Date.now();
  const note = {
    id: db.uid(),
    bookId: state.book.id,
    chapterIndex: state.outline.type === 'chapter' ? state.chapter : 0,
    title: state.outline.type === 'chapter'
      ? `本章脉络 · ${cleanTitle(state.book.chapters[state.chapter].title)}`
      : state.outline.type === 'writing'
        ? `写作借鉴 · ${state.book.title}`
        : state.outline.type === 'checkup'
          ? `稿件体检 · ${state.book.title}`
          : state.outline.type === 'range'
            ? `选段分析 · 第 ${state.outline.rangeA + 1}–${state.outline.rangeB + 1} 章`
            : `全书框架 · ${state.book.title}`,
    body: $('#outlineBody').innerHTML,
    markdown: state.outline.md || '',
    kind: state.outline.type,
    createdAt: now
  };
  await db.putNote(note);
  state.notes.push(note);
  updateBookNoteCount();
  renderNotes();
  toast('已存为笔记');
  $('#outlineMask').hidden = true;
});

/* ══════════════════════ 朗读 ══════════════════════ */
let _speaking = false;

function stopSpeak() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  _speaking = false;
  if ($('#btnSpeak')) $('#btnSpeak').textContent = '读这一章';
}

$('#btnSpeak').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) return toast('这个浏览器不支持朗读');
  if (_speaking) { stopSpeak(); return; }
  if (!state.book) return;

  const ch = state.book.chapters[state.chapter];
  const text = state.content.slice(ch.start, ch.end).replace(/\s+/g, '');
  if (!text.trim()) return;

  const voices = speechSynthesis.getVoices();
  const zh = voices.find(v => /^zh|Chinese/i.test(v.lang) || /Chinese|中文|普通话/i.test(v.name));
  if (!voices.length) return toast('系统里没有可用语音，检查设备的「语音合成」设置');

  const u = new SpeechSynthesisUtterance(text.slice(0, 4200));
  if (zh) u.voice = zh;
  u.lang = zh ? zh.lang : 'zh-CN';
  u.rate = 1;
  u.onend = stopSpeak;
  u.onerror = stopSpeak;

  speechSynthesis.speak(u);
  _speaking = true;
  $('#btnSpeak').textContent = '停止';
  toast(zh ? '开始朗读' : '系统里没有中文语音，可能读不准');
});

/* ══════════════════════ 排版 popover ══════════════════════ */
$('#btnType').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#typePop').hidden = !$('#typePop').hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.aa-wrap')) $('#typePop').hidden = true;
});
$('#typePop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-font]');
  if (b) {
    prefs.size = Math.max(14, Math.min(26, prefs.size + (+b.dataset.font)));
    applyPrefs(); savePrefs();
  }
  const ff = e.target.closest('[data-fontfamily]');
  if (ff) { prefs.family = ff.dataset.fontfamily; applyPrefs(); savePrefs(); }
  const th = e.target.closest('[data-theme]');
  if (th) { prefs.theme = th.dataset.theme; applyPrefs(); savePrefs(); }
});
$('#lineRange').addEventListener('input', (e) => {
  prefs.lh = +e.target.value;
  applyPrefsDebounced(); savePrefs();
});
$('#indentSwitch').addEventListener('click', () => {
  prefs.indent = !prefs.indent;
  applyPrefs(); savePrefs();
  if (state.book) renderReader(state.chapter, { ratio: currentRatio(), silent: true });
});

/* ══════════════════════ 章节切换 ══════════════════════ */
$('#btnPrevChapter').addEventListener('click', () => { if (state.chapter > 0) renderReader(state.chapter - 1); });
$('#btnNextChapter').addEventListener('click', () => {
  if (state.book && state.chapter < state.book.chapters.length - 1) renderReader(state.chapter + 1);
});
$('#btnBackShelf').addEventListener('click', showWelcome);
$('#btnHome').addEventListener('click', showWelcome);
$('#btnInline').addEventListener('click', toggleInline);
$('#btnRangeSelect').addEventListener('click', enterRangeMode);
$('#btnRangeCancel').addEventListener('click', exitRangeMode);
$('#btnRangeGo').addEventListener('click', () => {
  if (rangeSel.a == null || rangeSel.b == null) return;
  const a = rangeSel.a, b = rangeSel.b;
  exitRangeMode();
  showRangeOutline(a, b);
});
$('#btnMobileShelf').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#btnMobileShelf2').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

/* ══════════════════════ 导入 ══════════════════════ */
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#dropzone').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await importFiles(files);
});
$('#btnImportDraft').addEventListener('click', () => $('#fileInputDraft').click());
$('#fileInputDraft').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await importFiles(files, 'draft');
});

function askScanned(file, reason) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal scan-modal';
    box.innerHTML = `
      <div class="modal-head"><strong>这个 PDF 是扫描版</strong>
        <button class="icon-btn small" data-x>✕</button></div>
      <div class="modal-body">
        <p class="scan-file">${escapeHtml(file.name)}</p>
        <p class="scan-reason">${escapeHtml((((reason.match(/（(.+?)）/) || [])[1]) || reason).replace(/[。．.]$/, ''))}。没有文字层，只能靠识别。</p>

        <div class="scan-opt primary">
          <div class="scan-opt-head"><b>用 WPS 转</b><span>最准 · 中文扫描件识别率高得多</span></div>
          <ol class="scan-steps">
            <li>用 WPS 打开这个 PDF</li>
            <li>找「PDF 转 Word」（手机在「工具 → PDF 转换」里）</li>
            <li>把转好的文件选回墨读，章节会自动切</li>
          </ol>
          <button class="btn-ghost" data-act="reselect">我已转好，选择文件</button>
        </div>

        <div class="scan-opt">
          <div class="scan-opt-head"><b>用内置 OCR</b><span>应急，识别率一般</span></div>
          <p class="scan-note">每页 3–8 秒，首次要下载约 15MB 中文模型。字形相近的字会认错，比如「雨」认成「十」。</p>
          <button class="btn-ghost" data-act="ocr">开始识别</button>
        </div>
      </div>
      <div class="modal-foot">
        <span class="outline-hint">识别在本机完成，文件不上传</span>
        <div class="spacer"></div>
        <button class="btn-ghost" data-act="skip">跳过这本</button>
      </div>`;

    mask.appendChild(box);
    document.body.appendChild(mask);

    const done = (v, pick) => {
      mask.remove();
      if (pick) $('#fileInput').click();
      resolve(v);
    };
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) return done('skip');
      const b = e.target.closest('[data-act]');
      if (!b) return;
      done(b.dataset.act, b.dataset.act === 'reselect');
    });
    mask.addEventListener('click', (e) => { if (e.target === mask) done('skip'); });
  });
}

async function importFiles(files, kind = 'book') {
  if (!files.length) return;
  const box = $('#importing');
  box.hidden = false;
  let ok = 0;

  for (const file of files) {
    $('#importingTitle').textContent = `正在解析《${file.name}》`;
    $('#importingSub').textContent = '文件只在本地处理，不会上传';
    try {
      let parsed;
      try {
        parsed = await parseFile(file, (p, i, total) => {
          $('#importingSub').textContent = `读取 PDF 第 ${i}/${total} 页`;
        });
      } catch (err) {
        if (err.code !== 'SCANNED') throw err;
        const choice = await askScanned(file, err.message);
        if (choice !== 'ocr') {
          box.hidden = true;
          err.silent = true;
          throw err;
        }

        $('#importingTitle').textContent = '正在 OCR 识别…';
        $('#importingSub').textContent = '首次需要下载中文模型（约 15MB）';
        const text = await Promise.race([
          ocrPdf(file, (p) => {
            if (p.message) {
              $('#importingSub').textContent = p.message + (p.progress ? `（${Math.round(p.progress * 100)}%）` : '');
            }
          }),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('OCR 超时（90 秒）。多半是中文模型下载太慢，建议改用 WPS / 白描 / 微信「提取文字」转成 TXT 再导入。')),
            90000
          ))
        ]);
        if (!text.trim()) throw new Error('OCR 没有识别出文字，建议改用 WPS / 白描转换。');
        parsed = {
          title: file.name.replace(/\.[^.]+$/, ''),
          author: '',
          format: 'pdf',
          content: text,
          chapters: splitChapters(text),
          charCount: text.length
        };
      }

      const book = {
        id: db.uid(),
        kind,
        title: parsed.title,
        author: parsed.author,
        format: parsed.format,
        size: file.size,
        addedAt: Date.now(),
        lastReadAt: Date.now(),
        charCount: parsed.charCount,
        chapters: parsed.chapters.map(c => ({ title: c.title, start: c.start, end: c.end, auto: c.auto, lead: c.lead })),
        progress: { chapter: 0, ratio: 0, percent: 0 }
      };
      await db.putText(book.id, parsed.content);
      await db.putBook(book);
      ok++;
    } catch (err) {
      console.error(err);
      if (!err.silent) alert(`《${file.name}》导入失败：\n${err.message}`);
    }
  }

  box.hidden = true;
  await loadBooks();
  if (ok) {
    toast(`已导入 ${ok} 本书`);
    const newest = state.books[0];
    if (newest) await openBook(newest.id);
  }
}

/* 拖拽 */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await importFiles(files);
});

/* ══════════════════════ 设置 ══════════════════════ */
function openSettings() {
  const s = ai.getAI();
  $('#aiBase').value = s.base || '';
  $('#aiModel').value = s.model || '';
  $('#aiKey').value = s.key || '';
  $('#aiPriceIn').value = s.priceIn ?? 2;
  $('#aiPriceOut').value = s.priceOut ?? 8;
  $('#settingsMask').hidden = false;
  updateStorageLine();
  renderUsageBox();
}
$('#btnSettings').addEventListener('click', openSettings);

/* ══════════ 拆书库 ══════════ */
function libCardHTML(r) {
  return `<div class="lib-card" data-lib-id="${r.id}">
    <div class="lib-head">
      <b>${escapeHtml(r.title)}</b>
      <span>${fmtDate(r.at)}</span>
    </div>
    ${r.core ? `<p class="lib-core">${escapeHtml(r.core)}</p>` : ''}
    ${r.verdict ? `<p class="lib-verdict">${escapeHtml(r.verdict)}</p>` : ''}
    ${r.copy && r.copy.length ? `<ul class="lib-mini">${r.copy.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
    <div class="lib-acts">
      <button class="mini-btn" data-lib-open="${r.id}">打开拆书</button>
      <button class="mini-btn danger" data-lib-del="${r.id}">删除</button>
    </div>
  </div>`;
}

async function renderLibrary(q) {
  const list = $('#libraryList');
  const reports = await db.listReports();
  const qs = (q || '').trim().toLowerCase();
  const filtered = qs
    ? reports.filter(r => (r.title + ' ' + (r.core || '') + ' ' + (r.verdict || '') + ' ' + (r.copy || []).join(' ')).toLowerCase().includes(qs))
    : reports;
  if (!filtered.length) {
    list.innerHTML = '<p class="ck-hint">还没有拆过的书。打开一本书，点「拆书」后会自动进库。</p>';
    return;
  }
  list.innerHTML = filtered.map(libCardHTML).join('');
}

async function openLibrary() {
  $('#libraryMask').hidden = false;
  $('#librarySearch').value = '';
  await renderLibrary('');
}

$('#btnLibrary').addEventListener('click', openLibrary);
$('#libraryClose').addEventListener('click', () => { $('#libraryMask').hidden = true; });
$('#libraryMask').addEventListener('click', (e) => { if (e.target.id === 'libraryMask') $('#libraryMask').hidden = true; });
$('#librarySearch').addEventListener('input', debounce((e) => renderLibrary(e.target.value), 200));

$('#libraryList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-lib-open]');
  if (open) {
    $('#libraryMask').hidden = true;
    const id = open.dataset.libOpen;
    const book = state.books.find(b => b.id === id) || await db.getBook(id);
    if (!book) { toast('这本书已从书架移除'); return; }
    await openBook(id);
    showOutline('book');
    return;
  }
  const del = e.target.closest('[data-lib-del]');
  if (del) {
    await db.deleteReport(del.dataset.libDel);
    toast('已从拆书库删除');
    renderLibrary($('#librarySearch').value);
  }
});

$('#settingsClose').addEventListener('click', closeSettings);
$('#settingsMask').addEventListener('click', (e) => { if (e.target.id === 'settingsMask') closeSettings(); });
function closeSettings() {
  const s = ai.getAI();
  s.base = $('#aiBase').value.trim();
  s.model = $('#aiModel').value.trim();
  s.key = $('#aiKey').value.trim();
  s.priceIn = Number($('#aiPriceIn').value) || 0;
  s.priceOut = Number($('#aiPriceOut').value) || 0;
  s.enabled = ai.aiReady();
  ai.setAI(s);
  document.body.classList.toggle('ai-on', ai.aiReady());
  $('#chatHint').textContent = ai.aiReady()
    ? '已接入 ' + (s.model || '') + ' · 回答会标注原文出处'
    : '本地模式：可定位、检索、看框架。接入大模型后可深度解释。';
  $('#settingsMask').hidden = true;
}

$('#aiPreset').addEventListener('change', (e) => {
  const p = ai.PRESETS[e.target.value];
  if (p) {
    $('#aiBase').value = p.base;
    $('#aiModel').value = p.model;
    $('#aiPriceIn').value = p.priceIn;
    $('#aiPriceOut').value = p.priceOut;
  }
});

$('#btnTestAI').addEventListener('click', async () => {
  const s = ai.getAI();
  ai.setAI({
    ...s,
    base: $('#aiBase').value.trim(),
    model: $('#aiModel').value.trim(),
    key: $('#aiKey').value.trim(),
    priceIn: Number($('#aiPriceIn').value) || 0,
    priceOut: Number($('#aiPriceOut').value) || 0
  });
  const st = $('#aiStatus');
  st.className = 'ai-status';
  st.textContent = '测试中…';
  try {
    const r = await ai.testAI();
    st.className = 'ai-status ok';
    st.textContent = '连接成功 · ' + r.slice(0, 20);
    document.body.classList.add('ai-on');
  } catch (err) {
    st.className = 'ai-status err';
    st.textContent = err.message;
  }
});

async function updateStorageLine() {
  const est = await db.estimateStorage();
  if (!est) return;
  const used = (est.usage / 1048576).toFixed(1);
  const quota = (est.quota / 1073741824).toFixed(1);
  $('#storageLine').textContent = `本地已用 ${used} MB · 可用约 ${quota} GB · ${state.books.length} 本书`;
}

/* 备份 */
$('#btnExportAll').addEventListener('click', async () => {
  const data = await db.exportAll();
  const json = JSON.stringify(data);
  if (IS_APP) {
    showTextModal('备份（复制后粘贴保存为 .json）', json);
    return;
  }
  download(`墨读备份-${dateStamp()}.json`, json, 'application/json');
  toast('备份已导出');
});
$('#btnImportAll').addEventListener('click', () => $('#backupInput').click());
$('#backupInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const cnt = (data && data.books) ? data.books.length : 0;
    const at = (data && data.exportedAt) ? new Date(data.exportedAt).toLocaleString() : '未知时间';
    if (!confirm(`即将导入备份（导出时间：${at}，含 ${cnt} 本书）。\n\n导入为“合并覆盖”：与现有内容同名的会被备份版本覆盖，你现有的其他数据不会被删除。\n\n确定继续？`)) return;
    const n = await db.importAll(data);
    await loadBooks();
    toast(`已恢复 ${n} 本书`);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
});
$('#btnResetUsage').addEventListener('click', () => {
  localStorage.removeItem(USAGE_KEY);
  session = { cost: 0, tokens: 0, count: 0 };
  updateUsageUI();
  renderUsageBox();
  toast('统计已清零');
});

$('#btnClearAll').addEventListener('click', async () => {
  if (!confirm('清空所有书籍、标记和笔记？此操作无法撤销，建议先导出备份。')) return;
  await db.clearAll();
  await db.setKV('lastBook', null);
  state.book = null;
  showWelcome();
  await loadBooks();
  toast('已清空');
});

/* ══════════════════════ 导出笔记 ══════════════════════ */
$('#btnExportNotes').addEventListener('click', () => exportNotes());

async function exportNotes() {
  if (!state.book) return;
  const b = state.book;
  const lines = [];
  lines.push(`# 《${b.title}》读书笔记`);
  lines.push('');
  lines.push(`> ${[b.author, `${b.chapters.length} 章`, `${(b.charCount / 10000).toFixed(1)} 万字`].filter(Boolean).join(' · ')}`);
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  const items = [];
  for (const m of state.marks) items.push({ ch: chapterAt(m.start).index, at: m.start, m });
  items.sort((a, b2) => a.ch - b2.ch || a.at - b2.at);

  let lastCh = -1;
  for (const it of items) {
    if (it.ch !== lastCh) {
      lastCh = it.ch;
      lines.push(`## ${cleanTitle(b.chapters[lastCh]?.title || '')}`);
      lines.push('');
    }
    const m = it.m;
    lines.push(`> ${m.text.replace(/\n/g, ' ')}`);
    lines.push('');
    if (m.note) { lines.push(`**笔记**：${m.note}`); lines.push(''); }
    lines.push(`<sub>${new Date(m.createdAt).toLocaleString('zh-CN')} · ${m.note ? '笔记' : '标记'}</sub>`);
    lines.push('');
  }

  const bookNotes = state.notes.filter(n => n.kind !== 'chapter');
  if (bookNotes.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 整段笔记');
    lines.push('');
    for (const n of bookNotes) {
      lines.push(`### ${n.title}`);
      lines.push('');
      const tmp = document.createElement('div');
      tmp.innerHTML = n.body || '';
      lines.push(tmp.innerText.trim());
      lines.push('');
    }
  }

  const md = lines.join('\n');
  await deliverText(`《${b.title}》笔记-${dateStamp()}.md`, md);
  if (!IS_APP) {
    await copyText(md);
    toast('已导出 Markdown，并复制到剪贴板');
  }
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/* ══════════════════════ 工具 ══════════════════════ */
const IS_APP = location.hostname === 'app.local';

/** 网页版：直接下载；鸿蒙 App 内：弹窗复制（ArkWeb 不处理 a[download]） */
async function deliverText(filename, text, type = 'text/markdown') {
  if (IS_APP) {
    showTextModal(filename, text);
    return;
  }
  download(filename, text, type);
}

function showTextModal(title, text) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = document.createElement('div');
  modal.className = 'modal modal-wide';
  modal.innerHTML = `<div class="modal-head"><strong></strong>
      <button class="icon-btn small" data-close>✕</button></div>
    <div class="modal-body"><textarea class="export-text" readonly></textarea></div>
    <div class="modal-foot"><span class="outline-hint">长按全选，粘贴到备忘录或文件 App</span>
      <div class="spacer"></div><button class="btn-primary" data-copy>复制全文</button></div>`;
  modal.querySelector('strong').textContent = title;
  const ta = modal.querySelector('.export-text');
  ta.value = text;
  mask.appendChild(modal);
  document.body.appendChild(mask);

  const close = () => mask.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  modal.querySelector('[data-copy]').addEventListener('click', async () => {
    await copyText(ta.value);
    toast('已复制全文');
  });
  setTimeout(() => { ta.focus(); ta.select(); }, 80);
}

function download(filename, text, type = 'text/markdown') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ══════════════════════ 键盘 ══════════════════════ */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  if (e.key === 'Escape') {
    if (!$('#noteMask').hidden) return closeNoteModal();
    if (!$('#settingsMask').hidden) return closeSettings();
    if (!$('#outlineMask').hidden) return $('#outlineMask').hidden = true;
    if (!$('#panel').hidden) return closePanel();
    $('#selToolbar').hidden = true;
  }
  if (typing) return;

  if (e.key === '/') { e.preventDefault(); openPanel('search'); }
  if (e.key === 'ArrowRight' && state.book && !e.metaKey && !e.ctrlKey) {
    if (state.chapter < state.book.chapters.length - 1) renderReader(state.chapter + 1);
  }
  if (e.key === 'ArrowLeft' && state.book && !e.metaKey && !e.ctrlKey) {
    if (state.chapter > 0) renderReader(state.chapter - 1);
  }
});

/* 帮助 */
$('#btnHelp').addEventListener('click', () => {
  showOutlineHTML('使用说明', ai.mdToHtml(`
### 三步开始
1. 点左上「导入书籍」，或把文件拖进窗口
2. 左侧点书名开始读
3. 选中任意文字 → 高亮 / 写笔记 / 问解释

### 对话式定位
在「读书助手」里直接说人话：
- 「读第三回」→ 跳到该章并给出开头文段
- 「下一章」「回到开头」
- 「黛玉进贾府」→ 全书检索并列出上下文

### 标记与笔记
- 五种颜色，点击任意高亮可再次编辑
- 「笔记」面板按章节汇总，可导出 Markdown
- 标记与笔记都存在本机浏览器里

### 大模型（可选）
设置 → 填接口地址、模型名、API Key。
不填也能用，只是解释会退化成「文本内证据」。

### 快捷键
\`/\` 检索　\`←\` \`→\` 上下章　\`Esc\` 关闭面板
`), '', null);
});

/* 点击别处关闭文内批注气泡 */
document.addEventListener('click', (e) => {
  if (inlineTip && !e.target.closest('.inline-tip') && !e.target.closest('.in-note, .inline-chip')) hideInlineTip();
});

/* 点击侧栏外部关闭（移动端） */
document.addEventListener('click', (e) => {
  const sb = $('#sidebar');
  if (!sb.classList.contains('open')) return;
  if (e.target.closest('#sidebar') || e.target.closest('#btnMobileShelf') || e.target.closest('#btnMobileShelf2')) return;
  sb.classList.remove('open');
});

/* 移动端：引导添加到主屏幕 */
function maybeInstallTip() {
  const ua = navigator.userAgent;
  if (window.innerWidth > 900) return;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isHarmony = /HarmonyOS|OpenHarmony|ArkWeb|HuaweiBrowser/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  if (!isIOS && !isAndroid && !isHarmony) return;
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return;
  if (localStorage.getItem('modu.installTip') === 'off') return;

  let tip = '点浏览器右上角菜单 →「添加到主屏幕」';
  if (isIOS) {
    tip = '点 Safari 底部的「分享」→「添加到主屏幕」';
  } else if (isHarmony) {
    tip = '点浏览器右下角菜单 →「添加到桌面」';
  }

  const bar = document.createElement('div');
  bar.className = 'install-tip';
  bar.innerHTML = `<div class="install-tip-text"><strong>装到桌面，像 App 一样用</strong><span>${tip}</span></div>
    <button id="installTipClose">知道了</button>`;
  document.body.appendChild(bar);

  const dismiss = () => {
    localStorage.setItem('modu.installTip', 'off');
    clearTimeout(timer);
    bar.remove();
  };
  // 7 秒后自动收起，不长期挡住底部操作
  const timer = setTimeout(dismiss, 7000);
  $('#installTipClose').addEventListener('click', dismiss);
}

/* 启动 */
init().then(maybeInstallTip).catch(err => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:60px;font-family:serif;line-height:2">
    <h2>墨读启动失败</h2><p>${escapeHtml(err.message)}</p>
    <p style="color:#888;font-size:13px">请通过启动脚本打开（python3 server.py），不要直接双击 index.html。</p>
  </div>`;
});

/* 注册 Service Worker：离线也能打开，且联网时始终取最新版本 */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
