/* IndexedDB 封装 —— 所有数据只在本机 */

const DB_NAME = 'modu-reader';
const DB_VER = 6;
let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('marks')) {
        const s = db.createObjectStore('marks', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('materials')) {
        const s = db.createObjectStore('materials', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
        s.createIndex('kind', 'kind');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('reports')) {
        const r = db.createObjectStore('reports', { keyPath: 'id' });
        r.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('creations')) {
        const s = db.createObjectStore('creations', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      /* v5 新增：伏笔 / 线头台账 */
      if (!db.objectStoreNames.contains('threads')) {
        const s = db.createObjectStore('threads', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      /* v6 新增：影印模式的原文件（图片版 PDF 整份存本地，阅读时按页渲染） */
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'bookId' });
      }
    };
    r.onsuccess = () => { _db = r.result; resolve(_db); };
    r.onerror = () => reject(r.error);
  });
}

const reqP = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const doneP = (t) => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error);
});

async function put(store, val) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).put(val);
  await doneP(t);
  return val;
}

async function get(store, key) {
  const db = await openDB();
  const t = db.transaction(store, 'readonly');
  return reqP(t.objectStore(store).get(key));
}

async function del(store, key) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  await doneP(t);
}

async function all(store) {
  const db = await openDB();
  const t = db.transaction(store, 'readonly');
  return reqP(t.objectStore(store).getAll());
}

async function byIndex(store, index, key) {
  const db = await openDB();
  const t = db.transaction(store, 'readonly');
  return reqP(t.objectStore(store).index(index).getAll(key));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ── 书籍 ── */
export const listBooks = async () => {
  const bs = await all('books');
  return bs.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
};
export const getBook = (id) => get('books', id);
export const putBook = (b) => put('books', b);
export const getText = async (id) => {
  const r = await get('texts', id);
  return r ? r.content : '';
};
export const putText = (bookId, content) => put('texts', { bookId, content });

/* ── 影印模式的原文件（v6） ── */
export const putFile = (bookId, blob, meta = {}) =>
  put('files', { bookId, blob, name: meta.name || '', pageCount: meta.pageCount || 0, size: blob?.size || 0, at: Date.now() });
export const getFile = (bookId) => get('files', bookId);
export const deleteFile = (bookId) => del('files', bookId);
export async function listFilesMeta() {
  const fs = await all('files');
  return fs.map(f => ({ bookId: f.bookId, name: f.name, pageCount: f.pageCount, size: f.size }));
}

export async function removeBook(id) {
  const db = await openDB();
  const t = db.transaction(['books', 'texts', 'marks', 'notes', 'threads', 'files'], 'readwrite');
  t.objectStore('books').delete(id);
  t.objectStore('texts').delete(id);
  t.objectStore('files').delete(id);
  const mi = t.objectStore('marks').index('bookId');
  const mreq = mi.openKeyCursor(IDBKeyRange.only(id));
  mreq.onsuccess = (e) => {
    const c = e.target.result;
    if (c) { t.objectStore('marks').delete(c.primaryKey); c.continue(); }
  };
  const ni = t.objectStore('notes').index('bookId');
  const nreq = ni.openKeyCursor(IDBKeyRange.only(id));
  nreq.onsuccess = (e) => {
    const c = e.target.result;
    if (c) { t.objectStore('notes').delete(c.primaryKey); c.continue(); }
  };
  const ti = t.objectStore('threads').index('bookId');
  const treq = ti.openKeyCursor(IDBKeyRange.only(id));
  treq.onsuccess = (e) => {
    const c = e.target.result;
    if (c) { t.objectStore('threads').delete(c.primaryKey); c.continue(); }
  };
  await doneP(t);
}

/* ── 标记 ── */
export const listMarks = (bookId) => byIndex('marks', 'bookId', bookId);
export const putMark = (m) => put('marks', m);
export const deleteMark = (id) => del('marks', id);

/* ── 笔记 ── */
export const listNotes = (bookId) => byIndex('notes', 'bookId', bookId);
export const putNote = (n) => put('notes', n);
export const deleteNoteDB = (id) => del('notes', id);

/* ── 素材 ── */
export const listMaterials = async () => {
  const ms = await all('materials');
  return ms.sort((a, b) => b.createdAt - a.createdAt);
};
export const listMaterialsByBook = (bookId) => byIndex('materials', 'bookId', bookId);
export const putMaterial = (m) => put('materials', m);
export const deleteMaterial = (id) => del('materials', id);

/* ── 拆书报告 ── */
export const listReports = async () => {
  const rs = await all('reports');
  return rs.sort((a, b) => b.at - a.at);
};
export const putReport = (r) => put('reports', r);
export const deleteReport = (id) => del('reports', id);

/* ── 创作设定 ── */
export const listCreations = async () => {
  const cs = await all('creations');
  return cs.sort((a, b) => b.createdAt - a.createdAt);
};
export const listCreationsByBook = (bookId) => byIndex('creations', 'bookId', bookId);
export const putCreation = (c) => put('creations', c);
export const deleteCreation = (id) => del('creations', id);

/* ── 伏笔 / 线头台账（v5） ── */
export const listThreads = async (bookId) => {
  const ts = await byIndex('threads', 'bookId', bookId);
  return ts.sort((a, b) => a.offset - b.offset);
};
export const putThread = (t) => put('threads', t);
export const deleteThread = (id) => del('threads', id);

/* ── KV ── */
export async function getKV(k, def = null) {
  const r = await get('kv', k);
  return r ? r.v : def;
}
export const setKV = (k, v) => put('kv', { k, v });

/* ── 备份 ── */
/* 注意：影印模式的原文件（files）不入备份——体积大且是二进制，JSON 装不下；
   恢复备份后这些书会提示「原文件不在，需重新导入」。 */
export async function exportAll() {
  const [books, texts, marks, notes, materials, reports, creations, threads] = await Promise.all([
    all('books'), all('texts'), all('marks'), all('notes'), all('materials'), all('reports'), all('creations'), all('threads')
  ]);
  return { app: 'modu-reader', version: 6, exportedAt: new Date().toISOString(), books, texts, marks, notes, materials, reports, creations, threads };
}

export async function importAll(data) {
  if (!data || data.app !== 'modu-reader') throw new Error('不是墨读的备份文件');
  const db = await openDB();
  const t = db.transaction(['books', 'texts', 'marks', 'notes', 'materials', 'reports', 'creations', 'threads'], 'readwrite');
  for (const b of data.books || []) t.objectStore('books').put(b);
  for (const x of data.texts || []) t.objectStore('texts').put(x);
  for (const m of data.marks || []) t.objectStore('marks').put(m);
  for (const n of data.notes || []) t.objectStore('notes').put(n);
  for (const m of data.materials || []) t.objectStore('materials').put(m);
  for (const r of data.reports || []) t.objectStore('reports').put(r);
  for (const c of data.creations || []) t.objectStore('creations').put(c);
  for (const th of data.threads || []) t.objectStore('threads').put(th);
  await doneP(t);
  return (data.books || []).length;
}

export async function clearAll() {
  const db = await openDB();
  const t = db.transaction(['books', 'texts', 'marks', 'notes', 'materials', 'reports', 'creations', 'threads', 'files'], 'readwrite');
  ['books', 'texts', 'marks', 'notes', 'materials', 'reports', 'creations', 'threads', 'files'].forEach(s => t.objectStore(s).clear());
  await doneP(t);
}

export async function estimateStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}