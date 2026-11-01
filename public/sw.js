/**
 * 托管环境（*.app.workbuddy.host）要求每个请求都带 ?sharecode= 凭据，
 * 而 <img>、动态 import 的 chunk、CSS 里的字体等请求无法在代码中逐个改写。
 * 这里用 Service Worker 统一拦截同源请求并补上凭据。
 * 本地运行（无 sharecode）时不会注册，完全不生效。
 */
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
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;
  if (url.searchParams.has('sharecode')) return;
  if (!CODE) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  url.searchParams.set('sharecode', CODE);
  // 导航请求用重定向，保留浏览器地址栏行为；其余直接代理
  if (request.mode === 'navigate') {
    event.respondWith(Response.redirect(url.toString(), 302));
    return;
  }
  event.respondWith(fetch(new Request(url.toString(), request)));
});
