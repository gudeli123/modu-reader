/* 墨读 · 后台分析 Worker
 * 把「拆书 / 进阶体检」这类要遍历全书的纯本地计算搬离主线程，避免点击后界面冻结。
 * 直接复用 ai.js 里的规则引擎（它不依赖 DOM），算完把 HTML 字符串回传主线程。
 * 若本文件或 ai.js 在 Worker 里加载失败，app.js 会自动回退到主线程同步计算，功能不受影响。
 */
import * as ai from './ai.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  const { id, job } = msg;
  const p = msg.payload || {};
  try {
    let result;
    if (job === 'wbcheck') {
      result = { wbcheck: ai.wbcheckHTML(p.book, p.content, p.books) };
    } else if (job === 'book') {
      result = {
        character: ai.characterHTML(p.book, p.content),
        opening: ai.openingHTML(p.book, p.content),
        emotion: ai.emotionHTML(p.book, p.content),
        write: ai.writeHTML(p.book, p.content),
        vols: ai.volTableHTML(ai.localVolumes(p.book, p.content), true)
      };
    } else {
      throw new Error('未知任务: ' + job);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};