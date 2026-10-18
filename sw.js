/* 墨读 · Service Worker
 * 目标：① 离线也能打开；② 联网时始终取最新版本（network-first）。
 * 策略：同源 GET 走 network-first，成功则回写缓存；断网时回退缓存。
 * 不缓存 /api/ 请求（AI 代理）与跨域请求。
 */
const CACHE = 'modu-reader-v4';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/ai.js',
  './js/db.js',
  './js/parse.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(
      CORE.map((u) => c.add(u).catch(() => {})) // 单个失败不影响整体
    ))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;    // 跨域（CDN 等）不介入
  if (url.pathname.startsWith('/api/')) return;        // AI 代理不缓存

  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });   // 强制回源校验，避免读到旧缓存
      if (res && res.ok) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const idx = await caches.match('./index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});