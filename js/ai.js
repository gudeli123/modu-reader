/* 大模型接入 + 本地分析
 * 职责：① 设置与预设（PRESETS）② askAI/continueAI 统一调用（超时 + 重试 + 流式）
 *       ③ 用量与费用统计 ④ 各能力提示词 promptXxx ⑤ 纯本地规则引擎（人名/情绪/水章/钩子/段落分类等）。
 * 约定：全部走 OpenAI 兼容协议；Key 仅存本机 localStorage；未配置模型时降级为本地算法。
 * 改动指引：分析规则 / 提示词 / 输出格式 → 本文件。
 */
import { topWords, escapeHtml, excerpt } from './parse.js';

/* ══════════ 设置 ══════════ */
const SET_KEY = 'modu.ai.settings';
const DEF = { base: '', key: '', model: '', enabled: false, priceIn: 2, priceOut: 8 };

export function getAI() {
  try {
    const s = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
    return { ...DEF, ...s };
  } catch { return { ...DEF }; }
}
export function setAI(s) { localStorage.setItem(SET_KEY, JSON.stringify(s)); }
export const aiReady = () => {
  const s = getAI();
  return !!(s.base && s.model && s.key);
};

export const PRESETS = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', priceIn: 2, priceOut: 8 },
  kimi: { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', priceIn: 12, priceOut: 12 },
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', priceIn: 0, priceOut: 0 },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', priceIn: 0.8, priceOut: 2 },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', priceIn: 1.1, priceOut: 4.4 }
};

/* ══════════ 用量统计 ══════════ */
let _usageCb = null;
let _progressCb = null;
let _truncated = false;
export const wasTruncated = () => _truncated;
export function onUsage(fn) { _usageCb = fn; }
export function onProgress(fn) { _progressCb = fn; }
function emitProgress(p) { if (_progressCb) _progressCb(p); }

function costOf(usage) {
  const s = getAI();
  const pin = Number(s.priceIn) || 0;
  const pout = Number(s.priceOut) || 0;
  return (usage.prompt_tokens || 0) / 1e6 * pin + (usage.completion_tokens || 0) / 1e6 * pout;
}

function reportUsage(usage) {
  if (!usage || !_usageCb) return;
  _usageCb({
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
    cost: costOf(usage),
    model: getAI().model,
    at: Date.now()
  });
}

/* ══════════ 本地代理探测（解决浏览器跨域） ══════════ */
let proxyOK = false;
export async function probeProxy() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    proxyOK = r.ok;
  } catch { proxyOK = false; }
  return proxyOK;
}
export const hasProxy = () => proxyOK;

/* ══════════ 请求超时与重试 ══════════ */
const DEFAULT_TIMEOUT = 90000; // 90s：覆盖连接与首个响应头；流式正文不受此限制
const MAX_RETRY = 2;           // 网络错误 / 429 / 5xx 自动重试次数

function linkAbort(external, ctrl) {
  if (!external) return () => {};
  if (external.aborted) ctrl.abort();
  const onAbort = () => ctrl.abort();
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const unlink = linkAbort(opts.signal, ctrl);
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

const RETRIABLE_STATUS = [408, 429, 500, 502, 503, 504];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════ 调用 ══════════ */
export async function askAI(messages, { onDelta, signal, temperature = 0.65, maxTokens = 1600 } = {}) {
  const s = getAI();
  if (!s.base || !s.model) throw new Error('尚未配置大模型');

  const body = { model: s.model, messages, temperature, max_tokens: maxTokens, stream: !!onDelta };
  if (onDelta) body.stream_options = { include_usage: true };

  _truncated = false;
  const promptChars = messages.reduce((a, m) => a + (m.content || '').length, 0);
  const estPrompt = Math.round(promptChars * 0.75);
  emitProgress({ phase: 'start', promptTokens: estPrompt, outputTokens: 0 });
  const headers = { 'Content-Type': 'application/json' };
  if (s.key) headers['Authorization'] = `Bearer ${s.key}`;

  let url = s.base.replace(/\/+$/, '') + '/chat/completions';
  if (proxyOK) {
    url = '/api/llm';
    body._target = s.base.replace(/\/+$/, '');
    body._key = s.key || '';
  }

  const opts = { method: 'POST', headers, body: JSON.stringify(body), signal };
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchWithTimeout(url, opts, DEFAULT_TIMEOUT);
      if (!res.ok && RETRIABLE_STATUS.includes(res.status) && attempt < MAX_RETRY) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      break;
    } catch (err) {
      if (attempt < MAX_RETRY && !signal?.aborted) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error(/超时|abort/i.test(`${err?.name} ${err?.message || ''}`) ? '请求超时或已取消，请重试' : (err?.message || '网络错误'));
    }
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const t = await res.text();
      const j = JSON.parse(t);
      msg = j.error?.message || j.message || msg;
    } catch { }
    if (res.status === 401) msg = '鉴权失败：请检查 API Key';
    if (res.status === 404) msg = '接口地址或模型名不正确（404）';
    throw new Error(msg);
  }

  const ct = res.headers.get('content-type') || '';
  if (!onDelta || ct.includes('application/json')) {
    const j = await res.json();
    reportUsage(j.usage);
    if (j.choices?.[0]?.finish_reason === 'length') _truncated = true;
    return j.choices?.[0]?.message?.content || '';
  }

  // 流式
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { reportUsage(usage); return full; }
      try {
        const j = JSON.parse(data);
        if (j.usage) usage = j.usage;
        if (j.choices?.[0]?.finish_reason === 'length') _truncated = true;
        const d = j.choices?.[0]?.delta?.content || '';
        if (d) {
          full += d;
          onDelta(d);
          emitProgress({ phase: 'stream', promptTokens: estPrompt, outputTokens: Math.round(full.length * 0.75) });
        }
      } catch { }
    }
  }
  reportUsage(usage);
  return full;
}

/**
 * 断点续写：把已生成的部分作为 assistant 消息放回对话，让模型接着写。
 * 关键是告诉它"断在哪"，否则它会从头再讲一遍。
 */
export async function continueAI(prevMessages, prevText, { onDelta, maxTokens = 2000 } = {}) {
  const tail = prevText.slice(-160).replace(/\s+/g, ' ').trim();
  const messages = [
    ...prevMessages,
    { role: 'assistant', content: prevText },
    {
      role: 'user',
      content: `上面这条回复因为长度限制被截断了，最后停在这句：\n「${tail}」\n\n请紧接着这句继续写：不要重复已有内容，不要加"接着上文""继续"之类的过渡语，不要重新开头，直接续写。`
    }
  ];
  return askAI(messages, { onDelta, maxTokens });
}

export async function testAI() {
  const txt = await askAI(
    [{ role: 'system', content: '只回答两个字：可用' }, { role: 'user', content: '测试' }],
    { temperature: 0, maxTokens: 8 }
  );
  return txt.trim();
}

/* ══════════ Prompt ══════════ */
const SYS = `你是一位博学、克制的经典文学导读老师，熟悉中国古典文学、世界文学与叙事学。
要求：
1. 只依据给出的原文作答，不编造原文中没有的情节、人物关系或版本信息。
2. 讲人话，避免空泛的文学套话（如"深刻反映了……"）。
3. 观点要落到具体的字词、句式、结构上，能指出来是哪一句在起作用。
4. 不确定处直接说"这一点从现有文本看不出来"。
5. 用简体中文，短段落，可用少量要点。`;

function bookMeta(book) {
  return `《${book.title}》${book.author ? ' · ' + book.author : ''}，共 ${book.chapters.length} 章，约 ${Math.round(book.charCount / 10000)} 万字。`;
}

/* 解释一段文字 */
export function promptExplain(book, chapterTitle, selected, context) {
  return [
    { role: 'system', content: SYS },
    {
      role: 'user', content: `我在读${bookMeta(book)}
当前章节：${chapterTitle}

【选中的原文】
${selected}

【上下文】
${context}

请解释这段文字。分四小块，每块 2-4 句，直接给内容不要标题编号之外的客套：
一、字面意思（把难懂的词、句式、典故讲清楚）
二、上下文作用（这段在情节/论述中承了什么、转了什么）
三、写法与意味（用词、节奏、意象、叙述视角等，指出具体字词）
四、一句总结（不超过 40 字）`
    }
  ];
}

/* 章节脉络 */
export function promptChapter(book, chapter, text, isAI) {
  return [
    { role: 'system', content: SYS + '\n7. 你现在是网络小说主编，用连载的标准看这一章。' },
    {
      role: 'user', content: `我在读${bookMeta(book)}
当前章节：${chapter.title}

【本章原文（节选）】
${text.slice(0, 11000)}

请按**网文单章**的标准拆这一章，用 Markdown：

### 这一章在连载里干了什么
一句话说明它的任务：立人设 / 推进主线 / 给爽点 / 埋伏笔 / 过渡。只能选一个主要的。

### 按单章结构拆
- **开场钩**：前 300 字做了什么，能不能拉住刚点进来的人
- **推进**：这一章的目标是什么，谁在挡
- **转折**：局面在哪里翻了一次
- **收束**：结尾留的钩子是什么，读者会不会点下一章

### 爽点与压抑
这一章给了什么情绪释放（打脸/揭秘/获得/情感确认）？有没有压抑段？比例如何。

### 如果这一章是你写的
按它的骨架，给出一个可执行的改法：开头怎么改、哪一段该删、结尾怎么留钩。

### 一个可以搬的动作
这一章有什么写法能直接用到你的连载里，具体到句子层面。`
    }
  ];
}

/* 全书框架 */
export function promptBook(book, digest, stats, fit) {
  const f = fit || {};
  return [
    { role: 'system', content: SYS + '\n7. 你现在的身份是网络小说主编，熟悉起点、番茄、七猫的签约与留存标准。分析结构时要能直接说"这个设计在连载里会掉读者"。' },
    {
      role: 'user', content: `我在读${bookMeta(book)}，想把它当**结构教材**，但我的目标是写网络小说。

【机器测出的结构数据】
- 共 ${book.chapters.length} 章，平均每章 ${f.avg || '?'} 字
- 第一章约第 ${f.dlg >= 0 ? Math.round(f.dlg / 100) * 100 : '?'} 字出现第一句对话，第一个转折约在第 ${f.turn >= 0 ? Math.round(f.turn / 100) * 100 : '?'} 字
- 对话段落占比 ${stats.dialoguePct}%，平均句长 ${stats.avg} 字
- ${f.vols >= 2 ? '有 ' + f.vols + ' 个卷/部标记' : '没有明显的分卷'}

【全书章节与各章开头】
${digest}

请完全站在**网络小说连载**的角度分析，不要写成文学赏析，也不要写成书评。严格按下面的顺序和标题输出 Markdown，标题名不要改，不要输出这几个标题以外的任何段落。

### 核心梗
一句话：（40 字以内。必须同时含"开始、转折、结束"三样，只写人和事，不要评价、不要形容词堆砌）
开始：（一句话，交代主角原本的处境）
转折：（一句话，说清是什么把他推到另一条路上）
结束：（一句话，说清终局他成了什么）

### 结构层级
用表格给，3–8 行。原书没有分卷，你替它切；切法按"卷末主角状态发生不可逆变化"来定。

| 卷 | 起止章 | 主角拿到什么 | 主角失去什么 | 卷末的不可逆变化 |
| --- | --- | --- | --- | --- |
| 一 | 1–25 | … | … | … |

### 一句话判断
这本书能不能当模板、适合哪个赛道。一句话，不超过 30 字，能或不能都要说清原因。

### 三个必须改的地方
只挑最会掉读者的三个，每个一行，严格用这个格式（用｜分隔，一句话说清怎么改）：
1. 第 X 章｜问题｜怎么改

### 三个可以直接抄的动作
只挑能从这本书搬到你自己书里的三个，每个一行，严格用这个格式：
1. 做法｜在这本书第几章｜怎么用到你的书里

不要写"如何""建议""注意"式的教学段落，不要总结。`
    }
  ];
}

/* 自由问答 */
export function promptChat(book, question, passages, chapterTitle, history = []) {
  const ctx = passages.length
    ? passages.map((p, i) => `【片段${i + 1} · ${p.chapter}】\n${p.text}`).join('\n\n')
    : '（未检索到直接相关的原文片段）';
  const hist = (history || [])
    .filter(m => m && m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1200) }));
  return [
    { role: 'system', content: SYS + `\n6. 回答尽量引用原文，引用时用 > 标出，并注明章节。\n7. 若上文对话与当前问题相关，请自然衔接，不要重复已说过的内容；若当前问题依赖上一轮，直接接着答。` },
    ...hist,
    {
      role: 'user', content: `我在读${bookMeta(book)}${chapterTitle ? `，当前在「${chapterTitle}」` : ''}。

【书中检索到的相关原文】
${ctx}

【我的问题】
${question}

请回答。若原文不足以支撑，明确说明，并基于文学常识谨慎补充（要标明哪部分是推测）。`
    }
  ];
}

/* ══════════ Markdown 渲染 ══════════ */
export function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r/g, '').split('\n');
  let html = '';
  let listType = null;
  let inQuote = false;
  let inCode = false;
  let codeBuf = [];

  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };
  const flushCode = () => {
    if (inCode) {
      html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
      inCode = false; codeBuf = [];
    }
  };

  // 只放行安全协议，避免 javascript:/data: 之类注入
  const safeHref = (u) => (/^(https?:|mailto:|\/|\.{0,2}\/|#)/i.test(String(u).trim()) ? String(u).trim() : '#');
  const inline = (s) => {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, href) =>
      `<a href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    return t;
  };

  // 表格：以 | 开头结尾的行 + 下一行是 |---| 分隔行
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /\|/.test(l) && /-/.test(l) && /^[\s:|-]+$/.test(l.trim());
  const TD = 'border:1px solid #d8d3c6;padding:6px 9px;vertical-align:top';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // 代码围栏 ``` … ```
    if (/^\s*```/.test(line)) {
      if (inCode) flushCode(); else { closeList(); closeQuote(); inCode = true; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    if (!line.trim()) { closeList(); closeQuote(); continue; }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList(); closeQuote();
      const head = cells(line);
      i++; // 跳过分隔行
      const body = [];
      while (i + 1 < lines.length && isTableRow(lines[i + 1].replace(/\s+$/, ''))) {
        i++;
        body.push(cells(lines[i].replace(/\s+$/, '')));
      }
      html += '<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:14px"><thead><tr>' +
        head.map((h) => `<th style="${TD};background:#f3efe4;text-align:left">${inline(h)}</th>`).join('') +
        '</tr></thead><tbody>';
      for (const r of body) {
        html += '<tr>' + head.map((_, c) => `<td style="${TD}">${inline(r[c] == null ? '' : r[c])}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList(); closeQuote();
      const lv = Math.min(h[1].length + 1, 4);
      html += `<h${lv}>${inline(h[2])}</h${lv}>`;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += `<p>${inline(line.replace(/^>\s?/, ''))}</p>`;
      continue;
    } else closeQuote();

    const ul = line.match(/^[-*·•]\s+(.*)$/);
    const ol = line.match(/^(\d+)[.、)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
      html += `<li>${inline((ul || ol)[ul ? 1 : 2])}</li>`;
      continue;
    }
    closeList();

    if (/^[-—*_]{3,}$/.test(line.trim())) { html += '<hr>'; continue; }
    html += `<p>${inline(line)}</p>`;
  }

  flushCode();
  closeList(); closeQuote();
  return html;
}

/* ══════════ 一键标记：自动挑出「可借鉴写作」的文段 ══════════ */
export const TAG_COLORS = { portrait: 'yellow', scene: 'blue', action: 'green', mood: 'pink', dialog: 'purple' };
export const TAG_NAMES = { portrait: '人物', scene: '环境', action: '动作', mood: '神态心理', dialog: '对话衔接' };

/** AI 版一键标记：让模型挑出可借鉴句子并按类别归类（只出 JSON，不改正文） */
export function promptAutoTag(book, chapter, text) {
  return [
    { role: 'system', content: SYS + '\n7. 你现在是网文写作教练，专门帮作者从范文里挑出可以直接借鉴的句子。只输出 JSON。' },
    {
      role: 'user', content: `我在读${bookMeta(book)}
当前章节：${chapter.title}

【本章原文】
${text.slice(0, 11000)}

请从这一章里挑出**最值得借鉴写作手法**的句子（必须是原文原句，不要改写），按下面 5 类归类，每类最多 4 句：
- portrait（人物：外貌 / 衣着 / 形象）
- scene（环境：场景 / 氛围 / 感官）
- action（动作：有画面感的动作）
- mood（神态心理：情绪 / 心理 / 神态）
- dialog（对话衔接：对话句，或"话说/却说/只见/于是"等过渡转场）

**只输出一个 JSON 数组，不要任何解释，不要 Markdown 代码块**，例如：
[{"kind":"scene","quote":"原文句子…"},{"kind":"action","quote":"…"}]

要求：quote 与原文**逐字一致**，长度 8–80 字，不要跨段拼接；宁缺毋滥，不要凑数。` }
  ];
}

/** 解析模型返回的 JSON（带代码块 / 多余文字兜底） */
export function parseAutoTag(reply) {
  if (!reply) return [];
  let s = String(reply).trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < 0 || b < a) return [];
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.quote !== 'string') continue;
    const kind = String(it.kind || '').trim();
    if (!TAG_COLORS[kind]) continue;
    const quote = it.quote.trim();
    if (quote.length < 4) continue;
    out.push({ kind, color: TAG_COLORS[kind], quote });
  }
  return out;
}

const TAG_WORDS = {
  portrait: ['眉', '眼', '眸', '脸', '脸颊', '唇', '鬓', '发髻', '身材', '姿', '容貌', '神色', '仪态', '衣', '袍', '衫', '裙', '袄', '冠', '巾', '面貌', '容颜', '面庞', '腮', '颈', '手指', '眉目', '眉眼', '目光', '五官'],
  scene: ['天', '云', '月', '日', '星', '风', '雨', '雪', '霜', '露', '山', '河水', '江', '湖', '海', '树林', '花', '草', '街', '巷', '屋', '院', '窗', '门', '灯', '光影', '夜色', '暮色', '晨', '雾', '烟', '炉', '帐', '檐', '庭院', '廊', '桥', '舟', '马', '鸟', '月色', '风声', '气息'],
  action: ['走', '跑', '奔', '跳', '跃', '扑', '抓', '握', '推', '拉', '抬', '低', '回', '转', '掠', '闪', '踉跄', '起身', '坐下', '点头', '摇头', '摆手', '伸手', '转身', '皱眉', '抿嘴', '咬', '掷', '挥', '掀', '拽', '扶', '搀', '跪', '拂', '拾', '递'],
  mood: ['笑', '哭', '怒', '喜', '悲', '惊', '慌', '惧', '羞', '恼', '怔', '愣', '诧', '暗想', '心中', '心头', '心神', '疑惑', '酸', '涩', '暖意', '寒意', '叹', '沉默', '沉吟', '踌躇', '犹豫', '忐忑', '怅然', '莞尔', '苦笑', '冷笑'],
  dialog: ['说道', '问道', '答道', '笑道', '喊道', '叫道', '喝', '嘟囔', '应道', '开口', '低声', '高声', '插嘴', '道：', '道:']
};
const TAG_LINK = ['话说', '却说', '只见', '于是', '然而', '不多时', '半晌', '片刻', '良久', '须臾', '俄而', '随即', '紧接着', '转眼', '少顷', '自此', '从此', '谁知', '岂料', '原来'];
const TAG_MAX = { portrait: 3, scene: 3, action: 4, mood: 3, dialog: 4 };

/**
 * 纯本地规则：按句切分，对每句做类别打分，挑出各类别最值得借鉴的句子。
 * 返回 [{ start, end, kind, color, text }]，start/end 为相对传入文本的偏移。
 * 注意：这是启发式信号，会漏会误报（与项目其它本地规则一致）。
 */
function splitSentences(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let j = i, depth = 0;
    while (j < n) {
      const c = text[j];
      if ('“「『'.includes(c)) depth++;
      else if ('”」』'.includes(c)) depth = Math.max(0, depth - 1);
      if (c === '\n') break;
      if ('。！？!?…'.includes(c) && depth === 0) { j++; break; }
      j++;
    }
    const seg = text.slice(i, j);
    if (seg.trim().length >= 6) out.push({ start: i, end: j, text: seg });
    i = j;
    while (i < n && '\n。！？!?…'.includes(text[i])) i++;
    if (out.length > 4000) break;
  }
  return out;
}

export function autoTagChapter(text) {
  const out = [];
  if (!text) return out;
  const sents = splitSentences(text);
  const counts = { portrait: 0, scene: 0, action: 0, mood: 0, dialog: 0 };
  const keys = Object.keys(TAG_WORDS);
  for (const s of sents) {
    const t = s.text;
    const hasQuote = /[“”"「」]/.test(t);
    let best = null, bestScore = 0;
    for (const k of keys) {
      let score = 0;
      for (const w of TAG_WORDS[k]) if (t.includes(w)) score += (w.length >= 2 ? 2 : 1);
      if (k === 'dialog') {
        if (hasQuote) score += 1;
        for (const w of TAG_LINK) if (t.includes(w)) score += 2;
      }
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best && bestScore >= 2 && counts[best] < TAG_MAX[best]) {
      counts[best]++;
      out.push({ start: s.start, end: s.end, kind: best, color: TAG_COLORS[best], text: t.trim() });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/* ══════════ 本地分析 ══════════ */
export function chapterLead(content, c, n = 60) {
  let t = content.slice(c.start, Math.min(c.end, c.start + 2000));
  const nl = t.indexOf('\n');
  const firstLine = (nl > 0 ? t.slice(0, nl) : t).trim();
  const norm = (x) => x.replace(/\s+/g, '');
  if (firstLine && norm(c.title).startsWith(norm(firstLine).slice(0, 10))) {
    t = nl > 0 ? t.slice(nl + 1) : '';
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, n);
}

const ENT_STOP = new Set(('一个 一些 一样 一起 一时 一面 一边 一直 一般 一切 一定 一天 一年 一半 这个 那个 这样 那样 这么 那么 这里 那里 这些 那些 什么 怎么 为什么 如何 多少 哪些 自己 我们 你们 他们 她们 它们 大家 人家 别人 众人 有人 这人 那人 一人 二人 三人 两人 几个 两个 三个 第一 第二 第三 后来 当时 此时 那时 这时 现在 如今 从前 以后 之前 之后 然后 于是 因为 所以 但是 可是 不过 而且 虽然 如果 要是 只要 只有 总是 就是 还是 也是 都是 只是 不是 没有 不能 不会 不要 不用 不敢 不曾 不如 不然 不知 不觉 不得 可以 应该 必须 已经 曾经 正在 将要 忽然 突然 果然 自然 仍然 依然 仍旧 终于 到底 究竟 难道 岂不 何况 况且 并且 或者 以及 甚至 然而 因此 因而 从而 关于 对于 至于 由于 为了 按照 根据 通过 随着 沿着 朝着 自从 直到 除非 除了 无论 不管 即使 哪怕 万一 一旦 凡是 所有 整个 全部 许多 很多 不少 有些 某些 其他 其余 另外 别的 东西 事情 时候 地方 样子 方法 办法 问题 情况 原因 结果 意思 感觉 心里 心中 眼里 脸上 手里 口中 身上 面前 后面 前面 上面 下面 里面 外面 旁边 中间 左右 附近 到处 处处 天天 年年 日日 常常 往往 渐渐 慢慢 悄悄 偷偷 轻轻 默默 静静 匆匆 连忙 急忙 赶紧 立刻 马上 顿时 猛然 陡然 尚且 罢了 而已 似的 等等 之类 之一 之间 之中 之上 之下 之外 以内 以上 以下 以来 的话 来说 而言 看来 想来 原来 本来 原本 简直 几乎 差不多 大约 也许 或许 恐怕 大概 肯定 必定 必然 当然 显然 明明 恰恰 偏偏 正好 刚好 恰好 仅仅 单单 就是 不过 还是 或是 或者 以及 及其 每个 各个 各种 各类 种种 人们 人间 世上 天下 世间 万物 说道 问道 答道 笑道 叫道 知道 当日 念及 日后 今日 明日 昨日 方才 刚才 随后 随即 独自 各自 半日 正在 不知 只见 不觉 一面 一回 两回 三回 众人 众人 当下 此时 彼时 一时 一刻 半晌 多时 少时 旧日 向日 素日 平日 往常 向来 从来 本来 原 本 该 此 那 这 不知 只得 只好 只是 一面 一时 一日 一时 众人 众人都 丫鬟 丫环 婆子 小厮 家人 公差 公人 和尚 道士 神仙 夫人 老爷 太太 姑娘 奶奶 姐姐 妹妹 哥哥 兄弟 父亲 母亲 儿子 女儿 媳妇 女婿 外孙 女儿 女婿 这样 那般 如何 何以 为何 何处 不知 以为 觉得 心中 心上 口中 眼中 手中 身子 脸上 口中 便 就 又 还 只 才 却 也 都 很 更 最 太 不 没 别 再 可 该 应 使 让 被 把 给 对 从 向 往 跟 比 像 似 等 过 着 得 地 之 其 此 该 者 也 矣 焉 哉 呢 吗 吧 啊 呀 哦 嗯 罢了 而已 不成 不见 不得 不可 不能 不曾 不敢 不过 不如 不然').split(/\s+/));

const BAD_HEAD = /^[的了一是在和就不也都又却能才只把被让给对从向往跟比像等过着得地之其此该者也矣焉哉呢吗吧啊呀哦嗯那这而且则因故虽若如似于与及或所]\S/;
const CHAPTER_WORD = /^第[一二三四五六七八九十百零两\d]{1,4}[回章节卷篇部集]$/;
const BAD_TAIL = /[的了一是在和就不也都又却能才只把被让给对从向往跟比像等过着得地之其此该者也矣焉哉呢吗吧啊呀哦嗯所而而且则因故虽若如于与及或去来走笑问答忙上下中里外]$/;
const NUMERAL = /^[一二三四五六七八九十百千万亿两零]{2,}$/;

export function extractEntities(text, book) {
  let body = text;
  if (book && book.chapters) {
    // 把章节标题从统计里剔除，否则标题里的词会污染高频表
    for (const c of book.chapters) {
      if (c.title && c.title.length >= 2) body = body.split(c.title).join(' ');
    }
  }
  const sample = sampleText(body, 400000);
  const chunks = sample.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(' ').filter(s => s.length >= 2);

  const freq = new Map();
  const bump = (w) => freq.set(w, (freq.get(w) || 0) + 1);

  for (const seg of chunks) {
    for (let i = 0; i < seg.length - 1; i++) bump(seg.substr(i, 2));
    for (let i = 0; i < seg.length - 2; i++) bump(seg.substr(i, 3));
  }

  const bad = (w) => {
    if (ENT_STOP.has(w)) return true;
    if (BAD_HEAD.test(w) || BAD_TAIL.test(w)) return true;
    if (/^(.)\1+$/.test(w)) return true;
    if (CHAPTER_WORD.test(w)) return true;
    if (NUMERAL.test(w)) return true;
    return false;
  };

  const cands = [...freq.entries()]
    .filter(([w, c]) => c >= 2 && !bad(w))
    .sort((a, b) => b[1] - a[1]);

  const threes = cands.filter(([w, c]) => w.length === 3 && c >= 2);
  const kept = [];
  for (const [w, c] of cands) {
    if (w.length === 2 && threes.some(([t, tc]) => t.includes(w) && tc >= c * 0.6)) continue;
    kept.push([w, c]);
  }

  const places = kept.filter(([w]) => /(府|城|镇|宫|殿|寺|观|楼|阁|庄|州|县|关|谷|崖|洞|岛|街|巷|园)$/.test(w));
  const people = kept.filter(([w]) => !places.includes(w));

  return { people: people.slice(0, 12), places: places.slice(0, 6) };
}

/* ══════════ 写作维度词表 ══════════
 * 不按题材切，按"写作者能直接拿去用的东西"切。
 * 只收具体词：抽象情绪词（愤怒、悲伤）不进表，因为写进小说本身就是败笔。
 */
const CRAFT = {
  action: {
    name: '动作 · 身体',
    hint: '手怎么动、人怎么挪、东西怎么坏',
    words: [
      '抓住','掐住','攥紧','捏住','扯住','拽住','拎着','按住','推开','掀开','拍了拍','捂住','扼住','揪住','扳住','甩开',
      '递过','接过','扶住','拉住','抱住','挣开','伸手','抬手','掏出','摸出','探进','塞进','收回',
      '转身','回头','后退','退开','冲进','扑过去','蹿出','闪身','翻过','跃起','跌坐','蹲下','站起','跪下','爬起','跑出','走去','逃走',
      '砸在','摔在','撞上','撞开','碾过','崩开','裂开','震得','塌下','踹开','踢开','劈开','砍下','刺进','勒住','拖进','压住','顶住',
      '断了','碎了','裂了','僵住','滑过','陷进','跪倒','瘫坐','掀翻','压弯','扯开'
    ]
  },
  face: {
    name: '神态 · 微表情',
    hint: '瞳孔、喉结、指尖——最省力的情绪外化',
    words: [
      '瞳孔','眼皮','眼底','眼角','目光','眼神','瞥','瞪','眯起','抬眼','垂眼','别开脸','移开视线','盯着','看向',
      '嘴角','牙关','咬牙','抿','咧嘴','张口','闭嘴','扯了扯嘴角',
      '脸色','面色','煞白','涨红','苍白','铁青','发白','发青','红了脸','红了眼','皱眉','眉头','眉心',
      '喉结','下巴','指尖','手指','后颈','脊背','手心','肩膀','耳根','脖子',
      '笑','冷笑','苦笑','哭','眼泪','叹气','摇头','点头','沉默','怔','愣','呆','慌','恼','怒','羞','皱眉'
    ]
  },
  sense: {
    name: '生理 · 感官',
    hint: '让读者跟着身体走，而不是跟着解释走',
    words: [
      '呼吸','屏息','喘息','喘','心跳','心悸','耳鸣','发烫','发凉','发麻','发紧','发软','发抖','颤抖','哆嗦',
      '腿软','头皮','胃里','恶心','眩晕','眼前一黑','喉咙','口干','咽了口','吞了口','僵住','冷汗','冒汗',
      '鸡皮疙瘩','汗毛','泛酸','手心出汗'
    ]
  },
  beat: {
    name: '对话 · 小动作',
    hint: '不写"他说"，用动作接住台词',
    words: [
      '低声','沉声','哑声','轻声','冷声','笑着','咬着牙','顿了一下','顿了顿','没说话','张了张嘴','闭了闭眼',
      '叹了口气','耸了耸肩','抬起头','低下头','转过头','背过身','松开手','按灭','放下杯子','别过头'
    ]
  },
  mood: {
    name: '氛围 · 具体物',
    hint: '靠灯、雨、铁锈定调，不靠形容词',
    words: [
      '灯光','光线','影子','人影','忽明忽暗','一闪','暗下来','死寂','安静','回声','响声','作响',
      '发冷','冰冷','潮湿','霉味','腥味','灰尘','雾气','下雨','雨声','风声','铁锈','空荡',
      '裂缝','水渍','玻璃','水泥','电线','台阶','墙角','天花板','锈','霉'
    ]
  },
  system: {
    name: '设定 · 规则',
    hint: '铺世界观的方式，密度过高会压过人物',
    words: [
      '系统','面板','属性','等级','技能','任务','奖励','积分','兑换','副本','主神','轮回','通关',
      '规则','玩家','队伍','生存','死亡','世界','觉醒','异能','变异','进化','强化','能量','精神',
      '念力','感染','丧尸','末日','废土','芯片','基因','机甲','护盾','数据','程序','排行榜','隐藏'
    ]
  }
};

const WORD2CAT = (() => {
  const m = new Map();
  for (const [k, def] of Object.entries(CRAFT)) {
    for (const w of def.words) if (!m.has(w)) m.set(w, k);
  }
  return m;
})();

export function craftStats(text) {
  const sample = sampleText(text, 300000);
  const cats = {};
  let total = 0;

  for (const [key, def] of Object.entries(CRAFT)) {
    const hits = [];
    for (const w of def.words) {
      let c = 0, i = 0;
      while ((i = sample.indexOf(w, i)) !== -1) { c++; i += w.length; }
      if (c) hits.push([w, c]);
    }
    hits.sort((a, b) => b[1] - a[1]);
    const t = hits.reduce((a, [, c]) => a + c, 0);
    total += t;
    cats[key] = {
      name: def.name,
      hint: def.hint,
      kinds: hits.length,
      pool: def.words.length,
      cover: def.words.length ? hits.length / def.words.length : 0,
      total: t,
      top: hits.slice(0, 4),
      density: sample.length ? t / sample.length * 1000 : 0
    };
  }

  return {
    cats,
    sampleLen: sample.length,
    total,
    density: sample.length ? total / sample.length * 1000 : 0
  };
}

/** 找出"这一类词用得最密"的原句，让作者看到词是怎么用的 */
export function craftSentences(text, n = 3) {
  const sample = sampleText(text, 200000);
  const re = /[^。！？!?…\n]{10,64}[。！？!?…]/g;
  const out = [];
  let m, guard = 0;

  while ((m = re.exec(sample)) !== null && guard++ < 1500) {
    const t = m[0].trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
    if (t.length < 10) continue;

    const seen = new Set();
    const cats = new Set();
    for (const [w, k] of WORD2CAT) {
      if (t.includes(w)) { seen.add(w); cats.add(k); }
    }
    if (seen.size < 2) continue;

    let score = seen.size * 2 + cats.size * 1.5;
    if (t.length >= 16 && t.length <= 40) score += 2;
    if (/[“”"]/.test(t)) score -= 1;
    out.push({ text: t, words: [...seen].slice(0, 6), cats: [...cats], score, pos: m.index });
  }

  out.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedCat = new Set();
  const seenText = new Set();
  for (const x of out) {
    if (seenText.has(x.text)) continue;
    const sig = x.cats.slice(0, 2).join('+');
    if (usedCat.has(sig) && picked.length >= 2) continue;
    usedCat.add(sig);
    seenText.add(x.text);
    picked.push(x);
    if (picked.length >= n) break;
  }
  picked.sort((a, b) => a.pos - b.pos);
  if (picked.length) return picked;

  // 兜底：命中 1 个写作词的句子
  const loose = [];
  re.lastIndex = 0;
  let k, g2 = 0;
  while ((k = re.exec(sample)) !== null && g2++ < 600) {
    const t = k[0].trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
    if (t.length < 14) continue;
    const hit = [...WORD2CAT.keys()].filter(w => t.includes(w));
    if (!hit.length) continue;
    loose.push({ text: t, words: hit.slice(0, 3), pos: k.index });
    if (loose.length >= n * 2) break;
  }
  return loose.slice(0, n);
}

function craftRead(cs) {
  const A = cs.cats.action, F = cs.cats.face, S = cs.cats.sense, B = cs.cats.beat, M = cs.cats.mood, Y = cs.cats.system;
  const out = [];
  const top2 = (c) => c.top.slice(0, 2).map(([w]) => w).join('、') || '少数几个词';

  /* 四态：main 主力 / loop 密而重复 / sparse 少而精 / present 有但薄 / none 无 */
  const judge = (c, kRich, dDense) => {
    if (!c.kinds) return 'none';
    const avg = c.total / c.kinds;
    if (c.kinds >= kRich && c.density >= dDense) return 'main';
    if (c.density >= dDense && avg >= 4) return 'loop';
    if (c.kinds >= kRich) return 'sparse';
    if (c.density >= dDense * 0.8) return 'present';
    return 'thin';
  };

  /* 动作 */
  const aj = judge(A, 8, 5);
  if (aj === 'main') {
    out.push(`<b>动作是主力。</b>用了 ${A.kinds} 种动作词，每千字 ${A.density.toFixed(1)} 次，动词几乎不重复——不是靠一个"打"字撑场面。这种段落值得逐句拆：看它怎么把一个大动作切成三下。`);
  } else if (aj === 'loop') {
    out.push(`<b>动作密，但词在重复。</b>${A.total} 次只用了 ${A.kinds} 种，平均每个词用 ${(A.total / A.kinds).toFixed(1)} 次。快是快，画面会薄。你写同类场面时补一层"东西被撞坏"的细节（崩开、裂开、塌下、碾过），质感立刻不同。`);
  } else if (aj === 'sparse') {
    out.push(`<b>动作不多，但用得挑。</b>${A.kinds} 种动作词散在文中，属于点睛型，不是靠它推进。学节奏没用，抄它那几句就行。`);
  } else if (aj === 'present') {
    out.push(`<b>动作在场，但词偏少。</b>每千字 ${A.density.toFixed(1)} 次，只用到 ${A.kinds} 种（${top2(A)}）。一场冲突里至少该有三组不同动词——手、脚、东西被撞坏，各给一个。`);
  }

  /* 神态 */
  const fj = judge(F, 8, 3);
  if (fj === 'main') {
    out.push(`<b>神态写得很细。</b>${F.kinds} 种微表情，除了${top2(F)}，还动用了身体边角。这是最省力的情绪外化：不写"他很怕"，写"喉结动了一下"。`);
  } else if (fj === 'loop') {
    out.push(`<b>神态靠反复用同几个词。</b>${F.total} 次，只用到 ${F.kinds} 种（${top2(F)}）。人物一多就分不出来——给每个主要角色固定一个身体信号，比如一个咬指甲、一个摸耳垂。`);
  } else if (fj === 'present' || fj === 'sparse') {
    out.push(`<b>神态有，但集中在少数几个词。</b>${F.kinds} 种，主要是${top2(F)}。同一个情绪可以换成更小的部位——瞳孔、喉结、指尖、后颈，比"脸色一变"具体得多。`);
  } else {
    out.push(`<b>几乎不写神态。</b>人物情绪全靠动作和台词带出来。你学不了它，但要补上：至少给主要人物一个身体反应。`);
  }

  /* 生理 */
  const sj = judge(S, 6, 3);
  if (sj === 'main' || sj === 'loop') {
    out.push(`<b>生理反应在场。</b>呼吸、心跳、发抖这类词出现 ${S.total} 次，读者是被身体带着走的，不是被解释带着走的。`);
  } else if (sj === 'present') {
    out.push(`<b>有一点生理反应。</b>${S.kinds} 种（${top2(S)}）。恐惧、疼痛这类场面，加一句呼吸或胃里的反应，比写"他很紧张"有效。`);
  }

  /* 对话小动作 */
  const bj = judge(B, 5, 2);
  if (bj === 'main' || bj === 'sparse') {
    out.push(`<b>对话里夹动作。</b>${B.kinds} 种"说的方式 + 小动作"（${top2(B)}），台词不悬在空中。这是最该抄的一手。`);
  } else if (bj === 'none') {
    out.push(`<b>对话几乎没有小动作。</b>台词直接接"他说""她说"。你写的时候补一个动作——抬头、松开手、别过脸，人物立刻就立起来。`);
  }

  /* 氛围 */
  const mj = judge(M, 8, 4);
  if (mj === 'main' || mj === 'sparse') {
    out.push(`<b>氛围靠具体物。</b>${M.kinds} 种物件在撑场面（${top2(M)}），形容词很少。可以直接搬到你的场景开头。`);
  } else if (mj === 'present') {
    out.push(`<b>有一点环境细节。</b>主要是${top2(M)}。写场景时先给一个能出声或反光的东西，比写"四周很安静"有用。`);
  }

  /* 设定 */
  if (Y.density >= 10) {
    out.push(`<b>设定密度偏高。</b>每千字 ${Y.density.toFixed(1)} 次。留意它怎么把规则塞进动作里——单独解释设定，是最容易掉读者的写法。`);
  }

  if (!out.length) {
    return `写作维度整体偏薄（合计 ${cs.density.toFixed(1)} 词 / 千字）。这本书的力气不在具体描写上，更可能在对话节奏或叙述语气里——往下看「可以借的句子」。`;
  }
  return out.slice(0, 3).join(' ');
}

export function netFitness(book, content) {
  const chs = book.chapters;
  const lens = chs.map(c => c.end - c.start).filter(x => x > 0);
  const avg = Math.round(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length));
  const first = content.slice(chs[0].start, Math.min(chs[0].end, chs[0].start + 4000));
  const dlg = first.search(/[“"]/);
  const turn = first.search(/却|但|忽然|不料|谁知|岂知|没想到|就在这时/);
  const vols = chs.filter(c => /^第.{1,4}[卷部篇]|^[卷部篇]/.test(c.title.trim())).length;
  return { avg, dlg, turn, vols, count: chs.length };
}

function netFitnessHTML(book, content) {
  const f = netFitness(book, content);
  const rows = [];

  rows.push(`<li><b>章节长度</b>：平均 ${f.avg.toLocaleString()} 字。${f.avg > 3500
    ? '偏长——网文读者习惯 2000–3000 字一章，太长在手机上翻不动。'
    : f.avg < 1500
      ? '偏短，适合快节奏连载，但一章的信息量要够。'
      : '正好在网文的舒适区，一章一个完整的小事件。'}</li>`);

  if (f.dlg >= 0) {
    const pos = Math.max(100, Math.round(f.dlg / 100) * 100);
    rows.push(`<li><b>开篇</b>：约第 ${pos} 字出现第一句对话。${f.dlg > 1200
      ? '偏慢，网文前三章要尽快让人物开口。'
      : '进入得很快，读者一上来就听见人说话。'}</li>`);
  } else {
    rows.push('<li><b>开篇</b>：前 4000 字没有一句对话，纯叙述起步。网文里这是高风险开局。</li>');
  }

  if (f.turn >= 0) {
    const pos = Math.max(100, Math.round(f.turn / 100) * 100);
    rows.push(`<li><b>第一个转折</b>：约第 ${pos} 字。${f.turn > 1500
      ? '冲突来得偏晚，可以考虑把后面的事件提前。'
      : '钩子给得早，符合网文的开篇节奏。'}</li>`);
  }

  rows.push(`<li><b>分卷</b>：${f.vols >= 2
    ? `识别到 ${f.vols} 卷，可以按卷拆大纲。`
    : '没有明显的卷结构，是一条线走到底。长篇连载建议自己切卷。'}</li>`);

  return rows.join('');
}

export function localFramework(book, marks, notes, chapterStats, hasAI = false) {
  const content = book.content || '';
  const craft = craftStats(content);
  const cSent = craftSentences(content, 3);
  const totalMarks = marks.length + notes.length;

  const bars = chapterStats.map((c, i) => {
    const max = Math.max(...chapterStats.map(x => x.chars), 1);
    const w = Math.max(3, Math.round(c.chars / max * 100));
    const label = c.chars >= 10000 ? (c.chars / 10000).toFixed(1) + '万' : c.chars + '字';
    return `<div class="bar-row"><span class="lb" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
      <span class="bar" style="width:${w * 1.4}px;max-width:170px"></span>
      <span style="color:var(--ink-3);font-size:9px">${label}</span></div>`;
  }).join('');

  return `
  <div class="stat-grid">
    <div class="stat"><b>${book.charCount >= 10000 ? (book.charCount / 10000).toFixed(1) : book.charCount}</b><span>${book.charCount >= 10000 ? '万字' : '字'}</span></div>
    <div class="stat"><b>${book.chapters.length}</b><span>章节</span></div>
    <div class="stat"><b>${book.charCount / 420 >= 60 ? (book.charCount / 420 / 60).toFixed(1) : Math.max(1, Math.round(book.charCount / 420))}</b><span>${book.charCount / 420 >= 60 ? '小时可读完' : '分钟可读完'}</span></div>
    <div class="stat"><b>${totalMarks}</b><span>标记与笔记</span></div>
  </div>

  <h3>按网文标准看</h3>
  <ul>${netFitnessHTML(book, content)}</ul>
  <p style="color:var(--ink-3);font-size:11px;margin-top:2px">这是结构尺子，不是好坏判断。经典文学的节奏，放到连载里往往要重排。</p>

  <h3>章节骨架</h3>
  <p style="font-size:11px;color:var(--ink-3)">柱越长，这一章越重。</p>
  ${bars}

  <h3>写作可借的维度</h3>
  <p style="font-size:11px;color:var(--ink-3)">只数具体的写法——动词、微表情、小动作、物件。抽象词（愤怒、悲伤）不进表，因为写进小说本身就是败笔。横条是这一维在本书几个维度里的相对比重。</p>
  <div class="craft-list">
    ${(() => {
      const maxD = Math.max(...Object.values(craft.cats).map(c => c.density), 0.001);
      return Object.keys(craft.cats).map((k, i, arr) => {
      const c = craft.cats[k];
      const pct = Math.min(100, Math.round(c.density / maxD * 100));
      return `<div class="craft-row${i === arr.length - 1 ? ' craft-meta' : ''}">
        <div class="craft-head">
          <span class="craft-name">${c.name}</span>
          <span class="craft-num">${c.kinds} 种</span>
          <span class="craft-den">${c.density.toFixed(1)} / 千字</span>
        </div>
        <div class="craft-bar"><i style="width:${Math.max(2, pct)}%"></i></div>
        <div class="craft-top">${c.top.length
          ? c.top.map(([w, n]) => `${escapeHtml(w)}<b>${n}</b>`).join('<span class="sep">·</span>')
          : '<span class="lex-none">没有出现</span>'}</div>
      </div>`;
      }).join('');
    })()}
  </div>
  ${craft.sampleLen < 5000 ? `<p style="font-size:10.5px;color:var(--ink-3);margin:4px 0 0">这次只统计了 ${craft.sampleLen} 字，样本偏短，种类数会偏低。书越长，这份表越准。</p>` : ''}
  <p class="craft-read">${craftRead(craft)}</p>

  <h3>可以借的句子</h3>
  <p style="font-size:11px;color:var(--ink-3)">按"写作词命中最多"挑出来的原句，后面标了它用了哪些词。这是词的用法，不是词本身。</p>
  ${cSent.length ? cSent.map(x => `
    <blockquote>「${escapeHtml(x.text)}」
      <br><span style="font-size:10px;opacity:.6">${x.words.join(' · ')}</span>
    </blockquote>`).join('')
    : '<p style="font-size:11px;color:var(--ink-3)">这段样本里没有密集使用写作词组的句子。</p>'}

  <h3>各章起手</h3>
  <ul>
    ${book.chapters.slice(0, 12).map((c) => {
      return `<li><strong>${escapeHtml(c.title)}</strong>　${escapeHtml(chapterLead(content, c, 42))}…</li>`;
    }).join('')}
  </ul>
  ${book.chapters.length > 12 ? `<p style="color:var(--ink-3);font-size:11px">…另有 ${book.chapters.length - 12} 章</p>` : ''}

  <h3 style="margin-top:24px">${hasAI ? '接下来' : '关于深度框架'}</h3>
  <p style="color:var(--ink-2)">以上是<b>结构统计</b>：章节长度、开篇位置、写作维度密度。它告诉你这本书"长什么样"，但不解释"为什么这样写"。</p>
  <p style="color:var(--ink-3);font-size:11.5px">${hasAI ? '下面的模型梳理负责叙事线索、人物图谱、主题母题与阅读路线。' : '在「设置」中填入大模型 API Key，同一按钮会生成叙事线索、人物图谱、主题母题与阅读路线。'}</p>
  `;
}

export function localChapterOutline(book, chapter, text) {
  const paras = text.split('\n').filter(p => p.trim().length > 10);
  const q = Math.max(1, Math.floor(paras.length / 4));
  const segs = [paras.slice(0, q), paras.slice(q, q * 2), paras.slice(q * 2, q * 3), paras.slice(q * 3)];
  const names = ['起', '承', '转', '合'];
  const words = topWords(text, 10);

  return `
  <div class="stat-grid">
    <div class="stat"><b>${text.length}</b><span>字数</span></div>
    <div class="stat"><b>${paras.length}</b><span>段落</span></div>
    <div class="stat"><b>${Math.max(1, Math.round(text.length / 420))}</b><span>分钟</span></div>
    <div class="stat"><b>${topWords(text, 1)[0]?.[1] || 0}</b><span>最高词频</span></div>
  </div>

  <h3>四段速览（本地切分）</h3>
  ${segs.map((s, i) => s.length ? `<p><strong>${names[i]}</strong>　${escapeHtml(s[0].replace(/\s+/g, ' ').slice(0, 90))}…</p>` : '').join('')}

  <h3>本章高频词</h3>
  <div>${words.map(([w, c]) => `<span style="display:inline-block;padding:3px 9px;margin:3px 4px 3px 0;border:1px solid var(--line);border-radius:12px;font-size:11px">${escapeHtml(w)} <b style="color:var(--accent);font-weight:500">${c}</b></span>`).join('')}</div>

  <p style="margin-top:22px;color:var(--ink-3);font-size:11.5px">这是按段落均分的结构切片，不是叙事分析。配置大模型后，可生成事件链、人物动作与转折点。</p>
  `;
}

export function localExplain(book, content, query, chapterTitle) {
  const q = query.trim().slice(0, 30);
  const lower = content.toLowerCase();
  const ql = q.toLowerCase();
  let count = 0, first = -1;
  let idx = lower.indexOf(ql);
  while (idx >= 0 && count < 500) { if (first < 0) first = idx; count++; idx = lower.indexOf(ql, idx + ql.length); }

  const ch = book.chapters.find(c => c.start <= (first < 0 ? 0 : first) && c.end > (first < 0 ? 0 : first));

  if (!count) {
    return `<p>全书没有找到「${escapeHtml(q)}」这个说法。可能是我检索得太死——换个更短的词，或者直接选中原文再点解释。</p>
    <p style="color:var(--ink-3);font-size:11.5px">本地模式只能做字面检索，做不到同义、指代、隐喻层面的理解。</p>`;
  }

  const ctx = excerpt(content.slice(Math.max(0, first - 40), first + 400), q, 150).replace(/\s+/g, ' ');

  return `
  <h3>文本内证据</h3>
  <p>「<strong>${escapeHtml(q)}</strong>」在全书出现 <strong>${count}</strong> 次${ch ? `，最早见于「${escapeHtml(ch.title)}」` : ''}。</p>
  <blockquote>${escapeHtml(ctx)}</blockquote>
  <h3>提示</h3>
  <p style="color:var(--ink-2)">本地模式不做语义解释。若要"这句话好在哪里""这个人物为什么这样做"，请在设置里接入大模型；或者在选中文字后点「解释」，模型会结合上下文讲。</p>
  `;
}

/* 为 AI 准备全书摘要：章节标题 + 每章开头 */
export function bookDigest(book, content, limit = 30) {
  const step = Math.max(1, Math.ceil(book.chapters.length / limit));
  const parts = [];
  for (let i = 0; i < book.chapters.length; i += step) {
    const c = book.chapters[i];
    const head = content.slice(c.start, Math.min(c.end, c.start + 700)).replace(/\s+/g, ' ');
    parts.push(`【${c.title}】${head}`);
  }
  return parts.join('\n\n').slice(0, 14000);
}


/* ══════════ 写作借鉴 ══════════ */
function sampleText(text, n = 180000) {
  if (text.length <= n) return text;
  const part = Math.floor(n / 3);
  const mid = Math.floor(text.length / 2 - part / 2);
  return text.slice(0, part) + '\n' + text.slice(mid, mid + part) + '\n' + text.slice(-part);
}

export function styleStats(text, book) {
  const sample = sampleText(text);
  const paras = sample.split('\n').filter(l => l.trim().length > 1);
  const sents = sample.split(/[。！？!?…]+/).map(s => s.trim()).filter(s => s.length > 1);
  const lens = sents.map(s => s.length);
  const sum = lens.reduce((a, b) => a + b, 0);

  const avg = lens.length ? sum / lens.length : 0;
  const shortPct = lens.length ? lens.filter(l => l <= 12).length / lens.length : 0;
  const longPct = lens.length ? lens.filter(l => l >= 45).length / lens.length : 0;
  const dialoguePct = paras.length ? paras.filter(l => /[“"「『]/.test(l)).length / paras.length : 0;
  const metaCount = (sample.match(/像|似|仿佛|宛如|好比|如同/g) || []).length;
  const metaPer1000 = sample.length ? metaCount / sample.length * 1000 : 0;
  const sayCount = (sample.match(/说道|问道|答道|笑道|叫道|道：/g) || []).length;
  const avgPara = paras.length ? paras.reduce((a, b) => a + b.length, 0) / paras.length : 0;
  const commaRatio = sample.length ? (sample.match(/，/g) || []).length / sample.length * 100 : 0;

  const per1000 = (n) => sample.length ? n / sample.length * 1000 : 0;
  const meCount = (sample.match(/我/g) || []).length;
  const psychCount = (sample.match(/想道|暗想|心想|心道|暗道|寻思|思忖|自忖|觉得|琢磨|盘算|料想|转念|心下|暗自/g) || []).length;
  const qCount = (sample.match(/？/g) || []).length;
  const ellCount = (sample.match(/……|…/g) || []).length;
  const dashCount = (sample.match(/——/g) || []).length;
  const timeCount = (sample.match(/当年|后来|多年|次日|原来|当时|此时|此后|从前|三年|十年|那一夜/g) || []).length;
  const dlgMatches = sample.match(/“[^”]{1,300}”/g) || [];
  const dlgAvg = dlgMatches.length
    ? dlgMatches.reduce((a, t) => a + t.length - 2, 0) / dlgMatches.length
    : 0;

  let avgChapter = 0;
  if (book && book.chapters && book.chapters.length) {
    avgChapter = Math.round(book.chapters.reduce((a, c) => a + (c.end - c.start), 0) / book.chapters.length);
  }

  let chapterRatio = 0;
  if (book && book.chapters && book.chapters.length > 2) {
    const ls = book.chapters.map(c => c.end - c.start).filter(x => x > 200);
    if (ls.length > 2) {
      const mn = Math.min(...ls);
      chapterRatio = mn > 0 ? Math.max(...ls) / mn : 0;
    }
  }

  return {
    chars: sample.length,
    sentCount: lens.length,
    avg: Math.round(avg),
    shortPct: Math.round(shortPct * 100),
    longPct: Math.round(longPct * 100),
    dialoguePct: Math.round(dialoguePct * 100),
    metaPer1000: metaPer1000.toFixed(1),
    sayPer1000: (sayCount / sample.length * 1000).toFixed(1),
    avgPara: Math.round(avgPara),
    commaPer100: commaRatio.toFixed(1),
    mePer1000: per1000(meCount).toFixed(1),
    psychPer1000: per1000(psychCount).toFixed(1),
    qRatio: (qCount / Math.max(1, lens.length)).toFixed(2),
    ellipsisPer1000: per1000(ellCount).toFixed(1),
    dashPer1000: per1000(dashCount).toFixed(1),
    timePer1000: per1000(timeCount).toFixed(1),
    dlgAvg: Math.round(dlgAvg),
    chapterRatio: chapterRatio ? chapterRatio.toFixed(1) : '',
    avgChapter
  };
}

const SENSORY = /看|望|瞧|听|闻|嗅|触|摸|冷|热|暖|凉|光|影|声|响|香|味/;

export function pickSentences(text, n = 8) {
  const sample = sampleText(text, 260000);
  const out = [];
  const re = /[^。！？!?…\n]{12,58}[。！？!?…]/g;
  let m;
  let guard = 0;
  while ((m = re.exec(sample)) !== null && guard++ < 4000) {
    const t = m[0].trim();
    if (t.length < 12) continue;

    let score = 0;
    if (/像|似|仿佛|宛如|好比|如同/.test(t)) score += 3;
    if (SENSORY.test(t)) score += 2;
    if (/[“"「『]/.test(t)) score += 1;
    if (t.length >= 12 && t.length <= 26) score += 1;
    if (/[0-9一二三四五六七八九十百千]/.test(t)) score += 1;
    if (score >= 3) out.push({ text: t, pos: m.index, score });
  }

  out.sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  for (const s of out) {
    const key = s.text.slice(0, 6);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(s);
    if (picked.length >= n) break;
  }
  picked.sort((a, b) => a.pos - b.pos);
  return picked;
}

function whyOf(t) {
  if (/看官|列位|后事如何/.test(t)) {
    return { type: 'narrator', text: '说书人的呼语。直接把读者拉进来，距离一下子没了——现代小说里可以换成叙述者的一句旁白。' };
  }
  if (/^(却说|且说|话说)/.test(t)) {
    return { type: 'transition', text: '章回体的转场词。一句话把镜头切到新场景，不解释、不铺垫，干净利落。' };
  }
  if (/诗云|词曰|有诗为证|正是[:：]|正所谓|欲知.*须问/.test(t)) {
    return { type: 'verse', text: '用一句诗把叙述暂停一拍。情绪刚起来就收住，读者被推到更高处看这件事。' };
  }
  if (/像|似|仿佛|宛如|好比|如同/.test(t)) {
    return { type: 'metaphor', text: '比喻不堆形容词，拿一个具体的东西作比——画面是自己站起来的。' };
  }
  if (/[“"「『]/.test(t)) {
    return { type: 'dialogue', text: '对话不靠"他说""她说"推进，语气和停顿本身就在交代人物。' };
  }
  if (t.length <= 20) {
    return { type: 'short', text: '短句。一个动作一句，节奏被切得很干脆，读者来不及走神。' };
  }
  if (t.length >= 42) {
    return { type: 'long', text: '长句。修饰一层层叠上去，读的时候气息是憋着的，适合写压迫感。' };
  }
  if (SENSORY.test(t)) {
    return { type: 'sense', text: '动作和感官绑在一起写，读者跟着身体走，而不是跟着解释走。' };
  }
  return { type: 'action', text: '把信息藏在具体的动作里，没有一句是在"说明"。' };
}

function diagnoses(stats, sample) {
  const s = stats;
  const cands = [];
  const add = (group, dev, fact, mean, todo) => {
    if (dev <= 0) return;
    cands.push({ group, dev: Math.min(dev, 1), fact, mean, todo });
  };

  /* ── 语言层 ── */
  const avgDev = Math.abs(s.avg - 22) / 22;
  if (true) {
    if (s.avg >= 26) {
      add('lang', avgDev * 0.9,
        `平均句长 ${s.avg} 字，长句占 ${s.longPct}%`,
        '句子是铺开的，气息压着走。适合写连续的观察、缓慢逼近的场面。',
        '把一段连续动作写成一个长句，中间只用逗号，最后才落句号。');
    } else {
      add('lang', avgDev * 0.9,
        `平均句长 ${s.avg} 字，短句占 ${s.shortPct}%`,
        '句子切得很碎，节奏快，读者来不及走神。',
        '三个短句一组，一个动作一句，主语能省就省。');
    }
  }
  const say = Number(s.sayPer1000);
  if (say > 0 && say <= 1.2) {
    add('lang', 0.62,
      `每千字只有 ${s.sayPer1000} 次「说道 / 问道」`,
      '它几乎不交代是谁在说话，靠动作和语气区分人物，读起来像在旁观。',
      '删掉三处"他说"，换成他正在做的事：掐灭烟、往后靠、把杯子推远。');
  } else if (say >= 8) {
    add('lang', 0.55,
      `每千字 ${s.sayPer1000} 次「说道 / 问道」`,
      '提示语用得很密，谁在说话一目了然，代价是句子容易变成流水账。',
      '保留提示语，但每次后面跟一个动作，别让对话悬在半空。');
  }
  if (Number(s.metaPer1000) >= 3) {
    add('lang', 0.7,
      `每千字 ${s.metaPer1000} 处比喻`,
      '意象密度高，画面感强，但连续读会累。',
      '每千字只留两个，挑最不像的那个，其余删掉。');
  }
  if (Number(s.ellipsisPer1000) >= 4) {
    add('lang', 0.58,
      `每千字 ${s.ellipsisPer1000} 处省略号`,
      '大量用省略号收尾，话不说尽，留白多。',
      '在一个人物该发火的地方，用省略号代替那句狠话。');
  }

  /* ── 对话层 ── */
  const dlg = s.dialoguePct;
  if (dlg >= 35) {
    add('talk', Math.min(0.95, (dlg - 15) / 25),
      `约 ${dlg}% 的段落含对话`,
      '信息大量藏在人物嘴里，叙述只做衔接。读者是"听"进去的，不是被"讲"进去的。',
      '把一段设定改写成两个人吵架，谁都不许直接解释背景。');
  } else if (dlg <= 12) {
    add('talk', Math.min(0.95, (25 - dlg) / 25),
      dlg === 0 ? '几乎没有对话段落' : `只有 ${dlg}% 的段落含对话`,
      '主要靠叙述推进，人物很少开口，一开口就有分量。',
      '在最长的叙述段里插一句人物原话，不加"他说"。');
  } else {
    add('talk', 0.22,
      `${dlg}% 的段落含对话`,
      '对话和叙述大致各半，交替推进，信息分配比较均匀。',
      '检查一下：每次对话结束，是不是立刻接了一段解释？试着删掉那段解释。');
  }
  const q = Number(s.qRatio);
  if (q >= 0.45) {
    add('talk', 0.68,
      `问句占全部句子的 ${Math.round(q * 100)}%`,
      '人物几乎在用问题对话，互相试探、回避、逼问。',
      '写一场戏，两个人都不直接回答对方的问题。');
  } else if (q > 0 && q <= 0.08) {
    add('talk', 0.52,
      '几乎没有问句，人物都在陈述',
      '对话是宣告式的，没有试探，谁都不打算听对方的。',
      '把一句陈述改成反问，人物的态度立刻就变了。');
  }
  if (s.dlgAvg >= 55) {
    add('talk', 0.6,
      `对话平均 ${s.dlgAvg} 字一句`,
      '不是你来我往，而是大段独白，人物在讲述而不是交谈。',
      '给独白的人安排一个打断他的动作，让话说不完。');
  } else if (s.dlgAvg > 0 && s.dlgAvg <= 12) {
    add('talk', 0.58,
      `对话平均只有 ${s.dlgAvg} 字一句`,
      '短促、打断、抢话，情绪比信息多。',
      '一场戏里让一个人连续三次只说两个字。');
  }

  /* ── 叙事层 ── */
  const me = Number(s.mePer1000);
  if (me >= 10) {
    add('narr', 0.88,
      `每千字 ${s.mePer1000} 次「我」`,
      '第一人称。读者被按在主角的身体里，只能知道他知道的。',
      '写一段"我"误判别人心思的戏，让错位自己发生。');
  } else if (me <= 1.5) {
    add('narr', 0.42,
      `每千字仅 ${s.mePer1000} 次「我」`,
      '第三人称。镜头可以自由移动，也能切进别人的脑子。',
      '同一场戏写两遍，分别只写两个人各自注意到的东西。');
  }
  const psy = Number(s.psychPer1000);
  if (psy >= 12) {
    add('narr', 0.72,
      `每千字 ${s.psychPer1000} 次心理动词`,
      '内心戏很重，人物的判断和犹豫直接摊在纸上。',
      '把一句"他想不通"换成他做错的一件事。');
  } else if (psy <= 2) {
    add('narr', 0.5,
      '几乎不写心理，只写动作',
      '人物的想法要靠行为和对话去猜，读者参与感更强。',
      '删掉一段心理描写，只留他手上的动作。');
  }
  if (Number(s.timePer1000) >= 7) {
    add('narr', 0.55,
      `每千字 ${s.timePer1000} 个时间跳跃词`,
      '叙事在时间上来回切，靠"当年""此后"直接跳，不写过渡。',
      '用"三天后"直接切走一段，不要解释这三天怎么过的。');
  }
  if (s.avgChapter >= 9000) {
    add('narr', 0.52,
      `平均每章 ${(s.avgChapter / 10000).toFixed(1)} 万字`,
      '一章就是一个完整的场景序列，读者要在一章里待很久。',
      '把一章当成三场戏来排：进场景、翻一次面、留一个钩子。');
  } else if (s.avgChapter > 0 && s.avgChapter <= 2200) {
    add('narr', 0.48,
      `平均每章只有 ${s.avgChapter} 字`,
      '章节切得碎，节奏快，适合移动端一口气读几章。',
      '把一个大场景拆成三章，每章只解决一个问题。');
  }
  if (s.chapterRatio && Number(s.chapterRatio) >= 2.5) {
    add('narr', 0.5,
      `最长的一章是最短一章的 ${s.chapterRatio} 倍`,
      '章节长度不均，说明它按事件轻重分配篇幅，而不是平均切。',
      '把最重要的一场戏单独撑成一章，别的章压短。');
  }

  const byGroup = { lang: [], talk: [], narr: [] };
  cands.sort((a, b) => b.dev - a.dev).forEach(c => byGroup[c.group].push(c));

  const picked = [];
  ['narr', 'talk', 'lang'].forEach(g => {
    if (byGroup[g][0]) picked.push(byGroup[g][0]);
  });

  if (picked.length < 3) {
    for (const c of cands) {
      if (picked.length >= 3) break;
      if (!picked.includes(c)) picked.push(c);
    }
  }
  return picked.slice(0, 3);
}

export function localWriting(book, content, stats) {
  const s = stats;
  const sample = sampleText(content, 200000);
  const dx = diagnoses(s, sample);

  const reads = [];
  if (s.avg >= 26) reads.push('句子偏长');
  else if (s.avg <= 18) reads.push('句子偏短');
  if (Number(s.mePer1000) >= 10) reads.push('第一人称');
  else if (Number(s.mePer1000) <= 1.5) reads.push('第三人称');
  if (Number(s.qRatio) >= 0.45) reads.push('对话靠问句试探');
  else if (s.dlgAvg > 0 && s.dlgAvg <= 12) reads.push('对话短促');
  else if (s.dlgAvg >= 55) reads.push('对话是独白式的');
  if (s.dialoguePct >= 35) reads.push('靠对话推进');
  else if (s.dialoguePct <= 12) reads.push('以叙述推进');
  if (Number(s.psychPer1000) >= 12) reads.push('内心戏重');
  else if (Number(s.psychPer1000) > 0 && Number(s.psychPer1000) <= 2) reads.push('几乎不写心理');
  if (Number(s.timePer1000) >= 7) reads.push('时间频繁跳跃');

  return `
  <div class="stat-strip">
    <span><b>${s.avg}</b><em>字 / 句</em></span>
    <span><b>${s.dialoguePct}%</b><em>含对话</em></span>
    <span><b>${s.mePer1000}</b><em>「我」/ 千字</em></span>
    <span><b>${s.chapterRatio || '—'}</b><em>章长倍差</em></span>
  </div>
  <p class="stat-read">${reads.length ? '这本书' + reads.slice(0, 3).join('，') + '。' : '语言上没有明显的偏科，属于均衡型。'}</p>

  ${actionCardsHTML(actionCards(content, dx))}
  `;
}

export function promptWriting(book, digest, stats) {
  return [
    { role: 'system', content: SYS + '\n7. 你是一位网络小说主编。只给能落笔的东西，不要赏析，不要清单式说教。' },
    {
      role: 'user', content: `我在读${bookMeta(book)}，想学它的写法，目标是写网络小说。

【章节与开头】
${digest}

【文本统计】
平均句长 ${stats.avg} 字，短句占 ${stats.shortPct}%，含对话段落 ${stats.dialoguePct}%，每千字比喻 ${stats.metaPer1000} 处，每千字"说道/问道" ${stats.sayPer1000} 次。

请用 Markdown 输出，全文不超过 800 字。**必须从原文里摘句子，不要只说结论。**

### 一句话判断
这本书能不能当你的模板，适合哪个赛道。不能就直说。

### 三句可以拆的
从原文挑三句，每句按这个格式写：

**第 1 句**
- 原文：「……」
- 换个写法：（拆成短句 / 合成一句 / 去掉提示语，选一种，把整句写出来）
- 差别在哪：一句话说清节奏或信息的变化

三句都要挑不同的手法（句长、对话、场景各一），不要三句一个样。

### 写一段你自己的
用它的句法，写 300 字左右，场景换成现代都市。要有人物、有动作、有一个没说出口的意思。

不要写"练习建议""常见错误"这类清单。` }
  ];
}

export const WRITING_FRAMEWORKS = [
  {
    id: 'golden3',
    name: '黄金三章',
    sub: '开篇决定 80% 的留存',
    intro: '网文平台的前三章不是"故事的开头"，是"产品的试用装"。读者在这里决定留还是走。',
    parts: [
      { t: '第 1 章 · 抛出处境（1500–2500 字）', d: '前 300 字必须出现：一个具体的人、一个具体的麻烦、一个反常的细节。不要交代世界观，不要写天气。结尾留一个"未完成的动作"。' },
      { t: '第 2 章 · 展示底色（2000–3000 字）', d: '让主角做一次选择，暴露他的性格与能力边界。给第一个小爽点：不是打赢，而是"别人没想到他会这样"。' },
      { t: '第 3 章 · 给出欲望（2000–3000 字）', d: '主角明确说出或做出"我要什么"。同时埋一条长线悬念（身世、仇人、倒计时）。三章结束时，读者应能一句话说出这本书要讲什么。' }
    ],
    check: ['第一章 300 字内有具体危机', '每章结尾都有未完成动作', '第三章结束前出现全书目标', '没有一段超过 200 字的设定说明']
  },
  {
    id: 'chapter',
    name: '单章结构',
    sub: '2000–3000 字的标准章',
    intro: '网文按章售卖注意力。每一章都要能独立成立：有钩子、有推进、有转折、有悬念。',
    parts: [
      { t: '开场钩（200–300 字）', d: '直接承接上一章的悬念。第一句最好是动作或对话，不要心理描写。' },
      { t: '推进（1200–1500 字）', d: '目标—阻碍—尝试。主角这一章想干什么，谁或什么在挡，他试了什么。' },
      { t: '转折（600–800 字）', d: '一个意外信息或对手的新动作，让局面偏离预期。这里是读者"啊"的一声。' },
      { t: '收束（200–300 字）', d: '小胜或小挫，再抛一个新问题。最后一句最好不要用句号，留个钩。' }
    ],
    check: ['第一句是动作或对话', '章内至少一次局面反转', '结尾留下一个具体的问题', '删掉这一章，主线会断']
  },
  {
    id: 'rhythm',
    name: '爽点节奏',
    sub: '三章一小爽，十章一大爽',
    intro: '爽感来自"压抑—释放"的落差。一直爽等于不爽，一直压等于弃书。',
    parts: [
      { t: '小爽点（每 3 章）', d: '一次打脸、一次小升级、一次被认可。长度不超过半章，解决完立刻走。' },
      { t: '大爽点（每 10 章）', d: '一个阶段的结算：越级战胜、身份揭晓、势力翻盘。要提前 3 章铺代价。' },
      { t: '压抑段（3:1）', d: '每三次爽点，配一次实打实的失败或失去。压抑要具体：丢东西、死人、被误解。' },
      { t: '节奏表', d: '把 30 章列成表，标出每次爽点和压抑点。连续 5 章没有落差，读者就会走。' }
    ],
    check: ['每 3 章至少一次情绪释放', '爽点前有明确代价', '没有连续 5 章的平铺', '大爽点前有 3 章铺垫']
  },
  {
    id: 'arc',
    name: '人物弧光',
    sub: '读者跟的是人，不是设定',
    intro: '一个能撑住 100 万字的主角，必须有"想要—受阻—付出—改变"的完整链条。',
    parts: [
      { t: '欲望', d: '他想要什么？要具体到可以拍成画面。不是"变强"，是"把父亲的刀拿回来"。' },
      { t: '阻碍', d: '谁不让他得到？这个对手要有自己的道理，不能是纯恶。' },
      { t: '代价', d: '为了得到，他愿意失去什么？写下来，后面一定要真的失去。' },
      { t: '转变', d: '结尾他变成了谁？这个答案要和开头的欲望形成对照。' },
      { t: '秘密', d: '读者不知道、但主角知道的一件事。这是后期反转的燃料。' }
    ],
    check: ['欲望可以用一个画面描述', '反派有可信的动机', '中段真的失去过东西', '结尾与开头的欲望形成对照']
  },
  {
    id: 'volume',
    name: '分卷大纲',
    sub: '把一百万切成四口气',
    intro: '长篇不是一条直线，是四个递进的"局"。每卷有独立的起承转合，又共同推主线。',
    parts: [
      { t: '卷一 · 立人设、立规则（1–30 章）', d: '让读者认识主角、接受世界规则、看到第一个敌人。卷末：主角获得一个"资格"。' },
      { t: '卷二 · 升级扩张（31–80 章）', d: '地图变大，盟友出现，敌人升级。卷末：一次惨胜，暴露更大的威胁。' },
      { t: '卷三 · 危机背叛（81–130 章）', d: '内部出问题，主角跌到最低。卷末：失去最重要的东西，被迫做出选择。' },
      { t: '卷四 · 决战收束（131–160 章）', d: '把所有伏笔收回来。卷末：主角用全书学到的东西，解决最初的那个问题。' }
    ],
    check: ['每卷有独立的卷末大事件', '每卷结尾主角状态发生不可逆改变', '伏笔在卷四回收', '卷二没有退化成重复打怪']
  },
  {
    id: 'open500',
    name: '开篇 500 字自检',
    sub: '写完第一章，拿这张表对一遍',
    intro: '读者只给你 500 字。这 500 字里没有"发生"，他就走了。',
    parts: [
      { t: '有没有具体场景', d: '时间、地点、一个可触摸的物件。不要"某年某月"，要"雨夜，城南当铺的柜台"。' },
      { t: '有没有一个动作', d: '主角在做什么？推门、数钱、擦刀、撒谎。静态描写一律删。' },
      { t: '有没有一个反常', d: '一个不合常理的细节，让读者想问"为什么"。' },
      { t: '有没有一句能记住的话', d: '一句台词或一句叙述，可以被读者截图转发。' },
      { t: '有没有信息过载', d: '500 字内出现的人名不超过 3 个，地名不超过 2 个，设定不超过 1 条。' }
    ],
    check: ['开头第一句不是天气', '500 字内出现具体动作', '人名 ≤ 3', '有一个让人想问"为什么"的细节']
  }
];

export function localFrameworks() {
  return `
  <h3>写作框架</h3>
  <p style="font-size:11px;color:var(--ink-3)">六套骨架，填一句设定就能按它搭一份能开写的方案。</p>
  <div class="fw-form">
    <div class="fw-form-row">
      <label>题材
        <select id="fwGenre">
          <option>玄幻 / 仙侠</option>
          <option>都市 / 异能</option>
          <option>悬疑 / 推理</option>
          <option>言情 / 古言</option>
          <option>科幻 / 末世</option>
          <option>历史 / 军事</option>
          <option>其他</option>
        </select>
      </label>
    </div>
    <div class="fw-form-row">
      <label>一句话设定
        <input id="fwPremise" placeholder="谁，想要什么，被什么挡住">
      </label>
    </div>
    <p class="fw-form-hint">填完设定，点任意框架里的「用这个框架帮我搭」，模型会按骨架出方案。</p>
  </div>

  <div class="fw-list">
    ${WRITING_FRAMEWORKS.map((f, i) => `
      <details class="fw-card"${i === 0 ? ' open' : ''}>
        <summary><span class="fw-name">${f.name}</span><span class="fw-sub">${f.sub}</span></summary>
        <p class="fw-intro">${f.intro}</p>
        ${f.parts.map(p => `<div class="fw-part"><b>${p.t}</b><p>${p.d}</p></div>`).join('')}
        <div class="fw-check"><b>自检清单</b><ul>${f.check.map(c => `<li>${c}</li>`).join('')}</ul></div>
        <button class="mini-btn fw-gen" data-fw="${f.id}">用这个框架帮我搭</button>
        <div class="fw-result" id="fwRes-${f.id}" hidden></div>
      </details>`).join('')}
  </div>`;
}

export function promptFramework(fw, genre, premise) {
  return [
    { role: 'system', content: SYS + '\n7. 你是一位网络小说主编，熟悉起点、番茄、七猫的签约与留存标准。' },
    {
      role: 'user', content: `题材：${genre}
故事设定：${premise}

请用「${fw.name}」这个框架，为这个故事搭一份可以直接开写的方案。

框架要求：
${fw.parts.map(p => `- ${p.t}：${p.d}`).join('\n')}

自检项：
${fw.check.map(c => `- ${c}`).join('\n')}

输出要求：
1. 按框架逐条给出具体方案，每条 2–4 句，不要空话
2. 每条配一句可直接放进小说的示例文字
3. 最后单列「两个最容易翻车的地方」，说清怎么避免`
    }
  ];
}

/* ══════════ 可复用性扫描 ══════════
 * 判断一段文字"改几个字就能用"还是"必须大改"。
 * 依据不是文笔好坏，而是：它绑定原书的程度（人名、设定、情节、对话）。
 */
const PLOT_RE = /当年|此后|次日|原来|不料|谁知|终于|于是|此时|后来|半晌|从此|至此|那一夜|多年后|当下|却说|且说|话说|看官|不在话下|后事如何/g;

function paraKind(hits) {
  let best = null, max = 0;
  for (const k of Object.keys(hits)) {
    if (hits[k] > max) { max = hits[k]; best = k; }
  }
  return best || 'mix';
}

function analyzePara(t, names) {
  const cats = {};
  let craftHits = 0;

  for (const [w, k] of WORD2CAT) {
    if (t.includes(w)) {
      craftHits++;
      cats[k] = (cats[k] || 0) + 1;
    }
  }

  const sysHits = cats.system || 0;
  const nameHits = names.filter(n => t.includes(n)).length;
  const hasTalk = /[“”"]/.test(t);
  const plotHits = (t.match(PLOT_RE) || []).length;
  const metaHit = /像|似|仿佛|宛如|好比/.test(t) ? 1 : 0;

  let s = Math.min(6, craftHits * 1.2);
  if (t.length >= 24 && t.length <= 90) s += 1;
  s -= Math.min(3, nameHits * 1.5);
  if (hasTalk) s -= 1.5;
  s -= Math.min(4, sysHits * 1.2);
  s -= Math.min(3, plotHits * 1);
  s -= metaHit;

  const norm = Math.max(0, Math.min(1, (s + 5) / 11));
  return { norm, nameHits, sysHits, plotHits, hasTalk, craftHits, kind: paraKind(cats), cats };
}

function reuseWhy(x) {
  if (x.nameHits >= 2) return `${x.nameHits} 个专名绑着原书人物，直接搬会串味`;
  if (x.sysHits >= 2) return `含 ${x.sysHits} 个设定词，属于它的世界观`;
  if (x.hasTalk) return '对话绑着人物性格和关系，换名字也没用';
  if (x.plotHits >= 2) return '这段在推进情节，脱离上下文就散了';
  if (x.metaHit) return '比喻是作者的个人印记，照搬等于抄';
  return '信息密度低，改写成本高于自己写';
}

function reuseHow(x) {
  const k = x.kind;
  if (k === 'action') return '保留动词顺序，换掉人物和手里的东西';
  if (k === 'face') return '照用它的先后和节奏，换掉人物与情绪的由头';
  if (k === 'sense') return '照用身体反应，换掉触发它的事件';
  if (k === 'mood') return '换掉地名和物件名，句式和节奏照用';
  if (k === 'beat') return '留停顿的位置，台词全换';
  return '换掉专名，其余照搬';
}

const NOT_NAME = /^(他们|她们|我们|你们|大家|众人|有人|那人|这人|一个|两个|三个|几个|自己|别人|什么|怎么|如何|于是|但是|可是|所以|因为|如果|就是|还是|只是|不是|没有|没说|没问|接着|然后|忽然|突然|终于|说道|问道|答道|笑道|叫道|喝道|叹道|点头|摇头|陪笑|冷笑|苦笑|忙笑|含笑|带笑|说着|听说|只见|不觉|当下|一面|一时|此时|彼时|半晌|多时|少时|起来|下去|过来|出去|进来|回来|抬头|低头|回头|转身|开口|问道|答道)$/;

/**
 * 人名识别：只认「X 道 / X 说 / X 问」这类叙述标签前的词。
 * 比通用分词可靠得多——分词会把"木桌""杯子"也当成专名。
 */
export function detectNames(content, book) {
  const counts = new Map();
  const sample = sampleText(content, 400000);
  const bump = (w) => counts.set(w, (counts.get(w) || 0) + 1);
  const BAD_HEAD = /^[他她它我你这那就也都还只又才便却而且则因故虽如若于与及或再更最很太没不别很上下前后里外自其此该本]/;
  const ok = (w) => w.length >= 2 && w.length <= 3 && !NOT_NAME.test(w)
    && !WORD2CAT.has(w) && !/^(.)\1+$/.test(w) && !BAD_HEAD.test(w);

  // 规则一：叙述标签「某某道 / 某某说」
  const re1 = /(?:^|[。！？；，\s“”"])([\u4e00-\u9fa5]{2,3}?)(?:想道|暗道|心道|说道|问道|答道|笑道|哭道|叫道|喝道|叹道|道|说)[：:，,]?/g;
  let m, guard = 0;
  while ((m = re1.exec(sample)) !== null && guard++ < 30000) {
    if (ok(m[1])) bump(m[1]);
  }

  // 规则二：句首的 2-3 字 + 动作（现代文本常用"他说"，抓不到标签）
  const re2 = /(?:^|[。！？\n])([\u4e00-\u9fa5]{2,3}?)(?=说|道|问|答|站|走|看|转|抬|低|笑|哭|皱|点|摇|伸|拿|推|拉|坐|起|进|出|跑|停|愣|蹲|跪|盯|扫|叹|顿|僵|退|冲|抓|握|把|从|向)/g;
  guard = 0;
  while ((m = re2.exec(sample)) !== null && guard++ < 30000) {
    if (ok(m[1])) bump(m[1]);
  }

  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, 15);
}

export function reuseScan(book, content, range) {
  const from = Math.max(0, range?.start ?? 0);
  const to = Math.min(content.length, range?.end ?? content.length);
  const slice = content.slice(from, to);

  const names = detectNames(content, book);

  /* 切段：超长段落按句号二次切块，否则一整段会被整段丢掉 */
  let paras = [];
  let cursor = from;
  const push = (t, at) => {
    if (t.length >= 18 && t.length <= 320) paras.push({ t, at });
  };

  for (const raw of slice.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();

    if (t.length >= 18 && t.length <= 320) {
      push(t, cursor + lead);
    } else if (t.length > 320) {
      const parts = t.split(/(?<=[。！？…])/);
      let buf = '', bufStart = 0, off = 0;
      for (const part of parts) {
        if (!buf) bufStart = off;
        if (buf.length + part.length > 150 && buf.length >= 18) {
          push(buf.trim(), cursor + lead + bufStart);
          buf = '';
          bufStart = off;
        }
        buf += part;
        off += part.length;
      }
      if (buf.trim().length >= 18) push(buf.trim(), cursor + lead + bufStart);
    }
    cursor += raw.length + 1;
  }

  /* 长文本采样，避免卡顿 */
  if (paras.length > 1500) {
    const step = Math.ceil(paras.length / 1500);
    paras = paras.filter((_, i) => i % step === 0);
  }

  const bind = (f) => f.nameHits * 2 + Math.min(4, f.sysHits * 1.5)
    + (f.hasTalk ? 1.5 : 0) + Math.min(2, f.plotHits);

  const all = [];
  for (const p of paras) {
    const f = analyzePara(p.t, names);
    p.f = f;
    p.bind = bind(f);
    p.chapter = (book.chapters.find(c => c.start <= p.at && c.end > p.at) || book.chapters[0])?.title || '';
    all.push(p);
  }

  // 可直用：可复用度最高的，门槛 0.58
  const good = all.filter(p => p.f.norm >= 0.58 && p.bind < 2.5).sort((a, b) => b.f.norm - a.f.norm);
  // 要大改：绑定度最高的，门槛 2
  const used = new Set(good.slice(0, 3).map(p => p.at));
  const hard = all.filter(p => p.bind >= 2 && !used.has(p.at)).sort((a, b) => b.bind - a.bind);

  const pick = (arr, n) => {
    const out = [];
    for (const x of arr) {
      if (out.some(y => y.t.slice(0, 10) === x.t.slice(0, 10))) continue;
      out.push(x);
      if (out.length >= n) break;
    }
    return out.map(x => ({
      text: x.t,
      chapter: x.chapter,
      kind: x.f.kind,
      why: reuseWhy(x.f),
      how: (x.f.nameHits === 1 ? '换掉人名，' : '') + reuseHow(x.f),
      norm: x.f.norm,
      nameHits: x.f.nameHits,
      sysHits: x.f.sysHits,
      bind: x.bind,
      plotHits: x.f.plotHits,
      hasTalk: x.f.hasTalk,
      at: x.at
    }));
  };

  return {
    good: pick(good, 3),
    hard: pick(hard, 3),
    total: all.length,
    goodCount: good.length,
    hardCount: hard.length,
    rangeLabel: range?.label || '全书'
  };
}

export function reuseHTML(r, active) {
  const tabs = [['all', '全书'], ['arc', '近 5 章'], ['chapter', '本章']];
  const shortCh = (t) => {
    const x = (t || '').replace(/^第[一二三四五六七八九十百零\d]+[回章节卷]\s*/, '').trim();
    return x.length > 14 ? x.slice(0, 14) + '…' : x;
  };

  const clip = (t) => t.length > 108 ? t.slice(0, 108) + '…' : t;

  const card = (x, i) => {
    const mode = x.kind === 'beat' ? 'talk' : (x.text.length >= 28 ? 'split' : '');
    const alt = mode ? variantOf(x.text, mode) : '';
    return `
    <div class="rv-line">
      <div class="rv-meta">
        <span>${escapeHtml(shortCh(x.chapter))}</span>
        <span class="rv-tag">${KIND_CN[x.kind] || '综合'}</span>
      </div>
      <p class="rv-text">${escapeHtml(clip(x.text))}</p>

      ${alt && alt !== x.text ? `<p class="rv-alt"><b>换一种写法</b><span>${escapeHtml(clip(alt))}</span></p>` : ''}

      <p class="rv-fill"><b>你来 · ${escapeHtml(x.scene || pickScene(x.kind, i))}</b><span>${escapeHtml(clip(fillBlank(x.text)))}</span></p>

      <div class="rv-foot">
        <span class="rv-how">${escapeHtml(x.how)}</span>
        <button data-goto-at="${x.at}">看原文</button>
        <button data-mat="${encodeURIComponent(x.text.slice(0, 300))}" data-mat-kind="${x.kind}" data-mat-ch="${encodeURIComponent(x.chapter || '')}" data-mat-at="${x.at}">收进素材</button>
      </div>
    </div>`;
  };

  return `
    <h3>可仿写</h3>
    <p style="font-size:11px;color:var(--ink-3)">每段都是这本书里的原话。看它怎么排，再换一种排法，最后拿它当模子写你自己的一句。</p>
    <div class="rv-tabs">
      ${tabs.map(([k, n]) => `<button data-reuse="${k}" class="${k === active ? 'on' : ''}">${n}</button>`).join('')}
    </div>
    <p class="rv-sum">${escapeHtml(r.rangeLabel)} · 共 ${r.total} 段：<b>${r.goodCount}</b> 段可以照着写，${r.hardCount} 段绑着人名、设定或对话，直接搬会串味。</p>
    <div class="rv-list">
      ${r.good.length ? r.good.map((x, i) => card(x, i)).join('') : '<p class="rv-empty">这本书里没有可以照结构仿写的段落——每一句都绑着具体的人。</p>'}
    </div>`;
}


export function checkupText(book, ck) {
  const items = [
    ['opening', '开篇留人'], ['chapter', '章节长度'], ['hook', '章末钩子'],
    ['rhythm', '转折与爽点'], ['dialog', '对话比例']
  ];
  return `# 《${book.title}》稿件体检 · ${ck.total}/100

${ck.chapters} 章 · ${ck.chars} 字 · 平均 ${ck.avgLen} 字/章

${items.map(([k, n]) => `- ${n}：${ck.S[k]}/20`).join('\n')}

## 最该改的三处
${items.map(([k, n]) => ({ k, n, v: ck.S[k] })).sort((a, b) => a.v - b.v).slice(0, 3)
  .map((w, i) => `${i + 1}. **${w.n}（${w.v}/20）** ${ck.advice[w.k]}`).join('\n')}

## 开篇 500 字
第一句是${ck.opening.firstType}；${ck.opening.names} 个人名、${ck.opening.actions} 组动作词、${ck.opening.sys} 个设定词；对话出现在第 ${ck.opening.dlgPos < 0 ? '（没有）' : ck.opening.dlgPos + ' 字'}。

## 章末钩子
${ck.rows.map((r, i) => `第${i + 1}章：${r.hook.type}`).join(' · ')}
`;
}

/* ══════════ 稿件体检 ══════════ */

const TURN_RE = /却|但是|可是|然而|不料|谁知|偏偏|反而|没想到|岂知|倒/g;
const PEAK_RE = /终于|一举|当场|所有人|哗然|震惊|不由得|竟然|居然|直接|碾压|反杀|翻盘|认输|服气|让步|改口/g;

export function hookOf(chText) {
  const tail = chText.slice(-120).replace(/\s+/g, ' ').trim();
  const end = tail.slice(-50);

  if (/[？?]/.test(end)) return { type: '悬念', score: 3, hint: '用问题收尾，读者想知道答案' };
  if (/突然|忽然|正要|刚要|还没|只差|就在这时|下一刻|猛地|一把/.test(end)) return { type: '危机', score: 3, hint: '动作没做完就断了' };
  if (/却|但|可|然而|谁知|不料|偏偏|竟然|居然/.test(end)) return { type: '反转', score: 2.6, hint: '最后一句翻了面' };
  if (/原来|竟是|终于|真相|才知|方才明白|才知道/.test(end)) return { type: '揭秘', score: 2.4, hint: '抛出一个新信息' };
  if (/……|…$/.test(tail)) return { type: '未完', score: 2.2, hint: '话没说完' };
  if (/[“”"]/.test(end)) return { type: '台词', score: 1.9, hint: '以台词收尾，看这句够不够狠' };
  return { type: '平收', score: 0.4, hint: '平稳收束，没有逼人翻页的力量' };
}

export function rhythmOf(book, content) {
  return book.chapters.map((c, i) => {
    const t = content.slice(c.start, c.end);
    return {
      i,
      title: c.title,
      chars: t.length,
      turns: (t.match(TURN_RE) || []).length,
      peaks: (t.match(PEAK_RE) || []).length,
      hook: hookOf(t)
    };
  });
}

const countCraft = (text, cat) => {
  let n = 0;
  for (const [w, k] of WORD2CAT) if (k === cat && text.includes(w)) n++;
  return n;
};

export function checkupData(book, content) {
  const chs = book.chapters;
  const rows = rhythmOf(book, content);
  const stats = styleStats(content, book);
  const names = detectNames(content, book);

  const lens = rows.map(r => r.chars);
  const avgLen = Math.round(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length));

  const ch0 = chs[0];
  const raw = content.slice(ch0.start, Math.min(ch0.end, ch0.start + 900));
  // 去掉章节标题行，否则"第一章 雨夜"会被当成第一句
  const opening = raw.replace(/^\s*第[^\n]{0,40}\n+/, '').slice(0, 500);
  const first = (opening.split(/[。！？…]/)[0] || '').slice(0, 40);
  const dlgPos = opening.search(/[“"]/);
  const nm = names.filter(n => opening.includes(n)).length;
  const act = countCraft(opening, 'action');
  const sys = countCraft(opening, 'system');

  const firstType = /^[“"]/.test(first) ? '对话'
    : /^(天|夜色|阳光|雨|风|雪|晨|黄昏|傍晚|清晨|午后)/.test(first) ? '天气/时间'
    : countCraft(first, 'action') > 0 ? '动作'
    : /想|觉得|记得|知道|心中|心念/.test(first) ? '心理'
    : '叙述/说明';

  const ck = (v) => Math.max(0, Math.min(20, Math.round(v)));

  const S = {};
  S.opening = ck(8
    + (nm <= 3 ? 4 : -3)
    + (act >= 2 ? 4 : act >= 1 ? 2 : 0)
    + (dlgPos >= 0 && dlgPos < 300 ? 4 : 0)
    + (sys >= 4 ? -4 : 0)
    + (firstType === '天气/时间' ? -4 : 0));

  S.chapter = avgLen >= 1800 && avgLen <= 3800 ? 20 : (avgLen >= 1200 && avgLen <= 5200 ? 15 : 9);

  const hookAvg = rows.reduce((a, r) => a + r.hook.score, 0) / Math.max(1, rows.length);
  S.hook = ck(hookAvg / 3 * 20);

  const withTurn = rows.filter(r => r.turns > 0).length / Math.max(1, rows.length);
  const withPeak = rows.filter(r => r.peaks > 0).length / Math.max(1, rows.length);
  S.rhythm = ck(withTurn * 10 + withPeak * 10);

  const d = stats.dialoguePct;
  S.dialog = d >= 15 && d <= 45 ? 20 : d >= 8 ? 14 : d >= 3 ? 9 : 5;

  const total = S.opening + S.chapter + S.hook + S.rhythm + S.dialog;

  const flat = rows.filter(r => r.hook.score <= 1).length;
  const noTurn = rows.filter(r => r.turns === 0).length;
  const noPeak = rows.filter(r => r.peaks === 0).length;

  const advice = {
    opening: nm > 3
      ? `开篇 500 字里出现了 ${nm} 个人名，读者记不住。砍到 3 个以内，其余用"那人""老者"代替。`
      : dlgPos < 0
        ? '开篇 500 字没有一句对话，读者听不到人说话。让人物在第 200 字内开口。'
        : firstType === '天气/时间'
          ? '第一句在写天气或时间。删掉它，直接从人物正在做的事开始。'
          : '开篇动作不够具体。给主角一个正在进行的动作（推门、数钱、擦刀），别停在状态描写。',
    chapter: avgLen > 3800
      ? `平均每章 ${avgLen} 字，手机上翻不动。压到 2500–3000，一章一个小事件。`
      : avgLen < 1200
        ? `平均每章只有 ${avgLen} 字，信息量撑不起一章。合并两章，或给每章补一个完整的转折。`
        : '章节长度在舒适区，注意别让每章都一个长度——按事件轻重拉开。',
    hook: `${flat} 章是平收结尾。平收不是错，但连着三章平收，读者就会走。至少每三章给一个悬念或反转。`,
    rhythm: noTurn > 0
      ? `${noTurn} 章没有一次转折。没有转折的章节等于没有发生事，读者会觉得"水"。`
      : '每章都有转折，密度够了。接下来看转折够不够狠——小转折不算。',
    dialog: d < 8
      ? `对话只占 ${d}%，几乎全靠叙述推进。网文读者耐性低，把设定改写成两个人吵架。`
      : d > 45
        ? `对话占 ${d}%，偏高。叙述太少会让场景不落地，补环境和一个动作。`
        : `对话占 ${d}%，比例健康。`
  };

  return {
    total, S, avgLen, rows, stats,
    chapters: rows.length,
    chars: content.length,
    opening: { names: nm, actions: act, sys, dlgPos, firstType, first },
    flat, noTurn, noPeak,
    advice
  };
}

export function checkupHTML(book, ck, ref) {
  const items = [
    ['opening', '开篇留人'],
    ['chapter', '章节长度'],
    ['hook', '章末钩子'],
    ['rhythm', '转折与爽点'],
    ['dialog', '对话比例']
  ];

  const level = ck.total >= 80 ? '能签' : ck.total >= 62 ? '修改后可签' : '问题比较多';
  const levelCls = ck.total >= 80 ? 'good' : ck.total >= 62 ? 'mid' : 'bad';

  const worst = items
    .map(([k, n]) => ({ k, n, v: ck.S[k] }))
    .sort((a, b) => a.v - b.v)
    .slice(0, 3);

  const hookStat = ck.rows.reduce((m, r) => {
    m[r.hook.type] = (m[r.hook.type] || 0) + 1;
    return m;
  }, {});
  const hookLine = Object.entries(hookStat).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(' · ');

  const cols = ['#b98a5a', '#8a9a7b', '#7b8a9a', '#9a7b8a', '#8a8a7b'];

  return `
  <div class="ck-hero ${levelCls}">
    <div class="ck-score"><b>${ck.total}</b><span>/ 100</span></div>
    <div class="ck-hero-text">
      <strong>${level}</strong>
      <p>${ck.chapters} 章 · ${ck.chars >= 10000 ? (ck.chars / 10000).toFixed(1) + ' 万字' : ck.chars + ' 字'} · 平均 ${ck.avgLen} 字/章</p>
    </div>
  </div>

  <div class="ck-bars">
    ${items.map(([k, n], i) => `
      <div class="ck-bar-row">
        <span class="ck-bar-name">${n}</span>
        <span class="ck-bar-track"><i style="width:${ck.S[k] * 5}%;background:${cols[i]}"></i></span>
        <span class="ck-bar-val">${ck.S[k]}</span>
      </div>`).join('')}
  </div>

  ${ref ? `
  <h3>和《${escapeHtml(ref.title)}》比</h3>
  <div class="ck-cmp">
    ${items.map(([k, n]) => `
      <div class="ck-cmp-row">
        <span class="ck-cmp-name">${n}</span>
        <span class="ck-cmp-track"><i class="mine" style="width:${ck.S[k] * 5}%"></i><i class="theirs" style="width:${ref.S[k] * 5}%"></i></span>
        <span class="ck-cmp-num">${ck.S[k]} <em>/ ${ref.S[k]}</em></span>
      </div>`).join('')}
    <p class="ck-cmp-legend"><i class="mine"></i>我的稿 <i class="theirs"></i>参照书</p>
  </div>` : ''}

  <h3>最该改的三处</h3>
  <ol class="ck-fix">
    ${worst.map(w => `<li><b>${w.n} · ${w.v}/20</b><p>${ck.advice[w.k]}</p></li>`).join('')}
  </ol>

  <h3>开篇 500 字</h3>
  <p class="ck-open">第一句是<b>${ck.opening.firstType}</b>；500 字内 ${ck.opening.names} 个人名、${ck.opening.actions} 组动作词、${ck.opening.sys} 个设定词；对话出现在第 <b>${ck.opening.dlgPos < 0 ? '没有出现' : ck.opening.dlgPos + ' 字'}</b>。</p>

  <h3>章末钩子</h3>
  <p class="ck-hook-line">${hookLine}</p>
  <div class="hook-strip">
    ${ck.rows.slice(0, 40).map(r => `<span class="hook-cell h-${r.hook.score >= 2.5 ? 'a' : r.hook.score >= 1.5 ? 'b' : 'c'}" title="第${r.i + 1}章 · ${r.hook.type}">${r.i + 1}</span>`).join('')}
  </div>
  <p class="ck-hint">格子里是章号，颜色越深钩子越强。连着三格浅色，读者就会走。</p>

  <h3>节奏表</h3>
  <table class="ck-table">
    <thead><tr><th>章</th><th>字数</th><th>转折</th><th>爽点</th><th>章末</th></tr></thead>
    <tbody>
      ${ck.rows.slice(0, 30).map(r => `<tr>
        <td>${r.i + 1}</td><td>${r.chars}</td>
        <td class="${r.turns ? '' : 'zero'}">${r.turns}</td>
        <td class="${r.peaks ? '' : 'zero'}">${r.peaks}</td>
        <td>${r.hook.type}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${ck.rows.length > 30 ? `<p class="ck-hint">只显示前 30 章，共 ${ck.rows.length} 章。</p>` : ''}
  `;
}

export function promptReview(book, digest, ck, stats) {
  return [
    { role: 'system', content: SYS + '\n7. 你是网络小说编辑，正在给作者写审稿意见。只写能执行的，不写赏析，不说客气话。' },
    {
      role: 'user', content: `这是我的稿件：${bookMeta(book)}

【机器体检】
- ${ck.chapters} 章，平均 ${ck.avgLen} 字/章
- 开篇 500 字：${ck.opening.names} 个人名，${ck.opening.actions} 组动作词，${ck.opening.sys} 个设定词；对话出现在第 ${ck.opening.dlgPos < 0 ? '（没有）' : ck.opening.dlgPos} 字；第一句是${ck.opening.firstType}
- 章末钩子：${ck.rows.map(r => r.hook.type).slice(0, 10).join('、')}
- 没有转折的章：${ck.noTurn} 章；没有爽点的章：${ck.noPeak} 章；平收结尾：${ck.flat} 章
- 对话占 ${stats.dialoguePct}%，平均句长 ${stats.avg} 字

【章节开头】
${digest}

用 Markdown 写审稿单，全文不超过 600 字：

### 能不能签
一句话给结论（能签 / 修改后可签 / 不建议签），加一个理由。

### 三个必须改的地方
每条一行：第几章 + 什么问题 + 改成什么。只写三条，写最致命的。

### 这周就做的一件事
一个今天能开始的具体动作。` }
  ];
}

/** 把具体词挖空，变成可填的句式模板 */
export function blankTemplate(text) {
  let out = text;
  const hits = [...WORD2CAT.keys()].filter(w => out.includes(w)).sort((a, b) => b.length - a.length);
  for (const w of hits.slice(0, 8)) out = out.split(w).join('＿＿');
  return out;
}


/* ══════════ 一句三写 ══════════ */

const SCENE_HINT = {
  action: ['一次推搡', '推门进屋', '被人从背后拉住', '把杯子重重放下'],
  face: ['听见坏消息的那一刻', '被当面戳穿的时候', '看见熟人却不想打招呼'],
  sense: ['手被烫到', '跑完一段路', '站在高处往下看', '从噩梦里醒来'],
  mood: ['一间久没人住的屋子', '凌晨的街道', '雨刚停的院子', '关了灯的走廊'],
  beat: ['一句话说不出口', '对方沉默之后', '吵架吵到一半停住'],
  system: ['第一次看见属性面板', '规则第一次生效', '进入一个新副本']
};

const KIND_CN = { action: '动作', face: '神态', sense: '生理', beat: '对话', mood: '氛围', system: '设定', mix: '综合' };

function pickScene(kind, seed = 0) {
  const arr = SCENE_HINT[kind] || SCENE_HINT.mood;
  return arr[seed % arr.length];
}

/** 给出"同一句话的另一种节奏" */
function variantOf(text, mode) {
  const t = text.replace(/\s+/g, '');
  if (mode === 'split') {
    const parts = t.split(/[，、；]/).map(x => x.trim()).filter(x => x.length >= 3);
    if (parts.length < 2) return '';
    const size = Math.ceil(parts.length / 3);       // 最多切成三下
    const groups = [];
    for (let i = 0; i < parts.length; i += size) {
      groups.push(parts.slice(i, i + size).join('，'));
    }
    return groups.map(x => x.replace(/[。！？…]+$/, '') + '。').join('');
  }
  if (mode === 'join') {
    const parts = t.split(/[。！？]/).map(x => x.trim()).filter(x => x.length >= 4);
    if (parts.length < 2 || parts.length > 4) return '';
    return parts.join('，') + '。';
  }
  if (mode === 'strip') {
    const out = t.replace(/[^“”"，。！？；]{0,10}?(说道|问道|答道|笑道|叫道|喝道|道)[：:]/g, '')
      .replace(/”“/g, '” “');
    return out !== t && out.trim().length >= 6 ? out.trim() : '';
  }
  return '';
}

/** 填空：挖掉具体的物，留句法 */
function fillBlank(text) {
  let out = text;
  const pools = ['mood', 'action', 'face', 'sense'];
  const hits = [];
  for (const [w, k] of WORD2CAT) {
    if (w.length < 2) continue;                     // 单字不挖，"陪笑"会被挖成"陪＿"
    if (pools.includes(k) && out.includes(w)) hits.push([w, k]);
  }
  hits.sort((a, b) => b[0].length - a[0].length);

  let n = 0;
  for (const [w] of hits) {
    if (n >= 2) break;
    out = out.split(w).join('＿＿');
    n++;
  }

  // 没挖到具体词，就截掉后半句，留一个空让作者接
  if (out === text) {
    const cut = text.slice(0, Math.floor(text.length * 0.55));
    const idx = cut.lastIndexOf('，');
    out = (idx > 10 ? text.slice(0, idx) : cut) + '，＿＿＿＿＿＿。';
  }
  return out;
}

function diffOf(mode, original, variant) {
  if (mode === 'long') {
    const n = (variant.match(/。/g) || []).length;
    return `原来是 ${original.length} 字一口气，现在切成 ${n} 句。句子短了，镜头推进变快。`;
  }
  if (mode === 'short') {
    return '三句并成一句。气息不断，适合写压着走的长镜头。';
  }
  if (mode === 'talk') {
    return '去掉提示语，两句对白直接撞在一起。谁说的，交给动作去交代。';
  }
  return '';
}

/** 从全文里找最能体现某个维度的句子 */
function pickExample(content, mode) {
  const sample = sampleText(content, 200000);
  const sents = sample.split(/(?<=[。！？…])/).map(x => x.trim()).filter(x => x.length >= 12 && x.length <= 120);

  if (mode === 'long') {
    const c = sents.filter(x => x.length >= 38 && !/[“”"]/.test(x)).sort((a, b) => b.length - a.length);
    return c[0] || '';
  }
  if (mode === 'short') {
    for (let i = 0; i < sents.length - 2; i++) {
      const three = sents.slice(i, i + 3);
      if (three.every(x => x.length <= 16) && three.every(x => !/[“”"]/.test(x))) {
        return three.join('');
      }
    }
    return '';
  }
  if (mode === 'talk') {
    // 取整段（引号内的句号会把句子切碎），要求引号成对
    const paras = sample.split('\n').map(x => x.trim())
      .filter(x => x.length >= 16 && x.length <= 90)
      .filter(x => (x.match(/“/g) || []).length === (x.match(/”/g) || []).length && /[“”]/.test(x))
      .filter(x => /(说道|问道|笑道|道[:：])/.test(x));
    return paras[0] || '';
  }
  if (mode === 'describe') {
    const paras = sample.split('\n').map(x => x.trim())
      .filter(x => x.length >= 28 && x.length <= 110 && !/[“”"]/.test(x));
    return paras[0] || '';
  }
  return '';
}

/**
 * 三个动作：每个都有"场景 → 它怎么写 → 换个写法 → 你来"
 */
export function actionCards(content, dx) {
  const out = [];

  for (const d of dx.slice(0, 3)) {
    const f = d.fact;
    let mode = '', kind = 'mix', title = '', tryIt = '';

    if (/平均句长|长句/.test(f) && /偏长|长句占/.test(f)) {
      mode = 'long'; kind = 'action';
      title = '一句话说完了，读者喘不过气';
      tryIt = '把同一个动作拆成三句，每句一个动作。';
    } else if (/短句/.test(f)) {
      mode = 'short'; kind = 'action';
      title = '句子太碎，读起来像在数拍子';
      tryIt = '把三句合成一句，中间只用逗号。';
    } else if (/对话|说道|问道/.test(f)) {
      mode = 'talk'; kind = 'beat';
      title = '每句对话后面都挂着"他说"';
      tryIt = '删掉提示语，换成他在做的动作。';
    } else {
      continue;   // 演示不了的不硬凑
    }

    const ex = pickExample(content, mode);
    if (!ex) continue;

    const variant = mode === 'long' ? variantOf(ex, 'split')
      : mode === 'short' ? variantOf(ex, 'join')
      : mode === 'talk' ? variantOf(ex, 'strip')
      : '';

    out.push({
      title,
      fact: f,
      mean: d.mean,
      original: ex,
      variant: variant && variant !== ex ? variant : '',
      diff: variant && variant !== ex ? diffOf(mode, ex, variant) : '',
      blank: mode === 'talk' ? '' : fillBlank(ex),
      scene: pickScene(kind, out.length),
      todo: tryIt
    });
  }

  return out;
}

export function actionCardsHTML(cards) {
  if (!cards.length) return '';
  return `
  <h3>${cards.length} 个动作</h3>
  <p style="font-size:11px;color:var(--ink-3)">每个动作都从这本书里取一句真话。看它怎么处理，再换一种写法，最后留一个空给你填。</p>
  ${cards.map((c, i) => `
    <div class="act-card">
      <div class="act-head"><span class="act-no">${i + 1}</span>${escapeHtml(c.title)}</div>
      <p class="act-mean">${escapeHtml(c.mean)}</p>

      <div class="act-block">
        <span class="act-label">它这样写</span>
        <p class="act-line">${escapeHtml(c.original)}</p>
      </div>

      ${c.variant ? `
      <div class="act-block">
        <span class="act-label alt">换一种写法</span>
        <p class="act-line alt">${escapeHtml(c.variant)}</p>
        ${c.diff ? `<p class="act-diff">${escapeHtml(c.diff)}</p>` : ''}
      </div>` : ''}

      <div class="act-block">
        <span class="act-label mine">你来 · ${escapeHtml(c.scene)}</span>
        <p class="act-fill${c.blank ? '' : ' blank'}">${c.blank ? escapeHtml(c.blank) : '＿＿＿＿＿＿＿＿＿＿＿＿＿＿<br><i>写一句对白，不加"他说"，让动作替他开口</i>'}</p>
      </div>

      <p class="act-todo">${escapeHtml(c.todo)}</p>
    </div>`).join('')}`;
}


/* ══════════ 拆书：情节 · 人物 · 段落功能 ══════════ */

const WIN_RE = /赢|赢下|成功|得手|拿到|夺回|制服|压住|打退|击退|杀了|救下|通过|过关|升级|突破|签下|答应/;
const LOSE_RE = /输|败|倒下|被抓|失去|失败|跪|逃|退|放弃|认输|吐血|重伤|死了|断气/;

// 只有"改变局面"的动作才算事件，"看""说""走"不算
const MOVE_RE = /打|杀|抓|救|抢|夺|扔|摔|砸|撞|推倒|拔出|砍|刺|踢|签|撕|烧|炸|砸开|踹开|冲进|逃出|带走|交给|拿出|抢走|跪下|抱住|推开|拉住|按|掐|绑|拷|擒|射|开火|引爆|砸碎|掀翻|捅|抽刀|拔枪|动手|出手|抱住|扯|拽|拖|勒/;
const SCENE_RE = /次日|第二日|当晚|当夜|那日|这日|一路|回到|来到|走进|出了|进了|到了|此时|却说|且说|话说|半晌|片刻|不多时|过了|后来/g;

/** 事件 = 有动作的句子（折算）+ 场景切换 */
function countEvents(text) {
  const sents = text.split(/[。！？…]/).filter(x => x.trim().length >= 5);
  let acts = 0;
  for (const s of sents) {
    if (MOVE_RE.test(s)) acts++;
    MOVE_RE.lastIndex = 0;
  }
  const scenes = (text.match(SCENE_RE) || []).length;
  return Math.max(1, Math.round(acts * 0.55 + scenes * 1.2));
}

/** 冲突强度：对抗性标记 / 段落 */
function conflictOf(text) {
  const paras = text.split('\n').filter(x => x.trim().length > 6);
  if (!paras.length) return { level: '弱', score: 0 };
  const ADV = /不|没|别|敢|凭什么|给我|滚|站住|闭嘴|放下|谁|凭什么|休想|拦住|挡住|抢|夺|逼|质问|冷笑|威胁/g;
  let hit = 0;
  for (const p of paras) {
    if (ADV.test(p)) hit++;
    ADV.lastIndex = 0;
  }
  const s = hit / paras.length;
  return { level: s >= 0.5 ? '强' : s >= 0.28 ? '中' : '弱', score: s };
}

/** 段落功能四类：推进 / 塑造 / 装饰 / 说明 */
function classifyPara(p) {
  const hasTalk = /[“”"]/.test(p);
  const act = countCraft(p, 'action') + (MOVE_RE.test(p) ? 1 : 0);
  const face = countCraft(p, 'face') + countCraft(p, 'sense');
  const mood = countCraft(p, 'mood');
  const sys = countCraft(p, 'system');

  if (sys >= 2 && act === 0) return 'info';
  if (act >= 1 || hasTalk) return 'push';
  if (face >= 1) return 'shape';
  if (mood >= 2) return 'deco';
  return 'shape';
}

export function paraKinds(text) {
  return text.split('\n').map(x => x.trim()).filter(x => x.length >= 8).map(classifyPara);
}

export function paraFunction(text) {
  const paras = text.split('\n').map(x => x.trim()).filter(x => x.length >= 8);
  const acc = { push: 0, shape: 0, deco: 0, info: 0 };
  let total = 0;
  for (const p of paras) {
    const len = p.length;
    total += len;
    acc[classifyPara(p)] += len;
  }
  const pct = {};
  for (const k of Object.keys(acc)) pct[k] = total ? Math.round(acc[k] / total * 100) : 0;
  return { pct, total };
}

const PLACE_TAIL = /(门|街|巷|院|园|府|城|山|村|镇|宫|殿|寺|楼|阁|庄|州|县|关|谷|崖|洞|岛|房|屋|室|堂|厅)$/;
const NAME_TAIL = /[子儿头们个些么样边面里外上中下间道说看想人了着的过而来之其所以者也矣焉哉不没很太更最名大小爷娘叔伯婶婆娘缝墙桥桌椅床灯窗门路车船刀剑书纸茶酒饭鞋帽鸟狗猫]/;
const NAME_BAD2 = /^(吐血|流血|出血|说话|开口|回答|抬头|低头|点头|摇头|转身|后退|上前|站起|坐下|走过|看到|看见|笑了|哭了|皱眉|伸手|拿起|推开|拉住|一把|忽然|已经|还在|不知|不敢|不能|不会|心中|心里|脸色|眼神|声音|手里|身上|身后|面前|脚下|眼中|嘴角|肩膀|没有)$/;

const SURNAME = '李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文甄史宋';

/** 人物名：姓氏模式 + 叙述标签，两路合并 */
function castNames(content, book) {
  const sample = sampleText(content, 400000);
  const counts = new Map();
  const bump = (w) => counts.set(w, (counts.get(w) || 0) + 1);
  const usable = (w) => w.length >= 2 && w.length <= 3
    && !PLACE_TAIL.test(w) && !NAME_TAIL.test(w[w.length - 1] || '')
    && !NOT_NAME.test(w) && !WORD2CAT.has(w)
    && !(w.length === 3 && NAME_BAD2.test(w.slice(1)));

  // 姓氏 + 1-2 字，后面必须是标点或动作（避免"林子里"）
  const re = new RegExp(
    `([${SURNAME}][\\u4e00-\\u9fa5]{1,2}?)(?=[，。！？、；：“”"\\s]|说|道|问|答|站|走|看|转|抬|低|笑|哭|皱|点|摇|伸|拿|推|拉|坐|起|进|出|跑|停|愣|蹲|跪|盯|把|从|向|对|给|和|跟|搬|握|靠|扶|低|按|塞|掏|摸|抬|领|带|跟)`,
    'g'
  );
  let m, guard = 0;
  while ((m = re.exec(sample)) !== null && guard++ < 40000) {
    if (usable(m[1])) bump(m[1]);
  }

  // 章节标题是主要人物的强信号（"林黛玉抛父进京都"）
  for (const c of (book?.chapters || [])) {
    const t = (c.title || '').replace(/^第[一二三四五六七八九十百零\d]+[回章节卷]\s*/, '');
    const reT = new RegExp(`([${SURNAME}][\\u4e00-\\u9fa5]{1,2})`, 'g');
    let mm;
    while ((mm = reT.exec(t)) !== null) {
      const w = mm[1];
      if (!usable(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 5);
    }
  }

  // 叙述标签补充（"黛玉想道"这种没有姓氏的）
  for (const w of detectNames(content, book)) {
    if (usable(w)) counts.set(w, (counts.get(w) || 0) + 3);
  }

  // 前缀合并："林夏调"并到"林夏"，否则同一个名字被拆成几份，都不到阈值
  const list = [...counts.entries()].sort((a, b) => b[0].length - a[0].length);
  const merged = new Map();
  for (const [w, c] of list) {
    const shorter = list.find(([x]) => x !== w && x.length >= 2 && w.startsWith(x));
    const key = shorter ? shorter[0] : w;
    merged.set(key, (merged.get(key) || 0) + c);
  }

  const minC = sample.length < 3000 ? 1 : 2;
  return [...merged.entries()]
    .filter(([w, c]) => c >= minC && usable(w))
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, 8);
}

/** 人物表：谁在第几章出现、戏份多少 */
export function characterTable(book, content) {
  const names = castNames(content, book);
  if (!names.length) return { rows: [], lead: null, absent: [] };

  const rows = names.map((n) => {
    const chapters = [];
    let total = 0;
    book.chapters.forEach((c, i) => {
      const t = content.slice(c.start, c.end);
      const cnt = t.split(n).length - 1;
      if (cnt > 0) chapters.push(i + 1);
      total += cnt;
    });
    return { name: n, first: chapters[0] || 0, last: chapters[chapters.length - 1] || 0, chapters: chapters.length, total };
  }).filter(r => r.chapters > 0);

  const sum = rows.reduce((a, r) => a + r.total, 0) || 1;
  rows.forEach(r => { r.share = Math.round(r.total / sum * 100); });
  rows.sort((a, b) => b.chapters - a.chapters || b.total - a.total);

  const lead = rows[0] || null;
  const absent = lead
    ? book.chapters
        .map((c, i) => ({ c, n: i + 1 }))
        .filter(x => !content.slice(x.c.start, x.c.end).includes(lead.name))
        .map(x => x.n)
    : [];

  return { rows: rows.slice(0, 12), lead, absent };
}

function chapterHas(content, book, chapter, name) {
  return content.slice(chapter.start, chapter.end).includes(name);
}

/** 每章一行：事件、冲突、结果、钩子、风险 */
export function plotRows(book, content) {
  return book.chapters.map((c, i) => {
    const t = content.slice(c.start, c.end);
    const events = countEvents(t);
    const turns = (t.match(TURN_RE) || []).length;
    const win = (t.match(WIN_RE) || []).length;
    const lose = (t.match(LOSE_RE) || []).length;
    const hook = hookOf(t);
    const cf = conflictOf(t);

    const out = win > lose ? '赢' : lose > win ? '输' : '平';
    const tail = (t.trim().match(/[^。！？…\n]{4,40}[。！？…]\s*$/) || [''])[0].trim();
    return {
      i, title: c.title, chars: t.length, tail,
      events, turns, win, lose, out,
      hook, conflict: cf.level,
      density: t.length ? events / t.length * 1000 : 0
    };
  });
}

/* 前后置内容不算正文，不参与节奏评分（否则序言必被当"水章"） */
export function isMatter(ch) { return !!ch && (ch.matter === 'pre' || ch.matter === 'post'); }
export function isWaterEligible(ch) { return !!ch && ch.matter !== 'pre' && ch.matter !== 'post' && ch.matter !== 'open'; }

function median(arr) {
  const a = (arr || []).filter(x => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 风险分：阈值相对本书中位数，避免快/慢书系统性失灵 */
export function riskOf(r, medChars, medDensity) {
  let s = 0;
  const dCut = Math.max(1.2, (medDensity || 0) * 0.5);
  if (r.density < dCut) s += 2;
  if (r.turns === 0) s += 2;
  if (r.hook.score <= 1) s += 2;
  if (r.chars < (medChars || r.chars) * 0.6) s += 1;
  if (r.conflict === '弱') s += 1;
  return s;
}

/** 三视角：同一件事，作者 / 编辑 / 读者各怎么看 */
export function threeViews(r, kind) {
  if (kind === 'water') {
    return [
      `这章只有 ${r.events} 个事件、${r.chars} 字，可以并进上一章，省 ${Math.max(600, Math.round(r.chars * 0.4))} 字。`,
      `第 ${r.i + 1} 章事件太少，是流失点。`,
      `${r.chars} 字里只发生 ${r.events} 件事，我会觉得水。`
    ];
  }
  if (kind === 'flat') {
    return [
      `结尾「${(r.tail || '').length > 26 ? r.tail.slice(0, 26) + '…' : (r.tail || '最后一句')}」太平。改成问句，或让动作停在半空。`,
      `第 ${r.i + 1} 章章末平收，追更率会掉。`,
      `看到结尾那句，我没有点下一章的理由。`
    ];
  }
  if (kind === 'weak') {
    return [
      `这章${r.conflict}冲突，没有人在反对主角 ${r.events} 个事件里。给一个明确的阻力。`,
      `第 ${r.i + 1} 章冲突偏弱，张力不够。`,
      '看完这章，我说不出谁在跟谁较劲。'
    ];
  }
  if (kind === 'absent') {
    return [
      '配角的戏压到 800 字以内，或者让主角在旁边看着。',
      '主角缺席一整章，追更读者会以为你换主角了。',
      '我等的那个主角呢？'
    ];
  }
  return ['', '', ''];
}

export function pickViews(r) {
  return [
    `第 ${r.i + 1} 章 ${r.events} 个事件、${r.turns} 次转折，${r.conflict}冲突收在「${r.hook.type}」上，整章可以照着学。`,
    `全书的记忆点：读者为这一章点收藏、发弹幕。`,
    `${r.out === '赢' ? '主角终于扬眉吐气' : '局面被狠狠翻了一下'}，读到这我会倒回去再刷一遍。`
  ];
}


/* ══════════ 一句话核心梗 · 结构层级 ══════════
 * 拆书的第一步不是数事件，是先把骨架说出来。
 * 一句话要同时含"开始 / 转折 / 结束"——缺一段，说明它还是个设定，不是一个故事。
 */

export function parseCore(md) {
  const m = md.match(/###\s*核心梗\s*\n([\s\S]*?)(?=\n###\s|$)/);
  if (!m) return null;
  const body = m[1];
  const pick = (label) => {
    const r = body.match(new RegExp(label + "[：:]\\s*([^\\n]+)"));
    return r ? r[1].trim() : "";
  };
  const clean = (s) => s
    .replace(/^[「“"']+|[」”"']+$/g, "")
    .replace(/^[-—*\s]+/, "")
    .replace(/\*\*/g, "")
    .trim();
  const sentence = clean(pick("一句话"));
  const start = clean(pick("开始"));
  const turn = clean(pick("转折"));
  const end = clean(pick("结束"));
  return { sentence, start, turn, end };
}

export function coreChecks(c) {
  const s = c.sentence || "";
  // "开始"没法靠词表判断，只看首句有没有立起一个处境；转折和结束有明确词面。
  const head = (s.split(/[，,。；;：:]/)[0] || "").trim();
  const startOk = !!c.start || (head.length >= 4 && !/最终|终于|成为|结局/.test(head));
  const turnOk = !!(c.turn || /却|但|不料|谁知|然而|竟|偏偏|于是|从此|因为|等到|直到/.test(s));
  const endOk = !!(c.end || /最终|终于|成为|踏上|走上|登顶|巅峰|结局|统一|复仇|封神|称霸|活下来/.test(s));
  return { startOk, turnOk, endOk, len: s.length, long: s.length > 48 };
}

export function coreHint(c, pending = false, offline = false, mismatch = false) {
  const ck = coreChecks(c);
  if (pending) return '正在从全书的开头、转折和结局里提炼…';
  if (!c.sentence) {
    if (offline) return '还没接入模型。先自己写一版：谁，原本怎样，因为什么，最后成了什么。';
    if (mismatch) return '模型这次没按格式给一句话。照"谁、原本怎样、因为什么、最后成了什么"自己写一版。';
    return '模型没有给出可用的一句话。按"谁、原本怎样、因为什么、最后成了什么"自己写一版。';
  }
  if (ck.long) return `已经 ${ck.len} 字。压到 40 字以内：只留一个人、一件事、一个结果。`;
  if (!ck.turnOk) return '缺“转折”。一句话里要有一个“却 / 不料 / 于是”，把故事拐个弯。';
  if (!ck.endOk) return '缺“结束”。说清他最后成了什么，读者才知道往哪追。';
  return '这句话是全书的锚点。改它，等于改骨架——先在这里改，再往下看。';
}

export function coreCardHTML(c, opt = {}) {
  const ck = coreChecks(c);
  const ignored = !!opt.ignored;
  const chip = (name, ok, tip) =>
    `<span class="ck-chip ${ignored ? 'off' : (ok ? 'ok' : 'no')}" title="${tip}">${ignored ? '·' : (ok ? '✓' : '✕')} ${name}</span>`;
  const hint = ignored
    ? '校验已关闭。点「重新校验」恢复。'
    : coreHint(c, !!opt.pending, !!opt.offline, !!opt.mismatch);
  return `<div class="core-card${opt.pending ? ' pending' : ''}" id="coreCard">
  <div class="core-top">
    <span class="core-label">一句话核心梗</span>
    <span class="core-len${ck.long ? ' over' : ''}">${ck.len} 字</span>
  </div>
  <div class="core-sent" contenteditable="true" spellcheck="false" data-core-edit data-ph="谁，原本怎样，因为什么，最后成了什么">${escapeHtml(c.sentence || '')}</div>
  <div class="core-checks">
    ${chip('开始', ck.startOk, '有没有一个具体的人，和一个具体的处境')}
    ${chip('转折', ck.turnOk, '有没有一件事，把他推到另一条路上')}
    ${chip('结束', ck.endOk, '有没有一个终局状态')}
    <button class="mini-btn core-copy" data-copy-core>复制</button>
    <button class="mini-btn core-ignore" data-core-ignore>${ignored ? '重新校验' : '忽略校验'}</button>
  </div>
  <p class="core-hint">${hint}</p>
</div>`;
}

export function parseVolTable(md) {
  const m = md.match(/###\s*结构层级\s*\n([\s\S]*?)(?=\n###\s|$)/);
  if (!m) return null;
  const lines = m[1].split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
  if (lines.length < 3) return null;
  const rows = lines
    .filter(l => !/^\|[\s\-:|]+\|?$/.test(l))
    .map(l => l.replace(/^\||\|$/g, "").split("|").map(s => s.replace(/\*\*/g, "").trim()));
  const body = rows.slice(1).filter(r => r.some(Boolean));
  return body.length ? body : null;
}

export function volTableHTML(rows, local = false) {
  if (!rows || !rows.length) return "";
  if (local) {
    return `<div class="vol-wrap"><table class="ck-table vol-table local">
  <thead><tr><th>阶段</th><th>章</th><th>字数</th><th>事件</th><th>净胜负</th></tr></thead>
  <tbody>${rows.map(v => `<tr>
    <td>${v.i + 1}</td><td>${v.from}–${v.to}</td>
    <td>${(v.chars / 1000).toFixed(1)}k</td><td>${v.events}</td>
    <td>${v.win > v.lose ? '赢' : v.lose > v.win ? '输' : '平'}</td>
  </tr>`).join("")}</tbody>
</table></div>
<p class="ck-hint">原书没有分卷标记，这是按事件密度自动切的。接了模型后，会换成带“拿到什么 / 失去什么”的版本。</p>`;
  }
  const body = rows.map(r => `<tr>${[0, 1, 2, 3, 4]
    .map(i => `<td>${escapeHtml(r[i] || "")}</td>`).join("")}</tr>`).join("");
  const cards = rows.map(r => `<div class="vol-card">
    <div class="vol-card-head"><b>${escapeHtml(r[0] || "")}卷</b><span>${escapeHtml(r[1] || "")} 章</span></div>
    <p><i>拿到</i>${escapeHtml(r[2] || "—")}</p>
    <p><i>失去</i>${escapeHtml(r[3] || "—")}</p>
    <p><i>卷末</i>${escapeHtml(r[4] || "—")}</p>
  </div>`).join("");
  return `<div class="vol-wrap"><table class="ck-table vol-table">
  <thead><tr><th>卷</th><th>章</th><th>拿到</th><th>失去</th><th>卷末变化</th></tr></thead>
  <tbody>${body}</tbody>
</table></div>
<div class="vol-cards">${cards}</div>`;
}

/** 没有模型时的分卷：优先认"第 X 卷/部/篇"，否则按事件密度切。 */
export function localVolumes(book, content) {
  const rows = plotRows(book, content);
  const n = rows.length;
  if (!n) return [];

  const marks = [];
  book.chapters.forEach((c, i) => {
    if (i && /第[一二三四五六七八九十百零〇\d]+[卷部篇]/.test(c.title)) marks.push(i);
  });

  let cuts = [];
  if (marks.length >= 2) {
    cuts = [...new Set([0, ...marks])].sort((a, b) => a - b).concat([n]);
  } else {
    const vols = Math.max(2, Math.min(6, Math.round(n / 26)));
    const target = n / vols;
    cuts = [0];
    for (let k = 1; k < vols; k++) {
      const center = Math.round(target * k);
      let best = center, bestScore = -1;
      for (let i = Math.max(1, center - 4); i <= Math.min(n - 2, center + 4); i++) {
        const sc = rows[i].events + rows[i].turns * 2 + (rows[i].hook.score >= 2.4 ? 1 : 0)
          - Math.abs(i - center) * 0.6;
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best > cuts[cuts.length - 1]) cuts.push(best);
    }
    cuts.push(n);
  }

  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k + 1] - 1;
    if (b < a) continue;
    const seg = rows.slice(a, b + 1);
    out.push({
      i: out.length,
      from: a + 1, to: b + 1,
      chars: seg.reduce((x, r) => x + r.chars, 0),
      events: seg.reduce((x, r) => x + r.events, 0),
      win: seg.reduce((x, r) => x + r.win, 0),
      lose: seg.reduce((x, r) => x + r.lose, 0)
    });
  }
  return out;
}

/** 去掉已单独渲染的两段，模型正文从"能不能当模板"开始。 */
export function tailFromAnalysis(md) {
  for (const k of ["### 一句话判断", "### 不能动的三件事", "### 能不能当模板", "### 主线是怎么推的"]) {
    const i = md.indexOf(k);
    if (i >= 0) return md.slice(i);
  }
  return "";
}

/* ══════════ 开篇三章 · 情绪曲线 ══════════
 * 开篇看的是"读者会不会走"，情绪看的是"走了之后会不会回来"。
 * 两者都只能给信号，不能给分数。
 */

const CONFLICT_RE = /打|抢|夺|骂|吼|逼|威胁|抓|杀|砸|踹|退婚|羞辱|嘲|赶|撵|闯|追|逃|拦|摔|掀|争|吵|拒/;
const SETTING_RE = /系统|灵气|斗气|境界|等级|位面|大陆|宗门|家族|法则|天赋|血脉|面板|属性|修为|功法|丹药|灵石/g;
const OPEN_HEAD = /^(天|夜色|阳光|雨|风|雪|晨|黄昏|傍晚|清晨|午后|月光|夕阳)/;

export function openingCheck(book, content) {
  const names = castNames(content, book).slice(0, 6);
  const all = book.chapters;
  let idxs = all.map((c, i) => (isMatter(c) ? -1 : i)).filter(i => i >= 0).slice(0, 3);
  if (!idxs.length) idxs = all.slice(0, 3).map((c, i) => i);

  return idxs.map((ci) => {
    const c = all[ci];
    const i = ci;
    const t = content.slice(c.start, c.end);
    const body = t.replace(/^\s*第[^\n]{0,40}\n+/, "");
    const head = body.slice(0, 600);
    const first = (body.split(/[。！？…]/)[0] || "").trim().slice(0, 26);

    const type = /^[“"]/.test(first) ? "对话"
      : OPEN_HEAD.test(first) ? "天气/时间"
      : MOVE_RE.test(first) ? "动作"
      : /想|觉得|记得|知道|心中|心念/.test(first) ? "心理"
      : "叙述";

    const dlg = body.search(/[“"]/);
    const hit = names.map(n => body.indexOf(n)).filter(x => x >= 0);
    const namePos = hit.length ? Math.min(...hit) : -1;
    const namesIn600 = names.filter(n => head.includes(n)).length;
    const conflict = body.search(CONFLICT_RE);
    const info = paraFunction(t).pct.info;
    const setting = (t.match(SETTING_RE) || []).length;

    return {
      i: i + 1, title: c.title, chars: t.length,
      first, type, dlg, namePos, namesIn600, conflict, info, setting,
      events: countEvents(t), hook: hookOf(t)
    };
  });
}

export function openingHTML(book, content) {
  const rows = openingCheck(book, content);
  if (!rows.length) return "";

  const issues = [];
  rows.forEach(r => {
    if (r.type === "天气/时间") issues.push([`第 ${r.i} 章第一句在写天气或时间`, "删掉，直接从人正在做的事开始。"]);
    if (r.dlg < 0) issues.push([`第 ${r.i} 章前 600 字没有一句对话`, "让人物在第 200 字内开口，哪怕只说半句。"]);
    else if (r.dlg > 400) issues.push([`第 ${r.i} 章第 ${r.dlg} 字才有人说话`, "对话往前提，开篇靠人声接力。"]);
    if (r.conflict < 0) issues.push([`第 ${r.i} 章 600 字内找不到一次冲突`, "开篇要有人挡路：抢、拦、逼、拒，随便一个。"]);
    else if (r.conflict > 800) issues.push([`第 ${r.i} 章第一处冲突在第 ${r.conflict} 字`, "网文一般要在 300 字内让人不舒服。"]);
    if (r.info >= 15) issues.push([`第 ${r.i} 章说明段占 ${r.info}%`, "在讲设定。把设定拆进动作和对话里。"]);
    if (r.setting >= 8) issues.push([`第 ${r.i} 章出现 ${r.setting} 处设定词`, "像在交代世界观。第一章只需要一个具体的麻烦。"]);
    if (r.namesIn600 > 3) issues.push([`第 ${r.i} 章前 600 字出现 ${r.namesIn600} 个人名`, "砍到 3 个以内，其余用“那人”“掌柜”代替。"]);
    if (r.hook.score <= 1) issues.push([`第 ${r.i} 章章末平收`, "留一个没做完的动作，或一句没答的话。"]);
  });

  const cards = rows.map(r => `<div class="op-card">
    <div class="op-head"><b>第 ${r.i} 章</b><span>${r.chars} 字 · ${r.events} 个事件 · 章末${r.hook.type}</span></div>
    <p><i>首句</i>${r.type}　“${escapeHtml(r.first)}”</p>
    <p><i>第一句对话</i>${r.dlg < 0 ? "600 字内没有" : "第 " + r.dlg + " 字"}</p>
    <p><i>首个冲突</i>${r.conflict < 0 ? "没找到" : "第 " + r.conflict + " 字"}</p>
    <p><i>说明段</i>${r.info}%${r.setting ? `　·　设定词 ${r.setting} 处` : ""}</p>
  </div>`).join("");

  const list = issues.length
    ? issues.slice(0, 5).map(([a, b]) => `<li><b>${escapeHtml(a)}</b>${escapeHtml(b)}</li>`).join("")
      + (issues.length > 5 ? `<li class="op-more">还有 ${issues.length - 5} 条，先把前五条改完。</li>` : "")
    : `<li class="op-pass">三章都过线：600 字内有人、有对话、有冲突，章末也都留了钩子。</li>`;

  return `<h3 id="secOpen">黄金三章</h3>
  <p class="ch-hint">读者在前三章决定走不走。这里只查几件事：人有没有出现、有没有人说话、有没有人挡路、有没有停下来讲设定、章末有没有钩子。留不住人，还可以靠一个强印象。</p>
  <div class="op-cards">${cards}</div>
  <ul class="op-issues">${list}</ul>`;
}

const EMO_DEF = [
  { k: "憋屈", cls: "e-bai", re: /羞辱|嘲讽|嘲笑|讥笑|看不起|瞧不起|退婚|受辱|屈辱|憋屈|窝囊|难堪|欺人太甚|欺压|踩在脚下|脸色难看|不甘|羞愤|愤懑|被赶|被撵|被拒|挨打|挨骂|忍气吞声/g },
  { k: "隐忍", cls: "e-yin", re: /隐忍|忍耐|忍住|咬牙|攥紧|握紧|攥着|沉默|没有说话|一言不发|不动声色|压下|按捺|苦练|闭关|修炼|记下|藏起|垂下眼|深吸一口气|等着/g },
  { k: "释放", cls: "e-shi", re: /一拳|一脚|一掌|一刀|一剑|反击|还手|打飞|打倒|打退|砸碎|掀翻|掀桌|爆发|怒吼|咆哮|吐血|跪下|求饶|认输|翻盘|反杀|拔刀|出手|冲上去/g },
  { k: "炫耀", cls: "e-xuan", re: /震惊|哗然|倒吸一口凉气|倒吸一口冷气|目瞪口呆|脸色大变|脸色一变|不敢相信|全场寂静|鸦雀无声|失声|愣住|呆住|众人皆惊|满座皆惊|一片死寂/g }
];

export function emotionRows(book, content) {
  return book.chapters.map((c, i) => {
    const t = content.slice(c.start, c.end);
    const len = Math.max(t.length, 1);
    const scores = EMO_DEF.map(e => (t.match(e.re) || []).length / len * 1000);
    const max = Math.max(...scores);
    const idx = scores.indexOf(max);
    return { i, kind: max >= 0.8 ? EMO_DEF[idx].k : "平", cls: max >= 0.8 ? EMO_DEF[idx].cls : "e-ping", scores };
  }).filter(r => !isMatter(book.chapters[r.i]));
}

export function emotionHTML(book, content) {
  const rows = emotionRows(book, content);
  if (rows.length < 2) return "";

  const count = {};
  rows.forEach(r => { count[r.kind] = (count[r.kind] || 0) + 1; });

  // 连续没有"释放/炫耀"的段
  let run = 0, runStart = 0, worst = { len: 0, from: 0 };
  rows.forEach((r, i) => {
    const flat = r.kind !== "释放" && r.kind !== "炫耀";
    if (flat) {
      if (run === 0) runStart = i;
      run++;
      if (run > worst.len) worst = { len: run, from: runStart };
    } else run = 0;
  });

  // 释放前面没有铺垫
  const cold = [];
  rows.forEach((r, i) => {
    if (r.kind !== "释放") return;
    const prev = rows.slice(Math.max(0, i - 2), i);
    if (!prev.some(x => x.kind === "憋屈" || x.kind === "隐忍")) cold.push(r.i + 1);
  });

  const strip = rows.slice(0, 80).map(r =>
    `<span class="emo-cell ${r.cls}" data-goto-at="${book.chapters[r.i].start}" title="第 ${r.i + 1} 章 · ${r.kind}（憋屈 ${r.scores[0].toFixed(1)} / 隐忍 ${r.scores[1].toFixed(1)} / 释放 ${r.scores[2].toFixed(1)} / 炫耀 ${r.scores[3].toFixed(1)}）· 点击跳原文">${r.i + 1}</span>`
  ).join("");

  const legend = EMO_DEF.map(e => `<span class="emo-dot ${e.cls}"></span>${e.k}`).join("")
    + `<span class="emo-dot e-ping"></span>平`;

  const notes = [];
  if (worst.len >= 3) notes.push(`第 ${rows[worst.from].i + 1}–${rows[worst.from + worst.len - 1].i + 1} 章连续 ${worst.len} 章没有释放。读者会闷，中间要插一次小赢或一次揭秘。`);
  if (cold.length) notes.push(`第 ${cold.slice(0, 4).join("、")} 章的释放前面没有压抑或隐忍，爽得没有落差。`);
  if (!notes.length) notes.push("释放前基本都有铺垫，也没有长时间的空转。");

  const gv = giveVsShow(content);
  const gvEx = gv.ex.filter(e => e.at >= 0).map(e =>
    `<button class="at-link" data-goto-at="${e.at}" title="跳回原文">「${escapeHtml(e.text)}」</button>`).join('');
  const gvText = gv.ratio >= 0.55
    ? `直接写情绪词 <b>${gv.n}</b> 次，用动作、身体反应写只有 <b>${gv.b}</b> 次。读者是站在外面看你描述情绪，而不是跟着主角感受。${gvEx ? `例：${gvEx}` : ""}`
    : `情绪大多落在动作和身体上（情绪词 ${gv.n} 次，动作 ${gv.b} 次），读者更容易代入。${gvEx ? `例：${gvEx}` : ""}`;

  return `<h3 id="secEmo">情绪节奏</h3>
  <p class="ch-hint">文笔可以差，节奏不能丢。每章按用词归一类：憋屈、隐忍、释放、炫耀，四类要交替，堆在一起就闷。</p>
  <div class="emo-legend">${legend}</div>
  <div class="emo-strip">${strip}</div>
  <p class="emo-sum">${rows.length} 章：${["憋屈", "隐忍", "释放", "炫耀", "平"].filter(k => count[k]).map(k => `${k} ${count[k]}`).join(" · ")}</p>
  <ul class="op-issues">${notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>

  <div class="ch-sub">给予 vs 展示</div>
  <p class="ch-hint">${gvText}</p>

  ${paceBody(book, content)}`;
}

const EMO_N = /愤怒|委屈|紧张|害怕|恐惧|悲伤|难过|高兴|激动|惊讶|震惊|焦虑|绝望|兴奋|嫉妒|悔恨|羞愧|不安|痛苦|愤怒/g;
const EMO_BODY = /握紧|攥|颤抖|脸色|僵住|喘|心跳|冒汗|发抖|咬唇|握拳|红了眼|绷紧|屏住|吞了吞|嗓子发紧|腿软|后退|愣住|沉默|移开|低下头/g;

/* ══════════ 结论回原文 · 批注 ══════════ */
export function atLink(at, label = '↪ 原文') {
  return `<button class="at-link" data-goto-at="${at}" title="跳回原文并高亮">${label}</button>`;
}

export function noteBtn(at, text) {
  const t = escapeHtml((text || '').replace(/\s+/g, ' ').trim().slice(0, 80));
  return `<button class="at-note" data-note-at="${at}" data-note-text="${t}" title="把这条结论存为批注，挂在对应文段下">批注</button>`;
}

export function annotateChapters(html, book) {
  if (!book || !book.chapters || !html) return html;
  return html.replace(/第\s*(\d{1,4})\s*章/g, (m, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= book.chapters.length) return m;
    return `<button class="at-link" data-goto-at="${book.chapters[idx].start}">${m}</button>`;
  });
}

function giveVsShow(content) {
  const s = sampleText(content, 200000);
  const n = (s.match(EMO_N) || []).length;
  const b = (s.match(EMO_BODY) || []).length;
  const ratio = n / Math.max(1, n + b);
  const ex = [];
  for (const seg of s.split(/[。！？…]/)) {
    const t = seg.trim();
    if (t.length > 4 && /愤怒|委屈|紧张|害怕|恐惧|悲伤|难过|高兴|激动|惊讶|震惊|焦虑|绝望|兴奋|嫉妒|悔恨|羞愧|不安|痛苦/.test(t)) {
      ex.push({ text: t, at: content.indexOf(t) });
      if (ex.length >= 2) break;
    }
  }
  return { n, b, ratio, ex };
}

/** 逐章节奏 + 水章爆点（原「情节曲线」并入情绪节奏） */
export function paceBody(book, content) {
  const rows = plotRows(book, content);
  const avg = Math.round(rows.reduce((a, r) => a + r.chars, 0) / Math.max(1, rows.length));
  const scorable = rows.filter(r => !isMatter(book.chapters[r.i]));
  const base = scorable.length ? scorable : rows;
  const medChars = Math.round(median(base.map(r => r.chars)));
  const medDensity = median(base.map(r => r.density));
  rows.forEach(r => {
    r.risk = riskOf(r, medChars, medDensity);
    r.kind = (r.density < Math.max(1.2, medDensity * 0.5) || r.turns === 0) ? "water" : (r.hook.score <= 1 ? "flat" : "weak");
  });

  const eligible = rows.filter(r => isWaterEligible(book.chapters[r.i]));
  const water = eligible.filter(r => r.risk >= 2).sort((a, b) => b.risk - a.risk);
  const capW = Math.min(20, Math.max(3, Math.round(eligible.length * 0.15)));
  const risks = water.slice(0, capW);
  const riskSet = new Set(water.map(r => r.i));
  const pickPool = eligible.filter(r => !riskSet.has(r.i) && r.events > 0)
    .map(r => ({ r, score: r.events * 2 + r.turns * 3 + r.hook.score * 3 + (r.out === '赢' ? 2 : 0) + (r.conflict === '强' ? 2 : 0) }))
    .sort((a, b) => b.score - a.score);
  const capP = Math.min(12, Math.max(3, Math.round(eligible.length * 0.06)));
  const picks = pickPool.slice(0, capP);
  const matterRows = rows.filter(r => book.chapters[r.i] && book.chapters[r.i].matter);
  const matterLine = matterRows.length
    ? `<p class="ck-hint">前置 / 附加内容（不计节奏）：${matterRows.map(r => `<button class="at-link" data-goto-at="${book.chapters[r.i].start}">${escapeHtml(book.chapters[r.i].title)}</button>`).join("、")}</p>`
    : '';
  const firstConflict = rows.find(r => r.conflict !== "弱" && !isMatter(book.chapters[r.i]));
  const firstWin = rows.find(r => r.out === "赢" && !isMatter(book.chapters[r.i]));
  const maxCrisis = rows.reduce((a, b) => (b.lose > a.lose ? b : a), rows[0]);
  const atAttr = (r) => r ? `data-goto-at="${book.chapters[r.i].start}"` : '';

  return `
  <div class="ch-sub">逐章节奏</div>
  <div class="pl-stats">
    <span><b>${rows.length}</b><em>章</em></span>
    <span><b>${avg}</b><em>字 / 章</em></span>
    <span><b>${rows.reduce((a, r) => a + r.events, 0)}</b><em>个事件</em></span>
    <span><b>${water.length}</b><em>个风险章</em></span>
  </div>
  ${matterLine}
  <div class="pl-legend"><span class="pl-cell r1">稳</span><span class="pl-cell r2">留意</span><span class="pl-cell r3">偏水</span> 每格一章，点格跳原文</div>
  <div class="pl-strip">
    ${rows.map(r => `<span class="pl-cell ${r.risk >= 4 ? "r3" : r.risk >= 2 ? "r2" : "r1"}" data-goto-at="${book.chapters[r.i].start}" title="第${r.i + 1}章 · ${r.events} 个事件 · 转折 ${r.turns} · ${r.hook.type} · 点击跳原文">${r.i + 1}</span>`).join("")}
  </div>
  <div class="pl-nodes">
    <div class="pl-node" ${atAttr(firstConflict)}><span>第一个冲突</span><b>${firstConflict ? "第 " + (firstConflict.i + 1) + " 章" : "没有"}</b></div>
    <div class="pl-node" ${atAttr(firstWin)}><span>主角第一次赢</span><b>${firstWin ? "第 " + (firstWin.i + 1) + " 章" : "没有"}</b></div>
    <div class="pl-node" ${atAttr(maxCrisis)}><span>最大危机</span><b>${maxCrisis ? "第 " + (maxCrisis.i + 1) + " 章" : "—"}</b></div>
  </div>

  <div class="ch-sub">水章与爆点</div>
  ${risks.length ? risks.map(r => {
    const v = threeViews(r, r.kind);
    return `<div class="risk-card">
      <div class="risk-head">
        <b>第 ${r.i + 1} 章</b>
        <span>${r.events} 个事件 · 转折 ${r.turns} · ${r.conflict}冲突 · ${r.hook.type}</span>
        <button class="risk-jump" data-goto-at="${book.chapters[r.i].start}">跳到这章</button>
        ${noteBtn(book.chapters[r.i].start, `第 ${r.i + 1} 章（${r.conflict}冲突·${r.hook.type}）：作者 ${v[0]}；编辑 ${v[1]}；读者 ${v[2]}`)}
      </div>
      <div class="risk-views">
        <p><i>作者</i>${v[0]}</p>
        <p><i>编辑</i>${v[1]}</p>
        <p><i>读者</i>${v[2]}</p>
      </div>
    </div>`;
  }).join("") : '<p class="ck-hint">没有明显空转的章节。每章都有事件，也都有钩子。</p>'}
  ${water.length > risks.length ? `<div class="ch-sub">全部风险章（${water.length}）</div>
  <p class="ck-hint">${water.map(r => `<button class="at-link" data-goto-at="${book.chapters[r.i].start}" title="${r.events} 个事件 · 转折 ${r.turns} · ${r.conflict}冲突 · ${r.hook.type}">第 ${r.i + 1} 章</button>`).join("")}</p>` : ''}

  <div class="ch-sub" id="secPick">推荐阅读章节</div>
  ${picks.length ? picks.map(({ r }) => {
    const v = pickViews(r);
    return `<div class="pick-card">
      <div class="risk-head">
        <b>第 ${r.i + 1} 章</b>
        <span>${r.events} 个事件 · 转折 ${r.turns} · ${r.conflict}冲突 · ${r.hook.type}</span>
        <button class="risk-jump" data-goto-at="${book.chapters[r.i].start}">跳到这章</button>
        ${noteBtn(book.chapters[r.i].start, `第 ${r.i + 1} 章（${r.conflict}冲突·${r.hook.type}）：作者 ${v[0]}；编辑 ${v[1]}；读者 ${v[2]}`)}
      </div>
      <div class="risk-views">
        <p><i>作者</i>${v[0]}</p>
        <p><i>编辑</i>${v[1]}</p>
        <p><i>读者</i>${v[2]}</p>
      </div>
    </div>`;
  }).join("") : '<p class="ck-hint">没有特别出挑的章节，各章节奏平均。</p>'}`;
}

const VIEW_RE = /突然|忽然/g;
const LIFE_RE = /泡面|方便面|剩菜|外卖|挤地铁|熬夜|工资|房租|房贷|撸串|烧烤|拖鞋|大裤衩|旧衣服|打折|便宜|厕所|洗澡|打嗝|哈欠|没睡好|打游戏|刷手机|段子|梗/g;

/** 落地写法：镜头感 / 场景穿插 / 接地气 */
/** 文内批注：一键把拆书结论投射到正文（纯本地，不调模型） */
export function buildInlineNotes(book, content) {
  const notes = [];
  const rows = plotRows(book, content);
  if (!rows.length) return notes;

  const scorable = rows.filter(r => !isMatter(book.chapters[r.i]));
  const base = scorable.length ? scorable : rows;
  const medChars = Math.round(median(base.map(r => r.chars)));
  const medDensity = median(base.map(r => r.density));
  rows.forEach(r => { r.risk = riskOf(r, medChars, medDensity); });
  const risks = rows.filter(r => isWaterEligible(book.chapters[r.i]) && r.risk >= 2).sort((a, b) => b.risk - a.risk);
  const riskSet = new Set(risks.map(r => r.i));

  // 章节级：推荐章（good）
  rows.filter(r => isWaterEligible(book.chapters[r.i]) && !riskSet.has(r.i) && r.events > 0)
    .map(r => ({ r, score: r.events * 2 + r.turns * 3 + r.hook.score * 3 + (r.out === '赢' ? 2 : 0) + (r.conflict === '强' ? 2 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 3)
    .forEach(({ r }) => notes.push({
      at: book.chapters[r.i].start, len: 0, level: 'good',
      title: `值得精读`,
      body: `第 ${r.i + 1} 章：${r.events} 个事件、${r.turns} 次转折，${r.conflict}冲突收在「${r.hook.type}」。整章可以照着学。`
    }));

  // 章节级：水章（warn）
  risks.slice(0, 8).forEach(r => notes.push({
    at: book.chapters[r.i].start, len: 0, level: 'warn',
    title: `偏水`,
    body: `第 ${r.i + 1} 章：${r.events} 个事件、${r.turns} 次转折，${r.conflict}冲突。可以并进上一章，或塞一个事件。`
  }));

  // 句子级：直接写情绪词（warn）
  const EMO_KW = /愤怒|委屈|紧张|害怕|恐惧|悲伤|难过|高兴|激动|惊讶|震惊|焦虑|绝望|兴奋|嫉妒|悔恨|羞愧|不安|痛苦/;
  const gv = giveVsShow(content);
  gv.ex.filter(e => e.at >= 0).slice(0, 6).forEach(e => {
    const km = e.text.match(EMO_KW);
    const off = km ? e.text.indexOf(km[0]) : 0;
    notes.push({
      at: e.at + off, len: Math.max(6, Math.min(e.text.length - off, 40)), level: 'warn',
      title: '直接写情绪词',
      body: `「${e.text.slice(off, off + 40)}」把情绪说出来了。换成动作或身体反应，读者才跟着感受。`
    });
  });

  // 句子级：生活细节（good）
  const LIFE = /泡面|方便面|剩菜|外卖|挤地铁|熬夜|工资|房租|房贷|撸串|烧烤|拖鞋|大裤衩|旧衣服|打折|便宜|厕所|洗澡|打嗝|哈欠|没睡好|打游戏|刷手机|段子|梗/g;
  let m, life = 0;
  while ((m = LIFE.exec(content)) && life < 6) {
    const kw = m[0];
    const at = Math.max(0, m.index - 4);
    notes.push({
      at, len: Math.min(24, content.length - at), level: 'good', title: '接地气',
      body: `「${kw}」这种生活细节让主角落到地上。`
    });
    life++;
  }

  // 章节级：开篇堆场景（tip）
  book.chapters.forEach((c, i) => {
    const kinds = paraKinds(content.slice(c.start, c.end));
    let run = 0;
    for (const k of kinds) { if (k === 'deco') run++; else break; }
    if (run >= 2) notes.push({
      at: c.start, len: 0, level: 'tip',
      title: '开篇堆场景',
      body: `第 ${i + 1} 章开头连写场景。先展开互动，用动作带出环境。`
    });
  });

  return notes;
}

export function writeHTML(book, content) {
  const sample = sampleText(content, 200000);
  const viewN = (sample.match(VIEW_RE) || []).length;
  const viewD = viewN / Math.max(1, sample.length) * 1000;
  const life = (sample.match(LIFE_RE) || []).length;
  const lifeEx = [];
  for (const seg of sample.split(/[。！？…]/)) {
    const t = seg.trim();
    if (t.length > 3 && /泡面|方便面|剩菜|外卖|挤地铁|熬夜|工资|房租|房贷|撸串|烧烤|拖鞋|大裤衩|旧衣服|打折|便宜|厕所|洗澡|打嗝|哈欠|没睡好|打游戏|刷手机|段子|梗/.test(t)) {
      lifeEx.push({ text: t, at: content.indexOf(t) });
      if (lifeEx.length >= 2) break;
    }
  }

  const piled = [];
  book.chapters.forEach((c, i) => {
    const kinds = paraKinds(content.slice(c.start, c.end));
    let run = 0;
    for (const k of kinds) { if (k === "deco") run++; else break; }
    if (run >= 2) piled.push(i + 1);
  });

  const lens = viewD >= 2
    ? `「突然 / 忽然」每千字 ${viewD.toFixed(1)} 次。主视角里这两个词会把镜头拉到旁观者，换成“猛然、当下、只觉”。`
    : `「突然 / 忽然」用得克制（每千字 ${viewD.toFixed(1)} 次），镜头基本贴在角色身上。`;

  const scene = piled.length
    ? `第 ${piled.slice(0, 6).map(n => `<button class="at-link" data-goto-at="${book.chapters[n - 1].start}">${n}</button>`).join("、")} 章开篇连写场景。先展开互动，用动作带出环境。`
    : `没有哪一章开篇在堆场景。`;

  const lifeLinks = lifeEx.filter(e => e.at >= 0).map(e =>
    `<button class="at-link" data-goto-at="${e.at}" title="跳回原文">「${escapeHtml(e.text)}」</button>`).join('');
  const lifeTxt = life
    ? `找到 ${life} 处生活细节${lifeLinks ? `，如 ${lifeLinks}` : ""}。这就是接地气——读者会心一笑，主角就落到地上。`
    : `几乎找不到生活细节。加剩菜、泡面、工资、熬夜这类具体物件，主角才不至于飘着。`;

  return `<h3 id="secWrite">落地写法</h3>
  <p class="ch-hint">描写是为情节和人物服务的。这里只查三样：镜头贴在谁身上、场景是堆在开头还是化在动作里、主角接不接地气。</p>
  <div class="write-list">
    <div class="write-row"><b>镜头感</b><span>${lens}</span></div>
    <div class="write-row"><b>场景穿插</b><span>${scene}</span></div>
    <div class="write-row"><b>接地气</b><span>${lifeTxt}</span></div>
  </div>`;
}

export function parseReport(md) {
  const core = parseCore(md);
  const verdict = (md.match(/###\s*一句话判断\s*\n([^\n]+)/) || ["", ""])[1].trim();
  const grabList = (head) => {
    const m = md.match(new RegExp(head + "\\s*\\n([\\s\\S]*?)(?=\\n###|$)"));
    if (!m) return [];
    return m[1].split("\n")
      .map(x => x.replace(/^\s*\d+[.、]\s*/, "").trim())
      .filter(x => x.length > 1);
  };
  return {
    core: core ? core.sentence : "",
    verdict,
    fix: grabList("###\\s*三个必须改的地方"),
    copy: grabList("###\\s*三个可以直接抄的动作")
  };
}

export function promptRange(book, content, stats, fit) {
  const f = fit || {};
  const digest = book.chapters.slice(0, 24).map((c, i) => {
    const head = content.slice(c.start, Math.min(c.end, c.start + 700)).replace(/\s+/g, ' ');
    return `【选段第 ${i + 1} 章】${head}`;
  }).join('\n\n').slice(0, 8000);

  return [
    { role: 'system', content: SYS + '\n7. 你现在的身份是网络小说主编。只给能直接落笔的判断和动作，不要赏析。' },
    {
      role: 'user', content: `我在拆《${book.title}》的一段选段（共 ${book.chapters.length} 章），想把它当结构教材。

【机器测出的结构数据】
- 选段共 ${book.chapters.length} 章，平均每章 ${f.avg || '?'} 字
- 对话段落占比 ${stats.dialoguePct}%，平均句长 ${stats.avg} 字

【选段各章开头】
${digest}

请完全站在网络小说连载的角度分析，严格按下面的标题输出 Markdown，不要写标题以外的段落。注意：下文所有"第 X 章"都指选段内从 1 开始的相对章号。

### 选段判断
这段在全书里承担什么作用、能不能独立成一个单元。一句话，不超过 30 字。

### 三个必须改的地方
1. 第 X 章｜问题｜怎么改（一行一条）

### 三个可以直接抄的动作
1. 做法｜在第几章｜怎么用到你的书里（一行一条）

不要写教学段落，不要总结。` }
  ];
}

export function promptCreate(book, scopeLabel, type, requirement, excerpt, context) {
  const T = {
    plot: '新的故事情节（一个情节点或一场戏），写清目标、阻碍、转折、结果',
    char: '人物设定，按"身份 / 目标 / 价值观 / 矛盾 / 能力 / 与主角的关系"分行写',
    scene: '一段描写（场景、动作或心理任选其一），直接成文，贴合本书文风和人物'
  };
  return [
    { role: 'system', content: SYS + '\n7. 你是资深网文写手兼主编。只输出能直接落笔用的内容，不要解释、不要客套。' },
    {
      role: 'user', content: `我在写网络小说，正在参考${bookMeta(book)}。

【取材范围】${scopeLabel}
【原文片段】
${excerpt || '（无）'}

【已保存的设定，据此继续】
${context || '（无）'}

【要生成】${T[type] || T.plot}
【我的要求】${requirement || '（无，按上面的片段和设定自由发挥）'}

直接输出内容本身，不要加"以下是"之类的开场，不要分析，不要问问题。` }
  ];
}

export function promptApply(book, genre, premise, volText) {
  return [
    { role: 'system', content: SYS + '\n7. 你是一位网文主编。只给能直接落笔的方案，不要赏析。' },
    {
      role: 'user', content: `我拆了${bookMeta(book)}，想借用它的分卷骨架，搭我自己的书。

【这本书的分卷骨架】
${volText || '（无）'}

【我的故事】
题材：${genre || '未定'}
一句话核心梗：${premise}

严格按下面的格式输出，不要多写别的段落：

### 我的核心梗
一句话：（40 字内，必须含开始、转折、结束）

### 我的分卷
| 卷 | 起止章 | 主角拿到什么 | 主角失去什么 | 卷末变化 |
| --- | --- | --- | --- | --- |
（3–5 卷，按 30 万字、每章约 2500 字来分）

### 我的黄金三章
第 1 章：处境（前 300 字给什么，一句话）
第 2 章：选择（主角做一次什么选择，一句话）
第 3 章：欲望（主角明确要什么，一句话）

### 一个要提前避开的坑
一句话。` }
  ];
}

/** 章纲卡：照这一章，填我的下一章（1.6 章纲的落点） */
export function chapterCardHTML(book, chapter, text) {
  const ev = countEvents(text);
  const turns = (text.match(TURN_RE) || []).length;
  const hook = hookOf(text);
  const tail = (text.trim().match(/[^。！？…\n]{4,40}[。！？…]\s*$/) || [''])[0].trim();
  const cells = [
    ['目标', '这一章主角想干什么'],
    ['阻碍', '谁 / 什么在挡'],
    ['转折', '局面在哪翻一次'],
    ['收束', '结尾留什么钩子']
  ];
  return `<div class="ch-sub">照这一章，填我的章纲</div>
  <p class="ch-hint">左边是这一章的可测骨架，右边照着填你自己的。填完可复制成章纲、存进素材。</p>
  <div class="ck-grid">
    ${cells.map(([k, ph]) => `<div class="ck-cell"><label>${k}</label><textarea data-ck="${k}" rows="2" placeholder="${ph}"></textarea></div>`).join('')}
  </div>
  <p class="ch-hint">参考：这章 ${ev} 个事件 · 转折 ${turns} 次 · 结尾「${escapeHtml(tail || '—')}」（${hook.type}）</p>
  <div class="ck-acts">
    <button class="mini-btn" data-ck-copy>复制成章纲</button>
    <button class="mini-btn" data-ck-save>存为素材</button>
  </div>`;
}

export function plotHTML(book, content) {
  const rows = plotRows(book, content);
  const avg = Math.round(rows.reduce((a, r) => a + r.chars, 0) / Math.max(1, rows.length));
  const scP = rows.filter(r => !isMatter(book.chapters[r.i]));
  const baseP = scP.length ? scP : rows;
  const medCharsP = Math.round(median(baseP.map(r => r.chars)));
  const medDensityP = median(baseP.map(r => r.density));
  rows.forEach(r => {
    r.risk = riskOf(r, medCharsP, medDensityP);
    r.kind = (r.density < Math.max(1.2, medDensityP * 0.5) || r.turns === 0) ? 'water'
      : (r.hook.score <= 1 ? 'flat' : 'weak');
  });

  const func = paraFunction(content);

  const firstConflict = rows.find(r => r.conflict !== '弱');
  const firstWin = rows.find(r => r.out === '赢');
  const maxCrisis = rows.reduce((a, b) => (b.lose > a.lose ? b : a), rows[0]);

  const waterRows = rows.filter(r => isWaterEligible(book.chapters[r.i]) && r.risk >= 2).sort((a, b) => b.risk - a.risk);
  const risks = waterRows.slice(0, Math.min(20, Math.max(3, Math.round(rows.length * 0.15))));

  const funcLine = (() => {
    const f = func.pct;
    if (f.push < 45) return `推进段只占 <b>${f.push}%</b>，一半以上的篇幅没有发生事。读者不是来看风景的。`;
    if (f.info >= 12) return `说明段占 <b>${f.info}%</b>，设定解释偏多。设定要藏在动作里，不能停下来讲。`;
    if (f.deco >= 20) return `装饰段占 <b>${f.deco}%</b>，景物和氛围偏多。描写本身没错，但要让它在人物有事的时候出现。`;
    return `推进 <b>${f.push}%</b> · 塑造 <b>${f.shape}%</b> · 装饰 <b>${f.deco}%</b> · 说明 <b>${f.info}%</b>。比例健康。`;
  })();

  return `
  <h3 id="secPlot">情节曲线</h3>

  <div class="pl-stats">
    <span><b>${rows.length}</b><em>章</em></span>
    <span><b>${avg}</b><em>字 / 章</em></span>
    <span><b>${rows.reduce((a, r) => a + r.events, 0)}</b><em>个事件</em></span>
    <span><b>${waterRows.length}</b><em>个风险章</em></span>
  </div>
  <p style="font-size:11px;color:var(--ink-3)">每格一章，格子里是章号。颜色越深越结实，浅色是需要留意的地方——点开下面的「风险章」看具体问题。</p>
  <div class="pl-strip">
    ${rows.map(r => `<span class="pl-cell ${r.risk >= 4 ? 'r3' : r.risk >= 2 ? 'r2' : 'r1'}" title="第${r.i + 1}章 · ${r.events} 个事件 · 转折 ${r.turns} · ${r.hook.type}">${r.i + 1}</span>`).join('')}
  </div>

  <div class="pl-nodes">
    <div class="pl-node"><span>第一个冲突</span><b>${firstConflict ? '第 ' + (firstConflict.i + 1) + ' 章' : '没有'}</b></div>
    <div class="pl-node"><span>主角第一次赢</span><b>${firstWin ? '第 ' + (firstWin.i + 1) + ' 章' : '没有'}</b></div>
    <div class="pl-node"><span>最大危机</span><b>${maxCrisis ? '第 ' + (maxCrisis.i + 1) + ' 章' : '—'}</b></div>
  </div>

  <h3>风险章</h3>
  ${risks.length ? risks.map(r => {
    const v = threeViews(r, r.kind);
    return `<div class="risk-card">
      <div class="risk-head">
        <b>第 ${r.i + 1} 章</b>
        <span>${r.events} 个事件 · 转折 ${r.turns} · ${r.conflict}冲突 · ${r.hook.type}</span>
        <button class="risk-jump" data-goto-at="${book.chapters[r.i].start}">跳到这章</button>
      </div>
      <div class="risk-views">
        <p><i>作者</i>${v[0]}</p>
        <p><i>编辑</i>${v[1]}</p>
        <p><i>读者</i>${v[2]}</p>
      </div>
    </div>`;
  }).join('') : '<p class="ck-hint">没有明显空转的章节。每章都有事件，也都有钩子。</p>'}

  <h3 id="secFunc">段落功能</h3>
  <p style="font-size:11px;color:var(--ink-3)">描写不是越多越好，要看它在干什么：推事、塑人、造气氛，还是在解释设定。</p>
  <div class="fn-bars">
    ${[['push', '推进', 'var(--accent)'], ['shape', '塑造', '#8a9a7b'], ['deco', '装饰', '#9a8a6a'], ['info', '说明', '#9a5a4a']]
      .map(([k, n, c]) => `<div class="fn-row">
        <span class="fn-name">${n}</span>
        <span class="fn-track"><i style="width:${func.pct[k]}%;background:${c}"></i></span>
        <span class="fn-val">${func.pct[k]}%</span>
      </div>`).join('')}
  </div>
  <p class="fn-read">${funcLine}</p>
  `;
}


/* ══════════ 人物：弧线、同框、人物卡 ══════════
 * 戏份表只能看出"谁出现得多"，看不出"这个人有没有变"。
 * 所以这里三件事：谁在场、谁掉线、谁和谁同框却没发生事。
 */

function countIn(t, n) {
  let k = 0, i = 0;
  while ((i = t.indexOf(n, i)) >= 0) { k++; i += n.length; }
  return k;
}

export function characterDetail(book, content) {
  const names = castNames(content, book);
  if (!names.length) return { rows: [], pairs: [], absent: [], lead: null };

  const chs = book.chapters;
  const texts = chs.map(c => content.slice(c.start, c.end));
  const rows = names.map(n => {
    const arr = texts.map(t => countIn(t, n));
    const hit = arr.map((v, i) => (v > 0 ? i : -1)).filter(i => i >= 0);
    if (!hit.length) return null;
    const total = arr.reduce((a, b) => a + b, 0);
    let peak = hit[0];
    arr.forEach((v, i) => { if (v > arr[peak]) peak = i; });

    let gapLen = 0, gapStart = 0, run = 0, runStart = 0;
    for (let i = hit[0]; i <= hit[hit.length - 1]; i++) {
      if (arr[i] === 0) {
        if (run === 0) runStart = i;
        run++;
        if (run > gapLen) { gapLen = run; gapStart = runStart + 1; }
      } else run = 0;
    }

    return {
      name: n, counts: arr, total,
      chapters: hit,
      first: hit[0] + 1, last: hit[hit.length - 1] + 1,
      peak: peak + 1, peakCount: arr[peak],
      gapLen, gapStart
    };
  }).filter(Boolean);

  rows.sort((a, b) => b.chapters.length - a.chapters.length || b.total - a.total);
  const sum = rows.reduce((a, r) => a + r.total, 0) || 1;
  rows.forEach(r => { r.share = Math.round(r.total / sum * 100); });

  const lead = rows[0] || null;
  const absent = lead
    ? chs.map((c, i) => i + 1).filter(n => lead.counts[n - 1] === 0)
    : [];

  const plot = plotRows(book, content);
  const pairs = lead ? rows.slice(1, 4).map(r => {
    const both = [], idle = [];
    chs.forEach((c, i) => {
      if (lead.counts[i] > 0 && r.counts[i] > 0) {
        both.push(i + 1);
        if (!(plot[i] && plot[i].events > 0)) idle.push(i + 1);
      }
    });
    return { name: r.name, both, idle };
  }).filter(p => p.both.length) : [];

  return { rows, pairs, absent, lead };
}

export function characterHTML(book, content) {
  const d = characterDetail(book, content);
  if (!d.rows.length) {
    return `<h3 id="secChar">人物</h3>
    <p class="ck-hint">没有识别出反复出现的人名。这本书可能以“他/她”推进，或者大量用称谓。</p>`;
  }

  const rows = d.rows.slice(0, 8);
  const lead = d.lead;
  const pairs = d.pairs.length
    ? d.pairs.map(p => {
        const busy = p.both.length - p.idle.length;
        return `<div class="pair-row">
          <b>${escapeHtml(p.name)}</b>
          <span>同框 ${p.both.length} 章，${busy} 章有事${p.idle.length ? `；第 ${p.idle.slice(0, 6).join('、')} 章只有相处、没发生事` : ''}</span>
        </div>`;
      }).join('')
    : '<p class="ck-hint">主角与其他人物几乎没有同框。要么是单线叙事，要么是称谓用得太散。</p>';

  return `
  <h3 id="secChar">人物</h3>
  <p class="ch-hint">先射箭，后画靶：人物故事本身就是世界观，别先搭世界观再往里面塞人。这里看三件事——谁在场、谁掉线、谁和谁同框却没发生事。</p>
  <div class="vol-wrap"><table class="ck-table char-table">
    <thead><tr><th>人物</th><th>出场</th><th>首现 → 收束</th><th>高峰</th><th>最长空档</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.chapters.length <= 1 ? 'dim-row' : ''}">
      <td>${escapeHtml(r.name)}</td>
      <td>${r.chapters.length}</td>
      <td>${r.first} → ${r.last}</td>
      <td>${r.peak}</td>
      <td>${r.gapLen >= 2 ? `${r.gapStart}–${r.gapStart + r.gapLen - 1}（${r.gapLen} 章）` : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  ${d.absent.length ? `<div class="risk-card mini">
    <div class="risk-head"><b>主角缺席 ${d.absent.length} 章</b><span>第 ${d.absent.slice(0, 8).join('、')} 章没有「${escapeHtml(lead.name)}」</span></div>
    <div class="risk-views">
      <p><i>作者</i>配角的戏压到 800 字以内，或者让主角在旁边看着。</p>
      <p><i>编辑</i>主角缺席一整章，追更读者会以为你换了主角。</p>
      <p><i>读者</i>我等的那个人呢？</p>
    </div>
  </div>` : ''}
  <p class="ck-hint">只统计“某某道 / 某某说”这类叙述标签能认出的名字，可能有遗漏。</p>

  <div class="ch-sub" id="secPair">感情线：缝隙</div>
  <p class="ch-hint">感情是故事推出来的，不是作者分配的。同框却没发生事的那几章，往往就是硬塞好感。</p>
  <div class="pair-list">${pairs}</div>

  <div id="charCards">
    <div class="ch-gen">
      <div class="ch-sel">${d.rows.slice(0, 6).map((r, i) =>
        `<label class="ch-chip"><input type="checkbox" data-ch-sel="${escapeHtml(r.name)}" ${i < 3 ? "checked" : ""}>${escapeHtml(r.name)}</label>`
      ).join("")}</div>
      <button class="mini-btn" data-chars>用模型拆选中的</button>
      <span>只发选中的人在书里的片段，最多四人</span>
    </div>
  </div>`;
}

export function pickCast(book, content, n = 3) {
  const d = characterDetail(book, content);
  return d.rows.slice(0, n);
}

export function castSamples(book, content, row, len = 240) {
  const chs = book.chapters;
  if (!row.chapters.length) return '';
  const picks = [];
  const idxs = [...new Set([0, Math.floor(row.chapters.length / 2), row.chapters.length - 1])];
  idxs.forEach(k => {
    const i = row.chapters[Math.min(k, row.chapters.length - 1)];
    const t = content.slice(chs[i].start, chs[i].end);
    const p = t.indexOf(row.name);
    const from = Math.max(0, p - 80);
    const seg = t.slice(from, from + len).replace(/\s+/g, ' ').trim();
    picks.push(`[${row.name} · 第 ${i + 1} 章] ${seg}`);
  });
  return picks.join('\n');
}

export function promptCharacters(book, cast, samples) {
  return [
    { role: 'system', content: SYS + '\n7. 你现在的身份是网络小说主编。拆人物时只依据原文，宁可写“原文未交代”，也不要替作者补。' },
    {
      role: 'user', content: `我在拆${bookMeta(book)}，目的是学结构，不要写赏析。

【要拆的人物】
${cast.map((r, i) => `${i + 1}. ${r.name}：第 ${r.first} 章首现，出场 ${r.chapters.length} 章，第 ${r.peak} 章戏份最重`).join('\n')}

【原文片段】
${samples}

只写上面这 ${cast.length} 个人，不要多写。每人严格按下面的格式，一行一项：

### 姓名
身份：开始是什么 → 最后是什么
目标：开始要什么 → 最后要什么
价值观：理性…；感性…；现实…
矛盾：故事里真实发生的那次摩擦（不是性格矛盾）
顿悟：因为哪件事变成了什么样；没有就写“无”
变化：年龄 a→b；性格 a→b；心理 a→b；爱好 a→b
判断：这个人的弧线成不成立，一句话

硬要求：只依据原文；原文没写就写“原文未交代”，不要编。每项不超过 40 字。` }
  ];
}

function charCard(block, at) {
  const lines = block.split('\n').map(x => x.trim()).filter(Boolean);
  const name = (lines.shift() || '').slice(0, 14);
  const kv = {};
  lines.forEach(l => {
    const m = l.match(/^(身份|目标|价值观|矛盾|顿悟|变化|判断)[：:]\s*(.+)$/);
    if (m) kv[m[1]] = m[2].replace(/\*\*/g, '');
  });
  const items = ['身份', '目标', '价值观', '矛盾', '顿悟'].filter(k => kv[k]);
  const verdict = kv['判断'] || '';
  const bad = /不成立|立不住|扁平|工具人/.test(verdict);
  return `<div class="ch-card">
    <div class="ch-card-head"><b>${escapeHtml(name)}</b>${at != null ? `<button class="at-link" data-goto-at="${at}" title="跳到首次出场章">首现章</button>` : ''}</div>
    ${verdict ? `<p class="ch-verdict${bad ? ' bad' : ''}">${escapeHtml(verdict)}</p>` : ''}
    <dl>${items.map(k => `<dt>${k}</dt><dd>${escapeHtml(kv[k])}</dd>`).join('')}</dl>
    ${kv['变化'] ? `<p class="ch-change"><i>变化</i>${escapeHtml(kv['变化'])}</p>` : ''}
  </div>`;
}

export function charCardsHTML(md, final = false, anchors = []) {
  const blocks = ('\n' + md).split('\n### ').slice(1);
  if (!blocks.length) return '';
  const cards = blocks.map((b, i) => {
    const isLast = i === blocks.length - 1;
    const complete = final || !isLast || /判断[：:]/.test(b);
    return complete ? charCard(b, anchors[i]) : '';
  }).join('');

  const tail = blocks[blocks.length - 1];
  const pending = (!final && !/判断[：:]/.test(tail))
    ? `<p class="outline-loading">正在拆「${escapeHtml((tail.split('\n')[0] || '').slice(0, 12))}」…</p>`
    : '';
  return cards + pending;
}

export function craftFold(book, content) {
  const craft = craftStats(content);
  return `
  <details class="fold-craft" id="secCraft">
    <summary>语言指纹 · 句子层面（可选）</summary>
    <p style="font-size:11px;color:var(--ink-3);margin:8px 0 10px">只数具体的写法——动词、微表情、小动作、物件。抽象词不进表。横条是这一维在本书里的相对比重。</p>
    <div class="craft-list">
      ${Object.keys(craft.cats).map((k, i, arr) => {
        const c = craft.cats[k];
        const maxD = Math.max(...Object.values(craft.cats).map(x => x.density), 0.001);
        const pct = Math.min(100, Math.round(c.density / maxD * 100));
        return `<div class="craft-row${i === arr.length - 1 ? ' craft-meta' : ''}">
          <div class="craft-head">
            <span class="craft-name">${c.name}</span>
            <span class="craft-num">${c.kinds} 种</span>
            <span class="craft-den">${c.density.toFixed(1)} / 千字</span>
          </div>
          <div class="craft-bar"><i style="width:${Math.max(2, pct)}%"></i></div>
          <div class="craft-top">${c.top.length
            ? c.top.map(([w, n]) => `${escapeHtml(w)}<b>${n}</b>`).join('<span class="sep">·</span>')
            : '<span class="lex-none">没有出现</span>'}</div>
        </div>`;
      }).join('')}
    </div>
    <p class="craft-read">${craftRead(craft)}</p>
  </details>`;
}
