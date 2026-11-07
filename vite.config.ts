import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 托管环境要求每个请求都带 ?sharecode= 凭据，而浏览器加载
 * <script src="/assets/xxx.js"> 时不会带上地址栏里的凭据，会直接 403 白屏。
 * 这里把构建产物里静态写死的资源引用，换成一段引导脚本动态加载，
 * 从而在运行时把凭据拼到每个资源地址上。
 */
function credentialBootstrap(): Plugin {
  return {
    name: 'cv-credential-bootstrap',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const js = new Set<string>();
        const css = new Set<string>();
        let out = html.replace(/<script\b[^>]*\ssrc="(\/[^"]+)"[^>]*>\s*<\/script>/g, (_m, src) => {
          js.add(src);
          return '';
        });
        out = out.replace(/<link\b[^>]*rel="modulepreload"[^>]*href="(\/[^"]+)"[^>]*>/g, (_m, href) => {
          js.add(href);
          return '';
        });
        out = out.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="(\/[^"]+)"[^>]*>/g, (_m, href) => {
          css.add(href);
          return '';
        });
        const boot = [
          '<script>',
          '(function(){',
          'var KEY="cv-sharecode",code=null;',
          'try{code=new URLSearchParams(location.search).get("sharecode");}catch(e){}',
          'if(code){try{localStorage.setItem(KEY,code);}catch(e){}try{sessionStorage.setItem(KEY,code);}catch(e){}}',
          'if(!code){try{code=localStorage.getItem(KEY)||sessionStorage.getItem(KEY);}catch(e){}}',
          'function wc(u){return code?u+(u.indexOf("?")>=0?"&":"?")+"sharecode="+encodeURIComponent(code):u;}',
          // 可安装应用清单：把凭据带进 manifest，服务端据此生成带凭据的启动地址与图标
          // 凭据同时放进路径：托管网关会消费 ?sharecode=，服务端只能从路径取到
          'var mf=document.getElementById("cv-manifest");',
          'if(mf){mf.href=code?"/pwa/"+encodeURIComponent(code)+"/manifest.webmanifest?sharecode="+encodeURIComponent(code):"/manifest.webmanifest";}',
          'var ai=document.createElement("link");ai.rel="apple-touch-icon";ai.href=wc("/icons/apple-touch-icon.png");document.head.appendChild(ai);',
          'var CSS=' + JSON.stringify([...css]) + ',JS=' + JSON.stringify([...js]) + ';',
          'CSS.forEach(function(h){var l=document.createElement("link");l.rel="stylesheet";l.href=wc(h);document.head.appendChild(l);});',
          'JS.forEach(function(s){var el=document.createElement("script");el.type="module";el.src=wc(s);document.head.appendChild(el);});',
          'if(code&&"serviceWorker" in navigator){navigator.serviceWorker.register(wc("/sw.js"),{scope:"/"}).catch(function(){});}',
          '})();',
          '</script>',
        ].join('');
        return out.replace('</head>', boot + '</head>');
      },
    },
  };
}

/** 开发服务器同样提供可安装清单（生产环境由 Express 动态生成） */
function devManifest(): Plugin {
  return {
    name: 'cv-dev-manifest',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/(?:pwa\/([^/]+)\/)?manifest\.webmanifest/);
        if (!m) return next();
        let code = '';
        if (m[1]) {
          try {
            code = decodeURIComponent(m[1]);
          } catch {
            /* 忽略非法编码 */
          }
        } else {
          code = new URL(req.url, 'http://localhost').searchParams.get('sharecode') || '';
        }
        const q = code ? `?sharecode=${encodeURIComponent(code)}` : '';
        const icon = (name: string) => `/icons/${name}${q}`;
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(
          JSON.stringify({
            id: '/',
            name: '漫画库 ComicVault',
            short_name: '漫画库',
            description: '漫画存储、分话管理、在线阅读与分享',
            lang: 'zh-CN',
            start_url: `/${q}`,
            scope: '/',
            display: 'standalone',
            background_color: '#0f1115',
            theme_color: '#0f1115',
            icons: [
              { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
              { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
              { src: icon('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          }),
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), credentialBootstrap(), devManifest()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
