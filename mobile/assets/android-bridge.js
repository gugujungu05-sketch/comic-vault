/* Android 本地界面的宿主桥适配层。
   Java 的 @JavascriptInterface 只能同步返回字符串，这里包装成 app.js 期望的 Promise 形态。 */
(function () {
  'use strict';
  var A = window.AndroidHost;
  if (!A) return;
  var j = function (s) { try { return JSON.parse(s); } catch (e) { return {}; } };
  window.CVAndroid = {
    version: '3.4.0.5',
    platform: 'android',
    api: function (o) {
      return Promise.resolve().then(function () { return j(A.api(JSON.stringify(o))); });
    },
    asset: function (p) { return A.asset(p); },
    getConfig: function () { return Promise.resolve(j(A.getConfig())); },
    setServer: function (u) { return Promise.resolve(A.setServer(u)); },
    setTheme: function (t) { return Promise.resolve(A.setTheme(t)); },
    checkUpdate: function () { return Promise.resolve().then(function () { return j(A.checkUpdate()); }); },
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
    thumb: function (id) { try { return A.thumb(id) || ''; } catch (e) { return ''; } }
  };
})();
