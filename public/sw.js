/**
 * ComicVault Service Worker
 *
 * 1) 托管环境（*.app.workbuddy.host）要求每个请求都带 ?sharecode= 凭据，
 *    这里统一拦截同源请求并补上凭据，避免 <img>、动态 chunk 等 403 白屏。
 * 2) 缓存应用外壳，让「安装为应用 / 桌面软件」在断网时仍能打开界面。
 *
 * 重要：/api/ 数据请求永不缓存，保证软件与网站看到的始终是同一份实时数据。
 */
const CACHE = 'cv-shell-v2';
let CODE = null;

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'cv-sharecode' && typeof data.code === 'string') {
    CODE = data.code;
  }
});

self.addEventListener('install', (event) => {
  // 注册时自身 URL 上带有 sharecode，取下来作为初始凭据
  try {
    const fromUrl = new URL(self.location.href).searchParams.get('sharecode');
    if (fromUrl) CODE = fromUrl;
  } catch {
    /* 忽略 */
  }
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => self.clients.claim()),
  );
});

function isShellAsset(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    /\.(?:js|css|woff2?|png|svg|ico|webp)$/i.test(pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  const needsCode = !!CODE && !url.searchParams.has('sharecode');
  if (needsCode) url.searchParams.set('sharecode', CODE);

  // 导航请求补码时用重定向，保留浏览器地址栏行为（原有逻辑，不可改）
  if (request.mode === 'navigate' && needsCode) {
    event.respondWith(Response.redirect(url.toString(), 302));
    return;
  }

  // 接口请求保持纯代理，绝不缓存（数据实时互通的关键）
  if (url.pathname.startsWith('/api/')) {
    if (!needsCode) return;
    event.respondWith(fetch(new Request(url.toString(), request)));
    return;
  }

  // 页面与静态资源：network-first，离线时回落缓存
  const target = needsCode ? new Request(url.toString(), request) : request;
  event.respondWith(
    (async () => {
      let cache = null;
      try {
        cache = await caches.open(CACHE);
      } catch {
        /* 隐私模式下缓存不可用 */
      }
      try {
        const res = await fetch(target);
        if (res && res.ok && cache && (isShellAsset(url.pathname) || request.mode === 'navigate')) {
          await cache.put(target, res.clone()).catch(() => {});
        }
        return res;
      } catch {
        if (cache) {
          const hit = (await cache.match(target)) || (await cache.match(request));
          if (hit) return hit;
        }
        if (request.mode === 'navigate') {
          const html =
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>暂时无法连接 · 漫画库</title>' +
            '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
            'background:#0f1115;color:#e9edf6;font:15px/1.8 -apple-system,"Microsoft YaHei",sans-serif;padding:30px}' +
            '.c{max-width:520px}h1{font-size:22px}p{color:#97a1b6}' +
            'button{margin-top:18px;padding:10px 18px;border:0;border-radius:9px;background:#7c6cff;color:#fff;font-size:14px;cursor:pointer}' +
            '</style></head><body><div class="c"><h1>暂时连不上 ComicVault 服务器</h1>' +
            '<p>请检查网络后重试。漫画与账号数据都保存在服务器端，恢复连接后重新加载即可，不会丢失。</p>' +
            '<button onclick="location.reload()">重新连接</button></div></body></html>';
          return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('暂时无法连接 ComicVault 服务器', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
