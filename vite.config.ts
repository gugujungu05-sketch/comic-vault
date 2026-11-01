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
        if (!js.size && !css.size) return html;
        const boot = [
          '<script>',
          '(function(){',
          'var KEY="cv-sharecode",code=null;',
          'try{code=new URLSearchParams(location.search).get("sharecode");}catch(e){}',
          'if(code){try{localStorage.setItem(KEY,code);}catch(e){}try{sessionStorage.setItem(KEY,code);}catch(e){}}',
          'if(!code){try{code=localStorage.getItem(KEY)||sessionStorage.getItem(KEY);}catch(e){}}',
          'function wc(u){return code?u+(u.indexOf("?")>=0?"&":"?")+"sharecode="+encodeURIComponent(code):u;}',
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

export default defineConfig({
  plugins: [react(), credentialBootstrap()],
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
