/* 墨读 · Service Worker
 * 目标：① 打开过一次后离线可用；② 静态资源"先用缓存秒开、后台默默更新"（stale-while-revalidate）；
 *       ③ 页面导航保持 network-first，确保拿到最新 HTML。
 * 说明：静态资源用 ?v= 做版本戳——改版时 URL 变化 + CACHE 名同步 +1，缓存自然失效并拉新，
 *       因此可以安全地"缓存优先"，把每次打开的网络往返降到接近 0（对国内弱网尤其关键）。
 * 不缓存 /api/ 请求（AI 代理）与跨域请求。
 */
// 版本对齐：CACHE 名与 index.html 中资源引用的 ?v= 保持同步（当前 v21）
const CACHE = 'modu-reader-v21';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/ai.js',
  './js/db.js',
  './js/parse.js',
  './js/analyze.worker.js',
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

  // ① 页面导航：network-first，失败回退缓存（保证离线/弱网也能打开）
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      } catch (err) {
        const hit = await caches.match(req, { ignoreSearch: true })
          || await caches.match('./index.html');
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // ② 静态资源：缓存优先 + 后台更新（秒开、不阻塞）
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = await c.match(req, { ignoreSearch: true }); // 忽略 ?v=：同一文件不同版本串不会共存（换版会清旧缓存）
    const revalidate = fetch(req).then((res) => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) return cached;                 // 有缓存立即返回，网络更新在后台进行
    const res = await revalidate;              // 首次无缓存才等网络
    return res || Response.error();
  })());
});