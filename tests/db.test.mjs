/* 墨读 · 存储层测试（v5 → v6 升级、影印原文件存取）
 * 需要 fake-indexeddb：
 *   cd tests && npm i fake-indexeddb --no-save && node db.test.mjs
 * 不参与 tests/run.sh 的默认跑批（依赖额外包），改存储结构时手动跑一次。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert';

const DB_NAME = 'modu-reader';

/* 1. 先手工建一个 v5 的库，塞一本老书 */
await new Promise((resolve, reject) => {
  const r = indexedDB.open(DB_NAME, 5);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('books', { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
    db.createObjectStore('texts', { keyPath: 'bookId' });
    db.createObjectStore('marks', { keyPath: 'id' }).createIndex('bookId', 'bookId');
    db.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
    db.createObjectStore('materials', { keyPath: 'id' });
    db.createObjectStore('kv', { keyPath: 'k' });
    db.createObjectStore('reports', { keyPath: 'id' });
    db.createObjectStore('creations', { keyPath: 'id' });
    db.createObjectStore('threads', { keyPath: 'id' }).createIndex('bookId', 'bookId');
  };
  r.onsuccess = () => {
    const db = r.result;
    const t = db.transaction(['books', 'texts'], 'readwrite');
    t.objectStore('books').put({ id: 'old1', title: '老书', chapters: [], charCount: 3 });
    t.objectStore('texts').put({ bookId: 'old1', content: 'abc' });
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => reject(t.error);
  };
  r.onerror = () => reject(r.error);
});

/* 2. 走真实 db.js（DB_VER=6）打开，应自动升级 */
const db = await import('../js/db.js');
const h = await db.openDB();
const stores = [...h.objectStoreNames];
console.log('升级后 stores:', stores.join(', '));
assert.ok(stores.includes('files'), '缺少 files store');

/* 3. 旧数据还在 */
const oldBook = await db.getBook('old1');
assert.equal(oldBook?.title, '老书');
assert.equal(await db.getText('old1'), 'abc');

/* 4. 影印原文：存 → 取 → 删书时一起清掉 */
const blob = new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' });
await db.putFile('fx1', blob, { name: '扫描件.pdf', pageCount: 12 });
const rec = await db.getFile('fx1');
assert.equal(rec.pageCount, 12);
assert.equal(rec.name, '扫描件.pdf');
assert.equal(rec.size, 4);
const buf = new Uint8Array(await rec.blob.arrayBuffer());
assert.deepEqual([...buf], [37, 80, 68, 70]);

await db.putBook({ id: 'fx1', title: '扫描件', facsimile: true, chapters: [{ title: '第 1 页' }] });
await db.removeBook('fx1');
assert.equal(await db.getFile('fx1'), undefined, '删书应同时删掉原文件');
assert.equal(await db.getBook('fx1'), undefined);

/* 5. 备份导出不夹带二进制 */
await db.putFile('fx2', blob, { name: 'b.pdf', pageCount: 3 });
const dump = await db.exportAll();
assert.equal(dump.version, 6);
assert.ok(!JSON.stringify(dump).includes('"files"'), '备份不该包含 files');
assert.equal(JSON.stringify(dump).length < 2000, true);

console.log('存储层 8 项断言全过');
