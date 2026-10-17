/* 墨读 · 写作工位 writer.js
   面向网文作者的本地工具：日更追踪 · 存稿进度 · 伏笔台账 · 人物一致性 ·
   审稿处方（诊断→可插入动作） · 过审自查 · AI 味检测 · 平台导出 · AI 提示词。
   全部本地规则计算，不联网；所有判断都是启发式，界面统一标注"疑似"，可点回原文自行判断。
   本模块不 import 其它模块，纯函数 + localStorage，便于单独测试。 */

/* ═══════════ 通用 ═══════════ */
export function charCount(s) { return (s || '').replace(/\s/g, '').length; }

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function dayDiff(aKey, bKey) { // bKey - aKey，单位天
  const A = new Date(aKey + 'T00:00:00'), B = new Date(bKey + 'T00:00:00');
  return Math.round((B - A) / 86400000);
}

/* ═══════════ 日更追踪（localStorage：本地设备级，不进备份） ═══════════ */
const WKEY = 'modu.writer';
const W_DEF = { goal: 3000, platform: '通用', log: {}, lastSave: {} };

export function getWriterPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(WKEY) || '{}');
    return Object.assign({}, W_DEF, o, { log: o.log || {}, lastSave: o.lastSave || {} });
  } catch { return Object.assign({}, W_DEF, { log: {}, lastSave: {} }); }
}
export function setWriterPrefs(p) { localStorage.setItem(WKEY, JSON.stringify(p)); }

export function logWords(n, dateKey = localDateKey()) {
  const p = getWriterPrefs();
  p.log[dateKey] = Math.max(0, (p.log[dateKey] || 0) + n);
  setWriterPrefs(p);
  return p.log[dateKey];
}
export function todayWords() { return getWriterPrefs().log[localDateKey()] || 0; }

export function streak(log, today = localDateKey()) {
  log = log || {};
  let cur = log[today] ? today : null;
  if (!cur) {
    const y = new Date(today + 'T00:00:00'); y.setDate(y.getDate() - 1);
    const yk = localDateKey(y);
    if (log[yk]) cur = yk; else return 0;
  }
  let n = 0, k = cur;
  while (log[k]) { n++; const d = new Date(k + 'T00:00:00'); d.setDate(d.getDate() - 1); k = localDateKey(d); }
  return n;
}
export function recentDays(log, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = localDateKey(d);
    out.push({ key: k, label: k.slice(5), words: (log || {})[k] || 0 });
  }
  return out;
}

export function markSaved(bookId, dateKey = localDateKey()) {
  const p = getWriterPrefs();
  p.lastSave[bookId] = dateKey;
  setWriterPrefs(p);
  return dateKey;
}
export function lastSavedDays(bookId) {
  const l = getWriterPrefs().lastSave[bookId];
  if (!l) return null;
  return dayDiff(l, localDateKey());
}

/* ═══════════ 章节 / 存稿 ═══════════ */
export function chapterStats(book, content) {
  const cs = (book && book.chapters) || [];
  const text = content || '';
  return cs.map((c, i) => ({
    index: i,
    title: c.title || ('第' + (i + 1) + '章'),
    chars: charCount(text.slice(c.start, c.end))
  }));
}
export function stashStats(book, content, dailyGoal) {
  const chapters = chapterStats(book, content);
  const total = chapters.reduce((a, c) => a + c.chars, 0);
  const goal = Math.max(1, dailyGoal || 3000);
  const avg = chapters.length ? Math.round(total / chapters.length) : 0;
  return {
    chapters, count: chapters.length, total, avg, goal,
    daysLeft: avg ? Math.floor(total / goal) : 0,
    needFor30: Math.max(0, Math.ceil((goal * 30 - total) / Math.max(1, avg))),
    short: chapters.filter(c => c.chars < 1500).length,
    long: chapters.filter(c => c.chars > 4200).length
  };
}

/* ═══════════ 伏笔 / 线头抽取（规则） ═══════════ */
const THREAD_CUES = ['秘密', '隐瞒', '真相', '其实', '原来', '竟然', '没想到', '殊不知', '却不知',
  '谁知', '伏笔', '埋下', '日后', '有朝一日', '终有一日', '迟早', '早晚', '一直', '始终', '从未',
  '不动声色', '暗中', '悄悄', '隐隐', '莫名', '古怪', '蹊跷', '不寻常', '异样', '不知何时', '总觉得',
  '说不清', '有古怪', '另有', '背后', '留了', '记下'];

function chapterIndexAt(chapters, off) {
  for (let i = 0; i < chapters.length; i++) if (off >= chapters[i].start && off < chapters[i].end) return i;
  return chapters.length ? chapters.length - 1 : 0;
}

export function extractThreads(book, content) {
  const cs = (book && book.chapters) || [];
  const text = content || '';
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length && out.length < 300; i++) {
    const ch = text[i];
    if (i === text.length || '。！？!?\n'.includes(ch)) {
      const seg = text.slice(start, i + 1).trim();
      if (seg.length >= 6 && seg.length <= 60) {
        const cues = THREAD_CUES.filter(k => seg.includes(k));
        if (cues.length) {
          out.push({ offset: start, text: seg, chapter: chapterIndexAt(cs, start), cues: cues.slice(0, 3) });
        }
      }
      start = i + 1;
    }
  }
  const seen = new Set(), uniq = [];
  for (const o of out) { if (seen.has(o.text)) continue; seen.add(o.text); uniq.push(o); if (uniq.length >= 150) break; }
  return uniq;
}

/* ═══════════ 人物一致性（断档 / 年龄冲突 / 称谓） ═══════════ */
function nameEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function aliasVariants(name, text) {
  const v = {};
  v[name] = (v[name] || 0);
  const count = (re) => { let n = 0, m; const r = new RegExp(re, 'g'); while ((m = r.exec(text))) n++; return n; };
  v[name] = count(nameEsc(name));
  if (name.length >= 3) {
    const given = name.slice(1);
    v[given] = count(nameEsc(given));
    const small = name[0] + name.slice(-1);
    if (small !== name) v[small] = count(nameEsc(small));
  }
  return Object.keys(v).map(k => ({ form: k, n: v[k] })).filter(x => x.n > 0).sort((a, b) => b.n - a.n);
}

export function consistencyScan(book, content, names) {
  names = (names || []).slice(0, 12);
  const cs = (book && book.chapters) || [];
  const text = content || '';
  const gaps = [], numbers = [], aliases = [];
  for (const nm of names) {
    if (!nm) continue;
    const chs = [];
    let from = 0, cnt = 0;
    while (true) {
      const i = text.indexOf(nm, from);
      if (i < 0) break;
      cnt++; chs.push(chapterIndexAt(cs, i));
      from = i + nm.length;
      if (cnt > 3000) break;
    }
    if (!cnt) continue;
    const uniqCh = [...new Set(chs)].sort((a, b) => a - b);
    let maxGap = 0, gapAt = -1;
    for (let i = 1; i < uniqCh.length; i++) {
      const g = uniqCh[i] - uniqCh[i - 1];
      if (g > maxGap) { maxGap = g; gapAt = uniqCh[i - 1]; }
    }
    aliases.push({ name: nm, count: cnt, first: uniqCh[0], last: uniqCh[uniqCh.length - 1], maxGap, gapAt, variants: aliasVariants(nm, text) });
    if (maxGap >= 3) gaps.push({ name: nm, gap: maxGap, from: gapAt });

    const re = new RegExp(nameEsc(nm) + '[^。！？\\n]{0,8}?(\\d{1,3})\\s*(岁|年纪|岁半)', 'g');
    const ages = {}; let m;
    while ((m = re.exec(text))) ages[m[1]] = (ages[m[1]] || 0) + 1;
    const ks = Object.keys(ages);
    if (ks.length >= 2) numbers.push({ name: nm, values: ks });
  }
  return { gaps, numbers, aliases };
}

/* ═══════════ 审稿处方：诊断 → 可直接插入的动作 ═══════════ */
export const HOOK_LIB = [
  { kind: '悬念', items: ['事情不对——他低头，看见＿＿＿＿。', '"你确定……那个人真的死了？"', '门外传来一声不该出现的响动。'] },
  { kind: '危机', items: ['剑锋离咽喉只剩一寸。', '倒计时归零，门铃响了。', '"再晚一步，她就没了。"'] },
  { kind: '反转', items: ['他笑着点头——却在转身的瞬间，把信烧了。', '"我不是来救你的。"', '名单上，最后一个名字是他自己。'] },
  { kind: '揭秘', items: ['玉佩的背面，刻着一个他再熟悉不过的字：＿＿。', '"三年前那场火，不是意外。"', '师父临终前那句话，他终于听懂了。'] },
  { kind: '台词', items: ['"你可以恨我，但别恨错了人。"', '"签了它，你就不再是他们的棋子。"'] },
  { kind: '平收（慎用）', items: ['这一夜，他睡得很沉。', '窗外的雨，停了又下。'] }
];

export const PRESCRIPTIONS = {
  'open-weak': {
    title: '开篇留不住人',
    items: [
      { do: '让人物在第 200 字内开口', eg: '"这单我不接。"他把契约推了回去。' },
      { do: '第一句改成动作，不要写天气或背景', eg: '刀先到了，人还没到。' },
      { do: '前 500 字只留 3 个人名以内', eg: '删掉还没出场的亲戚、师门、旧友。' }
    ]
  },
  'flat-hook': {
    title: '章末连续平收',
    items: [
      { do: '把最后一句从"结果"改成"异常"', eg: '他放下碗——碗底刻着一行小字。' },
      { do: '在结尾加一句台词，制造对话悬念', eg: '"别回头。"身后的人说。' },
      { do: '把下一章的危机提前一行', eg: '而此刻，门外已经站满了人。' }
    ]
  },
  'water': {
    title: '疑似水章',
    items: [
      { do: '给本章补一个"不可逆"的小变化（失去/获得/暴露）', eg: '他丢了唯一的凭证 / 知道了对方的名字。' },
      { do: '删掉重复的环境与心理描写，用一次动作代替', eg: '"他坐了很久。"→"烟灰积了半寸。"' },
      { do: '把本章的功能改成"埋坑"，为后文服务', eg: '随口提一句：那个人最近总往城西跑。' }
    ]
  },
  'slow': {
    title: '转折/爽点太稀',
    items: [
      { do: '每 3–5 章安排一次小转折，把信息差翻面', eg: '读者以为的盟友，其实是对方的眼线。' },
      { do: '爽点前先压一次，压得越狠释放越大', eg: '先当众受辱，再当场打脸。' },
      { do: '把一个大高潮拆成"小胜—小挫—大胜"三段', eg: '赢一场、输一阵、最终翻盘。' }
    ]
  },
  'no-conflict': {
    title: '本章没有冲突',
    items: [
      { do: '插入一个"当场戳破身份"的尴尬', eg: '有人喊出了他藏了三年的名字。' },
      { do: '让一个次要角色提出过分要求', eg: '"借我点钱，顺便，替我顶个罪。"' },
      { do: '设一个限时任务（时间压力=冲突）', eg: '"一炷香内，把人带回来。"' }
    ]
  },
  'low-dialogue': {
    title: '对话偏少，像叙事流水',
    items: [
      { do: '把一段叙述改成一问一答', eg: '"你去过城南？""没有。""那你怎么知道他住那儿？"' },
      { do: '给对话加"没说出口"的潜台词', eg: '"没事。"他捏碎了手里的杯子。' },
      { do: '用对话交代设定，别用旁白', eg: '"这规矩，是他定的。""哪个他？"' }
    ]
  }
};
export function prescribe(kind) { return PRESCRIPTIONS[kind] || null; }
export function prescribeList() { return Object.keys(PRESCRIPTIONS).map(k => Object.assign({ key: k }, PRESCRIPTIONS[k])); }

/* ═══════════ 过审自查（平台红线） ═══════════ */
export const GUARD_CATEGORIES = {
  '色情低俗': ['色情', '嫖', '卖淫', '迷药', '春药', '裸', '淫'],
  '暴力血腥': ['血腥', '虐杀', '肢解', '分尸', '碎尸', '爆头', '掏心'],
  '涉赌涉毒': ['赌博', '赌场', '吸毒', '贩毒', '毒品', '冰毒'],
  '封建迷信': ['招魂', '下降头', '养小鬼', '跳大神', '算命改命'],
  '危险行为': ['自杀', '自残', '割腕', '跳楼'],
  '现实指涉': ['真实国家名', '真实领导人', '真实军警番号', '真实宗教极端组织']
};
export function guardWords(words) {
  if (Array.isArray(words) && words.length) return words.slice();
  const flat = [];
  for (const k in GUARD_CATEGORIES) for (const w of GUARD_CATEGORIES[k]) flat.push(w);
  return flat;
}
export function scanGuard(text, words) {
  const list = guardWords(words);
  const hits = [];
  for (const w of list) {
    if (!w) continue;
    let from = 0;
    while (true) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      hits.push({ word: w, offset: i, ctx: text.slice(Math.max(0, i - 14), i + w.length + 14).replace(/\s+/g, ' ') });
      from = i + w.length;
      if (hits.length > 400) break;
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

/* ═══════════ AI 味检测（规则） ═══════════ */
const AI_PATS = [
  { name: '总结腔', re: /(总而言之|综上所述|由此可见|不难看出|归根结底|说到底|换言之)/g },
  { name: '对仗模板', re: /不是[^。！？\n]{0,14}?而是/g },
  { name: '陈词滥调', re: /(空气仿佛凝固|时间仿佛静止|如同五雷轰顶|眼中闪过一抹|嘴角勾起一抹|心中一凛|心中一沉|瞳孔骤然收缩)/g },
  { name: '上帝视角', re: /(直到这一刻|他终于明白|殊不知|命运早已|某种意义上)/g },
  { name: '副词堆砌', re: /(深深地|缓缓地|静静地|轻轻地|默默地)[^。！？\n]{0,6}?(地)/g }
];
export function scanAIFlavor(text) {
  const out = [];
  for (const p of AI_PATS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      out.push({ type: p.name, hit: m[0], offset: m.index });
      if (out.length > 300) break;
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/* ═══════════ 平台导出 ═══════════ */
export function exportPlain(book, content, opts = {}) {
  const titles = opts.titles !== false;
  const blank = opts.blank !== false;
  const cs = (book && book.chapters) || [];
  const text = content || '';
  const head = '《' + ((book && book.title) || '未命名') + '》\n\n';
  if (!cs.length) return head + text;
  let s = head;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (titles) s += (c.title || ('第' + (i + 1) + '章')) + '\n\n';
    s += text.slice(c.start, c.end).trim() + (blank ? '\n\n' : '\n');
  }
  return s;
}

/* ═══════════ AI 提示词（由 app.js 决定是否发请求） ═══════════ */
export function promptStyleLock(samples, ask) {
  return [
    { role: 'system', content: '你是网文写作助手。必须严格模仿给定样本文风：句长、口语程度、人称、标点习惯、用词密度、段落节奏。不得引入样本里没有的文风特征；不写总结句，不写作者评论，不解释。' },
    { role: 'user', content: '【文风样本】\n' + samples + '\n\n【本次要写】' + ask + '\n\n只输出正文。' }
  ];
}
export function promptStoryboard(ctx, ask) {
  return [
    { role: 'system', content: '你是网文分镜助手。第一步只给 3–6 个分镜要点，每行一个，格式「谁 — 做什么 — 为什么（动机/后果）」。不要写正文，等我确认。' },
    { role: 'user', content: '【已知信息】\n' + ctx + '\n\n【本章要写】' + ask + '\n\n先只给分镜。' }
  ];
}
export function promptContinueChapter(samples, ctx, ask) {
  return [
    { role: 'system', content: '你是网文续写助手。严格贴合给定文风与既有设定，只续写正文，不总结、不点评。衔接前文，不要重复已写内容。' },
    { role: 'user', content: '【文风样本】\n' + samples + '\n\n【前情与设定】\n' + ctx + '\n\n【续写要求】' + (ask || '顺着往下写约 800 字，保持节奏，结尾留一个钩子。') + '\n\n只输出正文。' }
  ];
}