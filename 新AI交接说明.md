# 墨读 · 新 AI 交接说明

> 面向"接手本项目的新 AI / 开发者"。目标：拿到这个 zip 就能快速理解**当前真实状态**并继续开发。
> 更新时间：2026-10-19 ｜ 当前版本 **v23**（版本号含义见 §3）

---

## 0. 一句话

**墨读（modu-reader）** 是**本地优先**的网文「**阅读 + 拆书 + 写作工位**」工具：纯前端、**无框架、无构建步骤**；数据全部存在浏览器 **IndexedDB**；可选接入 **OpenAI 兼容**大模型。

---

## 1. 怎么跑 / 怎么校验

- **项目根**（含 `index.html`）：`墨读阅读器/`
- **运行**：项目根执行 `python3 server.py`（自动挑 8765–8785 端口并开浏览器）。
  - ⚠️ **必须用 `http://` 打开**（IndexedDB 在 `file://` 下不可用）。
  - 仅本机：`python3 server.py --local`。
- **语法校验**：`bash check.sh`（逐个 `node --input-type=module --check` 校验 `js/*.js` 与 `sw.js`；ES module 直接 `node --check` 会报错，必须带 `--input-type=module`）。
- **纯逻辑测试（无浏览器）**：把 `js/xxx.js` 拷成 `xxx.mjs`（若文件里有 `import ... from './parse.js'`，改成 `'./parse.mjs'`），用 `node xxx.mjs` 跑断言。

---

## 2. 目录 / 模块职责

```
墨读阅读器/
├── index.html          页面骨架（侧栏书架/目录、阅读器、右侧面板、各类弹窗）。引用 styles.css / styles-desk.css / js/app.js，均带 ?v= 版本串
├── styles.css          主样式（纸墨主题 + 面板 + 弹窗 + @font-face 内置字体）
├── styles-desk.css     写作工位样式（.desk 面板）
├── manifest.json       PWA 清单
├── sw.js               Service Worker（导航 network-first；同源静态资源“缓存优先+后台更新”；CACHE 名形如 modu-reader-vNN）
├── server.py           本地静态托管 + /api/llm 反向代理
├── start.sh/.command/.bat  三平台启动脚本
├── check.sh            一键语法校验
├── 交接说明.md          详细技术交接（数据表 / 功能地图 / 已知限制）
├── 使用说明.md          面向用户
├── 新AI交接说明.md      本文件
├── js/
│   ├── app.js          主控制器/路由/渲染；import db.js / parse.js / ai.js / writer.js / exportdocx.js
│   ├── ai.js           模型调用封装 + 本地分析规则 + 提示词 + mdToHtml
│   ├── db.js           IndexedDB 封装 + 各 store CRUD + 备份/导入/清空
│   ├── parse.js        多格式解析(TXT/DOCX/EPUB/PDF) + 分章(buildChapters/candidateLines) + 图片版/坏文字层 PDF 的 OCR 与试读
│   ├── analyze.worker.js  module worker：把「拆书 / 稿件体检」的重计算搬离主线程（app.js 内有主线程兜底）
│   ├── writer.js       写作工位：日更追踪·存稿进度·伏笔台账·人物一致性·审稿·过审自查·AI 味检测·平台导出
│   └── exportdocx.js   纯前端零依赖 Word(.docx) 导出（自实现 ZIP+OOXML）
├── vendor/             pdf.js、mammoth、jszip（按需动态加载）
│   └── fonts/          内置阅读字体（noto-serif-sc-400.woff2 / zcool-xiaowei-400.woff2 + OFL 授权）
└── icons/              PWA 图标
```

---

## 3. 关键约定（改代码前必读）

- **版本体系（三套，务必分清）**：
  - `js/db.js` 的 `DB_VER`（IndexedDB schema）= **5**。
  - `index.html` 的资源版本串 `?v=NN`（**3 处**：styles.css / styles-desk.css / js/app.js）= **当前 23**。
  - `sw.js` 的 `CACHE`（形如 `modu-reader-vNN`）= **当前 v23**。
  - 约定：**改前端时，`index.html` 的 ?v= 与 `sw.js` 的 CACHE 一起 +1**。`ai.js` / `parse.js` / `analyze.worker.js` 没有 ?v=，靠 SW 换 CACHE 名让旧缓存整体失效。
- **分章数据结构**：全书正文是**一个连续字符串**；`book.chapters[i] = {title, start, end, auto?, matter?, lead?}`，`start/end` 是相对正文的**绝对字符偏移**；`matter ∈ {'', 'pre', 'open', 'post'}`。所有"跳回原文"靠偏移（DOM 上用 `data-goto-at` / DOM 函数 `gotoOffset`）。
- **IndexedDB**：库名 `modu-reader`（DB_VER=5）。stores：`books, texts, marks, notes, materials, kv, reports, creations, threads`。**加/改 store 必须把 DB_VER +1 并在 `onupgradeneeded` 写迁移。**
- **localStorage 键**：`modu.ai.settings`（AI 配置）、`modu.prefs`（阅读偏好：size/lh/theme/family/indent/width）、`modu.usage`（用量）、`modu.core.<bookId>`、`modu.fontTip`（字体一次性提示）；写作工位相关键见 `writer.js`。
- **AI 调用**：统一 `ai.askAI(messages, {onDelta, signal, maxTokens})`（OpenAI 兼容、流式 SSE）；Key 只存本机 localStorage。可选走 `server.py` 的 `/api/llm` 代理（解决浏览器 CORS）。
- **Service Worker 策略**：导航 network-first（失败回退缓存）；同源静态资源"缓存优先 + 后台更新"（`caches.match(req, {ignoreSearch:true})`）；不缓存 `/api/` 与跨域；预缓存列表见 sw.js 的 `CORE`。
- **Web Worker**：`js/analyze.worker.js` 是 module worker（`new Worker(new URL('./analyze.worker.js', import.meta.url), {type:'module'})`），app.js 里带主线程兜底（失败自动回退，功能不丢）。
- **内置字体**：`vendor/fonts/` 两个 woff2 + `styles.css` 里的 `@font-face`（`"MODU Song"`=思源宋体 Noto Serif SC、`"MODU Kai"`=站酷小薇 ZCOOL XiaoWei）。**按需加载**：默认黑体（系统字体）不下载；用户选「宋 / 楷」时才下载，之后被 SW 缓存、可离线用。授权文件为 OFL 1.1，见 `vendor/fonts/LICENSE-*.txt`。
- 中文排版：代码字符串用 ASCII 直引号；正文文案用中文引号。

---

## 4. 核心函数地图

- **app.js**：`init`（启动）、`openBook`、`showWelcome`、`renderTOC`、`renderReader`、`buildParagraph`、`updateProgress`、`showOutline`（拆书/本章脉络/情节概括/写作借鉴/体检的统一入口）、`showWbcheck`、`runAiToc`（AI 整理目录）、`applyAiToc`/`undoAiToc`、`applyPrefs`（阅读偏好写 CSS 变量）、朗读 `$('#btnSpeak')` 处理器、`toast`。
- **parse.js**：`parseFile`（主入口）、`splitChapters`（本地规则分章）、`buildChapters`（由候选标题行构建章节，供本地与 AI 共用）、`candidateLines`（抽取"像标题"的行，供 AI 判断）、`isHeading`、`matterOf`、`decodeText`、`ocrPdf`。
- **ai.js**：`askAI` / `continueAI`、`getAI`/`setAI`/`aiReady`、`promptToc`/`parseTocReply`（AI 整理目录）、`localFramework`、`paceBody`（节奏/水章）、`buildInlineNotes`（文内批注）、`wbcheckHTML`、各 `promptXxx`。
- **db.js**：`openDB`、`listBooks`/`getBook`/`putBook`、`getText`/`putText`、`listMarks`/`putMark`、`listNotes`/`putNote`、`listMaterials`、`listReports`、`listCreations`、`listThreads`、`getKV`/`setKV`、`exportAll`/`importAll`/`clearAll`。

---

## 5. 最近改动历史（v17 → v23）

- **v17（性能）**：SW 由"每次强制回源"改为缓存优先 + 后台更新(SWR)；滚动改 rAF 节流；重活前先让出绘制。
- **v18**：拆书 / 稿件体检搬进 Web Worker（带主线程兜底）。
- **v19**：文内批注数量由写死(推荐 3 / 水 8)改为按比例（推荐 min20 / max3 / 15%；水 min12 / max3 / 6%）；序言不判水。
- **v20**：目录识别规则收紧（`第X章` 行尾锚定、去句号/逗号、新增 `RE_VOL`、`RE_SPECIAL2` 必须带分隔符、目录页去密逻辑改看"与下一标题间距"）。
- **v21**：新增「**AI 整理目录**」——`candidateLines` 抽候选行 → 模型挑真标题（排除目录页/正文句）→ `buildChapters` 收口 → 预览弹窗 → 应用 / 一键撤销。
- **v22**：① 修复**朗读**（原代码首次点击就判"无语音"退出；改为等语音列表就绪再读、无中文语音也仍尝试、加 Chrome 长文保活、错误提示更明确）；② 新增**内置字体**（宋/楷），解决"手机只有黑体、换字体看不出变化"。
- **v23**：① **图片版 / 文字层损坏的 PDF 可直接导入**——不再先弹"用 WPS 转"的说教：自动试认前 5 页 → 弹样张给用户验货 → 「识别全本（可随时停）」或「只读这 5 页」。OCR worker 常驻复用，去掉原先 90 秒死线；全本按页显示进度条、可中止，已识别的部分照存。② **PDF 文字层诊断分三类**——`image`（多数页无文字）/ `encoding`（有文字层但大量未映射字符，WPS 导出的可搜索 PDF 最常见）/ `sparse`（密度过低），报错文案分开说，不再一律叫"扫描版"。③ **行重建加固**——行容差按字号自适应（原固定 3.2pt，逐字抖动 1~2pt 的 OCR 文字层会被拆散）、优先用 `hasEOL` 断行、过滤 U+FFFD 与私用区字符、`width` 缺失时按字数估算 gap。④ 新增纯逻辑测试（`pdfItemsToLines` / `pdfTextQuality`，10 项断言）。

---

## 6. 发布 / 上线流程（重要）

- **本环境没有 `git`**。上线走 **GitHub Contents API**（Python `urllib`）：
  1. `GET https://api.github.com/repos/gudeli123/modu-reader/contents/<path>?ref=main` 取该文件 `sha`；
  2. `PUT` 同一 URL，body = `{ "message": "...", "content": <base64>, "sha": <sha>, "branch": "main" }`，请求头 `Authorization: Bearer <TOKEN>`；
  3. Token 建议**通过环境变量传入脚本**（如 `env GH_TOKEN=...`），不要写进任何文件。
- **仓库**：`gudeli123/modu-reader`（分支 `main`）；**线上**：`https://gudeli123.github.io/modu-reader/`。推送后 Pages 自动构建，轮询 `index.html` 的 `?v=`（带 `?cb=` 破缓存）确认生效。
- ⚠️ **凭证安全（务必执行）**：本项目的 GitHub Token **曾在对话中明文出现过，应视为已泄露**。接手者**不要硬编码 token、不要把 token 写进任何交付物**；并提醒用户去 GitHub 撤销/重置那枚 token（撤销不影响已上线内容）。

---

## 7. 当前真实状态 & 待办

- **本地文件 = v23**（v22 全部内容 + 图片版 PDF 直读 + OCR 试读/可中止 + PDF 行重建加固）。
- **线上 = v22（2026-10-19 实测复核）**：GitHub Pages 上 `index.html` 的 `?v=` 为 22、
  `sw.js` 的 `CACHE` 为 `modu-reader-v22`、`vendor/fonts/noto-serif-sc-400.woff2` HTTP 200 且 1,506,904 字节完整；
  本交接包与远端 `main` 的 31 个文件中有 29 个 blob sha 完全一致。
  → 原「v22 尚未推送上线」的判断**已过期**，不要再按那个差集重推。
  **复核方式**：`python3 <skill>/scripts/publish.py <项目根>`（默认 dry-run，只列差异不推送），
  以它按 blob sha 算出的结果为准，不要以本文档的文字描述为准。
- 待办：
  1. **把 v23 推上线**（用户已在本地验收时）：`python3 <skill>/scripts/publish.py <项目根> --push --verify`。
     差集应为 `index.html` / `styles.css` / `js/app.js` / `js/parse.js` / `sw.js` 五个文件。
  2. 用户此前对"水章/序言第 3 项"的确认**未回复**（可能指"灵敏度三档"或"批注全量列表"），待其确认后补做。
  3. 安卓 **TWA** 打包前置（`assetlinks.json` 放到域名根 + 建 `gudeli123.github.io` 用户页仓库 + SHA-256 指纹）——用户已明确"先不用做"，**勿主动重启**。
  4. 【安全】提醒用户撤销曾泄露的 GitHub Token。

---

## 8. 已知限制（如实转达用户）

- 人名识别、情绪/水章/钩子、伏笔/一致性等判断均为**启发式**，只给信号、不打分。
- **图片版 PDF 的 OCR**：Tesseract 从 CDN 加载（首次约 15MB），每页 3–8 秒。中文竖排、繁体、旧印刷体
  识别率一般；**只产出可读文本，不做版面还原**——图片、表格结构会丢。
- AI 输出可能被 `maxTokens` 截断（已提供「继续写」）。
- **朗读**依赖系统/浏览器的语音合成：部分设备（例如某些华为浏览器）可能**没有中文 TTS 语音** → 读不出声；代码已做"等语音就绪 + 无中文语音仍尝试 + 明确提示"。这不是网页能完全绕过的。
- **字体**：宋/楷为**内置**字体，首次切换需联网下载 1–2MB；黑体用系统字体。设备缺字体时，未内置的字体无法显示。

---

## 9. 继续开发建议

1. **写作工位（`writer.js`）** 是面向"落到动笔"的核心，可优先扩展。
2. **AI 生成「停止」**：`askAI` 已支持 `AbortSignal`，在各调用处传 `AbortController.signal` 并加「停止」按钮即可。
3. `server.py` 默认监听 `0.0.0.0`（局域网可访问），可改默认 `127.0.0.1`，需要时再加 `--lan`。
4. **SW 新版本刷新提示**：有新版时提示用户刷新。
5. 若在 `app.js` / `ai.js` 中发现**疑似重复实现**（例如两处 SW 注册、两套超时/重试、两套 markdown 渲染），先确认哪套被实际引用，以被引用为准清理残留，避免互相覆盖；改完 `bash check.sh` 并冒烟验证。

---

**更完整的技术细节见同目录 `交接说明.md`**（数据表结构 / 功能地图 / 已知限制）；面向用户的操作见 `使用说明.md`。