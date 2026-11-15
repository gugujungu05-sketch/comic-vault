/* Android 本地界面的宿主桥适配层。
   Java 的 @JavascriptInterface 只能同步返回字符串，这里包装成 app.js 期望的 Promise 形态。 */
(function () {
  'use strict';
  var A = window.AndroidHost;
  if (!A) return;
  var j = function (s) { try { return JSON.parse(s); } catch (e) { return {}; } };
  window.CVAndroid = {
    version: '3.4.0.12',
    platform: 'android',
    api: function (o) {
      return Promise.resolve().then(function () { return j(A.api(JSON.stringify(o))); });
    },
    asset: function (p) { return A.asset(p); },
    getConfig: function () { return Promise.resolve(j(A.getConfig())); },
    setServer: function (u) { return Promise.resolve(A.setServer(u)); },
    setMode: function (m) { return Promise.resolve({ ok: true }); },
    setTheme: function (t) { return Promise.resolve(A.setTheme(t)); },
    checkUpdate: function () { return Promise.resolve().then(function () { return j(A.checkUpdate()); }); },
    /* 软件内下载新版 APK：Java 用系统下载管理器，旧宿主降级为浏览器打开 */
    installUpdate: function (u) {
      try {
        if (typeof A.installUpdate !== 'function') {
          A.openExternal(u);
          return Promise.resolve({ ok: true, opened: true });
        }
        return Promise.resolve(j(A.installUpdate(u)));
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e) });
      }
    },
    siteUrl: function () { return Promise.resolve(A.siteUrl()); },
    openExternal: function (u) { return Promise.resolve(A.openExternal(u)); },
    openDownload: function () { return Promise.resolve(A.openDownload()); },
    openReader: function (c, ch) { return Promise.resolve(A.openReader(c, ch)); },
    getReaderInit: function () { return Promise.resolve({}); },
    closeReader: function () { return Promise.resolve(A.closeReader()); },
    toggleFullscreen: function () { return Promise.resolve(); },

    /* 原生多选：Java 打开系统文件选择器（可从「浏览其他应用中的文件」进 Kotatsu
       等漫画来源），用户确认后通过 window.__cvFilesPicked 回调返回 [{id,name}]。 */
    pickFiles: function () {
      return new Promise(function (resolve) {
        var done = false;
        var finish = function (list) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { delete window.__cvFilesPicked; } catch (e) { window.__cvFilesPicked = null; }
          resolve(Array.isArray(list) ? list : []);
        };
        var timer = setTimeout(function () { finish([]); }, 180000);
        window.__cvFilesPicked = finish;
        A.pickFiles();
      });
    },
    pickFolder: function () { return window.CVAndroid.pickFiles(); },
    resolvePaths: function (p) { return Promise.resolve(p || []); },
    /* 同步返回选中图片的缩略图 data URL，供导入网格预览 */
    thumb: function (id) { try { return A.thumb(id) || ''; } catch (e) { return ''; } },
    /* 保存一张图片到系统相册（分享二维码 / 阅读器单页）。
       WebView 里 <a download> 对 data URL 完全不生效，必须由 Java 侧 MediaStore 落盘。 */
    saveImage: function (dataUrl, name) {
      try {
        if (typeof A.saveImage !== 'function') return Promise.resolve({ ok: false, unsupported: true });
        return Promise.resolve(j(A.saveImage(dataUrl, name)));
      } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
    },
    /* 下载服务器上的文件（分话 / 整本导出）到公共「下载」目录 */
    saveApiFile: function (apiPath, defaultName) {
      try {
        if (typeof A.saveApiFile !== 'function') return Promise.resolve({ ok: false, unsupported: true });
        return Promise.resolve(j(A.saveApiFile(apiPath, defaultName)));
      } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
    },
    /* 把一张图片 URL 读成 data URL（阅读器单页保存用），带 sharecode 凭据 */
    imageToDataUrl: function (url) {
      try {
        if (typeof A.imageToDataUrl !== 'function') return Promise.resolve('');
        return Promise.resolve(A.imageToDataUrl(url) || '');
      } catch (e) { return Promise.resolve(''); }
    }
  };
})();
