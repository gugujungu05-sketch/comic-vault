/* 独立阅读窗口：键盘翻页、单/双页、条漫、上一话/下一话，不依赖网站页面 */
(() => {
  'use strict';
  const Host = window.cvApp || window.CVAndroid;
  const isMobile = !!window.CVAndroid;
  if (isMobile) document.body.classList.add('mobile');
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let comic = null, chapterId = '', comicId = '', pages = [];
  let index = 0, spread = false, webtoon = false, zoom = 100, rtl = false;
  let lastReport = 0;
  let isNovel = false, novelText = '', novelRatio = 0, fontSize = 19;
  /* 阅读方式记忆：支持「全部 / 仅这本 / 仅本话」三种作用范围 */
  const PREFS_KEY = 'cv-reader-prefs';
  const SCOPE_KEY = 'cv-reader-scope';
  const DEF_PREFS = { spread: false, webtoon: false, zoom: 100 };
  let prefScope = 'all';
  function readPart(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } }
  function prefKey(scope) {
    if (scope === 'chapter') return `${PREFS_KEY}:chapter:${chapterId}`;
    if (scope === 'comic') return `${PREFS_KEY}:comic:${comicId}`;
    return PREFS_KEY;
  }
  /** 记忆优先级：本话 > 整本 > 全部；direction 缺省时沿用漫画自身方向 */
  function loadPrefs() {
    try { const s = localStorage.getItem(SCOPE_KEY); prefScope = (s === 'comic' || s === 'chapter') ? s : 'all'; } catch {}
    const g = readPart(PREFS_KEY), c = readPart(`${PREFS_KEY}:comic:${comicId}`), ch = readPart(`${PREFS_KEY}:chapter:${chapterId}`);
    return { ...g, ...c, ...ch };
  }
  function savePrefs() {
    try {
      localStorage.setItem(SCOPE_KEY, prefScope);
      const snapshot = { spread, webtoon, zoom, rtl, direction: rtl ? 'rtl' : 'ltr' };
      localStorage.setItem(prefKey(prefScope), JSON.stringify(snapshot));
      /* 方向始终写一份全局，保证跨漫画一致 */
      if (prefScope !== 'all') localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPart(PREFS_KEY), direction: snapshot.direction }));
    } catch {}
  }
  function applyPrefs(p) {
    spread = p.spread === undefined ? !!DEF_PREFS.spread : !!p.spread;
    webtoon = p.webtoon === undefined ? !!DEF_PREFS.webtoon : !!p.webtoon;
    zoom = Math.min(200, Math.max(50, Number(p.zoom) || DEF_PREFS.zoom));
    if (p.direction === 'ltr' || p.direction === 'rtl') rtl = p.direction === 'rtl';
    else if (typeof p.rtl === 'boolean') rtl = p.rtl;
    syncDirUI();
  }
  function changeScope(next) {
    prefScope = next;
    try {
      localStorage.removeItem(`${PREFS_KEY}:chapter:${chapterId}`);
      localStorage.removeItem(`${PREFS_KEY}:comic:${comicId}`);
    } catch {}
    savePrefs();
    toastR(next === 'all' ? '设置应用到全部' : next === 'comic' ? '设置应用到这本' : '设置应用到本话');
  }
  function syncDirUI() {
    const b = $('#btnDir');
    if (b) { b.textContent = rtl ? '从右往左' : '从左往右'; b.classList.toggle('active', rtl); }
    document.body.classList.toggle('rtl', rtl);
    const s = $('#prefScope'); if (s) s.value = prefScope;
    /* 底栏靠 row-reverse 镜像位置；这里只把文字/箭头方向跟着翻，语义恒定 */
    const prev = $('#btnPrev'), next = $('#btnNext');
    if (prev) prev.innerHTML = rtl ? '上一页 ›' : '‹ 上一页';
    if (next) next.innerHTML = rtl ? '‹ 下一页' : '下一页 ›';
    const prevCh = $('#btnPrevChapter'), nextCh = $('#btnNextChapter');
    if (prevCh) { prevCh.textContent = rtl ? '»' : '«'; prevCh.title = '上一话 ['; }
    if (nextCh) { nextCh.textContent = rtl ? '«' : '»'; nextCh.title = '下一话 ]'; }
  }

  /** 把阅读进度同步到服务器（书架/详情页显示"上次读到"，节流 4 秒） */
  function reportProgress(force = false) {
    const t = Date.now();
    if (!force && t - lastReport < 4000) return;
    lastReport = t;
    api('PUT', `/api/comics/${comicId}/progress`, { body: { chapterId, pageIndex: index } }).catch(() => {});
  }

  async function api(method, path, opts = {}) {
    const r = await Host.api({ method, path, query: opts.query || {}, body: opts.body });
    if (r.status >= 400) throw new Error((r.data && r.data.error) || `请求失败 (${r.status})`);
    return r.data;
  }
  const asset = (p) => { try { return Host.asset(p); } catch { return p; } };

  async function init() {
    /* 阅读器跟随主界面 / 网站所选主题（localStorage 同源共享） */
    try {
      const t = localStorage.getItem('cv-theme') || '';
      if (['dark', 'light', 'sea', 'forest', 'sunset', 'sakura'].includes(t)) {
        document.documentElement.dataset.theme = t;
      }
    } catch { /* 隐私模式下忽略 */ }
    const qs = new URLSearchParams(location.search);
    comicId = qs.get('comic') || '';
    chapterId = qs.get('chapter') || '';
    if (!comicId && Host.getReaderInit) {
      const i = await Host.getReaderInit();
      comicId = i.comicId || ''; chapterId = i.chapterId || '';
    }
    if (!comicId) { $('#stage').innerHTML = '<div class="r-empty">缺少漫画参数</div>'; return; }
    try { comic = await api('GET', `/api/comics/${comicId}`); }
    catch (err) { $('#stage').innerHTML = `<div class="r-empty">${esc(err.message)}</div>`; return; }
    const chapters = comic.chapters || [];
    /* 方向默认值沿用漫画自身设置；用户记忆过的方向优先 */
    const gdir = readPart(PREFS_KEY)['direction'];
    if (!gdir && (comic.direction === 'ltr' || comic.direction === 'rtl')) rtl = comic.direction === 'rtl';
    isNovel = comic.kind === 'novel';
    if (isNovel) {
      webtoon = true; // 小说天然上下滑动连续阅读
      try { fontSize = Number(localStorage.getItem('cv-novel-font')) || 19; } catch {}
      $('#btnWebtoon').textContent = '文字 ✓';
      $('#btnSpread').style.display = 'none';
      $('#btnZoomIn').title = '放大字号'; $('#btnZoomOut').title = '缩小字号';
      $('#slider').max = 1000;
    }
    if (!chapterId) chapterId = chapters[0]?.id || '';
    $('#chapterSel').innerHTML = chapters.map((c) =>
      `<option value="${esc(c.id)}" ${c.id === chapterId ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
    $('#rTitle').textContent = comic.title || '阅读器';
    applyPrefs(loadPrefs());
    if (isNovel) webtoon = true;   // 小说强制连续阅读
    loadChapter(chapterId);
  }
  async function loadChapter(id) {
    chapterId = id;
    /* 仅本话范围：切到别的话时按那一话的记忆重新应用 */
    if (prefScope === 'chapter') applyPrefs(loadPrefs());
    const ch = (comic.chapters || []).find((c) => c.id === id);
    pages = ch?.pages || [];
    index = 0;
    $('#chapterSel').value = id;
    $('#stage').scrollTop = 0;
    if (isNovel) {
      // 小说：按需读取本章正文，进度用 0~1000 千分比定位
      novelRatio = 0;
      $('#slider').max = 1000; $('#slider').value = 0;
      $('#stage').className = 'r-stage novel';
      $('#stage').innerHTML = '<div class="r-empty">正在加载本章…</div>';
      try {
        const r = await api('GET', `/api/novel/${comicId}/${id}`);
        novelText = r.text || '';
        $('#pageInfo').textContent = r.title || ch?.title || '正文';
        draw();
      } catch (err) {
        $('#stage').innerHTML = `<div class="r-empty">${esc(err.message)}</div>`;
      }
      reportProgress(true);
      return;
    }
    $('#slider').max = Math.max(0, pages.length - 1);
    draw();
    reportProgress(true);
  }
  function pageSrc(p) { return asset(`/api/files/${comicId}/${chapterId}/${p.file}`); }

  /** 上一话 / 下一话：显式切换，不改变阅读模式 */
  function goChapter(delta) {
    const cs = comic?.chapters || [];
    const i = cs.findIndex((c) => c.id === chapterId);
    const next = i + delta;
    if (i < 0 || next < 0 || next >= cs.length) return;
    loadChapter(cs[next].id);
  }

  function draw() {
    const stage = $('#stage');
    if (isNovel) {
      stage.className = 'r-stage novel';
      const paras = String(novelText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const title = (comic.chapters || []).find((c) => c.id === chapterId)?.title || '正文';
      stage.innerHTML = `<article class="novel-article" style="font-size:${fontSize}px">
        <h1>${esc(title)}</h1>
        ${paras.map((p) => `<p>${esc(p)}</p>`).join('')}
        <div class="r-webtoon-edge done">— 本章完 · 用「下一话」继续 —</div>
      </article>`;
      $('#pageInfo').textContent = `${Math.round(novelRatio * 100)}%`;
      return;
    }
    if (!pages.length) {
      stage.className = 'r-stage';
      stage.innerHTML = '<div class="r-empty">这一话还没有页面</div>';
      $('#pageInfo').textContent = '— / —';
      return;
    }
    $('#btnWebtoon').textContent = webtoon ? '上下滑动 ✓' : '上下滑动';
    $('#btnSpread').textContent = spread ? '双页' : '单页';
    $('#zoomLabel').textContent = zoom + '%';

    if (webtoon) {
      const cs = comic.chapters || [];
      const i = cs.findIndex((c) => c.id === chapterId);
      stage.className = 'r-stage webtoon';
      stage.innerHTML =
        (i > 0 ? `<button class="r-webtoon-edge" data-ch="-1">↑ 上一话 · ${esc(cs[i - 1].title)}</button>` : '') +
        pages.map((p) => `<img src="${esc(pageSrc(p))}" alt="" loading="lazy" />`).join('') +
        (i < cs.length - 1
          ? `<button class="r-webtoon-edge" data-ch="1">↓ 下一话 · ${esc(cs[i + 1].title)}</button>`
          : '<div class="r-webtoon-edge done">— 已经是最后一话 —</div>');
      $('#pageInfo').textContent = `条漫 · ${pages.length} 张`;
      $('#slider').value = 0;
      return;
    }

    const n = spread ? 2 : 1;
    const shown = pages.slice(index, index + n);
    stage.className = 'r-stage' + (spread ? ' spread' : '');
    stage.innerHTML = shown.map((p) =>
      `<img src="${esc(pageSrc(p))}" style="${zoom === 100 ? '' : `height:${zoom}%`}" alt="" />`).join('');
    $('#pageInfo').textContent = `${index + 1}${shown.length > 1 ? `-${index + shown.length}` : ''} / ${pages.length}`;
    $('#slider').value = index;
  }

  function go(delta) {
    const stage = $('#stage');
    if (isNovel) { stage.scrollBy({ top: delta * stage.clientHeight * 0.85, behavior: 'smooth' }); return; }
    if (webtoon) {
      stage.scrollBy({ top: delta * stage.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    const step = spread ? 2 : 1;
    const next = Math.max(0, Math.min(pages.length - 1, index + delta * step));
    if (next === index && delta > 0 && comic?.chapters?.length) {
      // 读到本话最后一页时，继续前进自动进入下一话
      const cs = comic.chapters;
      const i = cs.findIndex((c) => c.id === chapterId);
      if (i >= 0 && i < cs.length - 1) { goChapter(1); return; }
    }
    index = next;
    draw();
    reportProgress();
  }

  /* 底部按键语义恒定：上一页 / 下一页按内容顺序；视觉位置与箭头由 CSS 的 row-reverse + syncDirUI 镜像 */
  $('#btnPrev').onclick = () => go(-1);
  $('#btnNext').onclick = () => go(1);
  $('#btnPrevChapter').onclick = () => goChapter(-1);
  $('#btnNextChapter').onclick = () => goChapter(1);
  $('#btnDir').onclick = () => {
    rtl = !rtl;
    syncDirUI();
    savePrefs();
    toastR(rtl ? '已切换：从右往左 RTL' : '已切换：从左往右 LTR');
  };
  $('#prefScope').onchange = (e) => changeScope(e.target.value);
  $('#btnWebtoon').onclick = () => { if (isNovel) return; webtoon = !webtoon; $('#stage').scrollTop = 0; savePrefs(); draw(); };
  $('#btnZoomIn').onclick = () => {
    if (isNovel) { fontSize = Math.min(30, fontSize + 1); try { localStorage.setItem('cv-novel-font', String(fontSize)); } catch {} draw(); return; }
    zoom = Math.min(200, zoom + 10); savePrefs(); draw();
  };
  $('#btnZoomOut').onclick = () => {
    if (isNovel) { fontSize = Math.max(14, fontSize - 1); try { localStorage.setItem('cv-novel-font', String(fontSize)); } catch {} draw(); return; }
    zoom = Math.max(50, zoom - 10); savePrefs(); draw();
  };
  $('#btnSpread').onclick = () => { if (webtoon) { webtoon = false; } spread = !spread; savePrefs(); draw(); };
  $('#chapterSel').onchange = (e) => loadChapter(e.target.value);
  $('#slider').oninput = (e) => {
    index = Number(e.target.value);
    if (isNovel) {
      const st = $('#stage');
      const r = index / 1000;
      st.scrollTop = r * Math.max(1, st.scrollHeight - st.clientHeight);
      novelRatio = r;
      $('#pageInfo').textContent = `${Math.round(r * 100)}%`;
      reportProgress(true);
      return;
    }
    draw();
  };
  $('#btnBack').onclick = () => {
    if (Host.closeReader) Host.closeReader();
    else if (history.length > 1) history.back();
    else location.href = 'index.html';
  };
  $('#btnFull').onclick = () => {
    if (Host.toggleFullscreen) Host.toggleFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  /* 阅读器内轻量提示：借用页码位置临时显示，2.8 秒后由 draw() 复原 */
  function toastR(msg) {
    const el = $('#pageInfo');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(toastR._t);
    toastR._t = setTimeout(() => { if (el.textContent === msg) draw(); }, 2800);
  }
  /* 保存当前这一页图片：宿主把图片读成 data URL，再落到本地磁盘 / 手机相册。
     WebView 与 Electron 里 <a download> 对图片 URL 无效，必须走宿主桥。 */
  $('#btnSave').onclick = async () => {
    if (isNovel) return toastR('小说没有图片可保存');
    const p = pages[index];
    if (!p) return toastR('这一话还没有页面');
    const ch = (comic.chapters || []).find((c) => c.id === chapterId);
    const name = `${comic.title}-${ch?.title || '漫画'}-第${index + 1}页`;
    let dataUrl = '';
    try {
      if (Host.imageToDataUrl) dataUrl = await Host.imageToDataUrl(pageSrc(p));
      if (!dataUrl) {
        const res = await fetch(pageSrc(p));
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      }
    } catch { /* 下面统一提示 */ }
    if (!dataUrl) return toastR('读取图片失败，请重试');
    if (Host.saveImage) {
      const r = await Host.saveImage(dataUrl, name);
      return toastR(r?.ok ? `已保存：${r.path || '图片'}` : (r?.error || '保存失败'));
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${name}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toastR('已触发下载');
  };
  $('#stage').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (b) goChapter(Number(b.dataset.ch));
  });
  $('#stage').addEventListener('scroll', () => {
    if (isNovel) {
      const st = $('#stage');
      novelRatio = Math.min(1, Math.max(0, st.scrollTop / Math.max(1, st.scrollHeight - st.clientHeight)));
      index = Math.round(novelRatio * 1000);
      $('#slider').value = index;
      $('#pageInfo').textContent = `${Math.round(novelRatio * 100)}%`;
      reportProgress();
      return;
    }
    if (!webtoon) return;
    const st = $('#stage');
    const ratio = st.scrollTop / Math.max(1, st.scrollHeight - st.clientHeight);
    $('#pageInfo').textContent = `条漫 · ${Math.round(ratio * 100)}%`;
    $('#slider').value = Math.round(ratio * Math.max(0, pages.length - 1));
    // 条漫模式下按滚动位置同步进度
    const approx = Math.round(ratio * Math.max(0, pages.length - 1));
    if (Math.abs(approx - index) >= 2) { index = approx; reportProgress(); }
  });
  document.addEventListener('keydown', (e) => {
    /* RTL：方向键与翻页语义镜像 */
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); go(rtl ? -1 : 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); go(rtl ? 1 : -1); }
    else if (e.key === '[') { goChapter(rtl ? 1 : -1); }
    else if (e.key === ']') { goChapter(rtl ? -1 : 1); }
    else if (e.key === 'Home') { index = 0; $('#stage').scrollTop = 0; draw(); }
    else if (e.key === 'End') { index = Math.max(0, pages.length - 1); draw(); }
    else if (e.key === '+' || e.key === '=') { zoom = Math.min(200, zoom + 10); savePrefs(); draw(); }
    else if (e.key === '-') { zoom = Math.max(50, zoom - 10); savePrefs(); draw(); }
    else if (e.key.toLowerCase() === 'd') { spread = !spread; savePrefs(); draw(); }
    else if (e.key.toLowerCase() === 'w') { webtoon = !webtoon; $('#stage').scrollTop = 0; savePrefs(); draw(); }
    else if (e.key.toLowerCase() === 'r') { rtl = !rtl; syncDirUI(); savePrefs(); }
    else if (e.key === 'Escape' && Host.closeReader && document.fullscreenElement) Host.toggleFullscreen?.();
  });

  /* ---------- 工具栏显隐：只由明确点击驱动，滑动 / 触碰 / 滚轮 / 翻页都不弹 ---------- */
  let idleT = null;
  let uiShown = false;
  function hideUi() {
    uiShown = false;
    document.body.classList.add('idle');
    clearTimeout(idleT);
  }
  function showUi() {
    uiShown = true;
    document.body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(hideUi, 4200);
  }
  function toggleUi() { uiShown ? hideUi() : showUi(); }

  /** 明确的一次轻点：画面正中间矩形才切换菜单，左右区域翻页但绝不弹按键 */
  function handleTap(clientX, clientY, el) {
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);
    if (x > 0.32 && x < 0.68 && y > 0.2 && y < 0.8) { toggleUi(); return; }
    if (webtoon || isNovel) return;
    const leftSide = x < 0.5;
    go(rtl ? (leftSide ? 1 : -1) : (leftSide ? -1 : 1));
  }

  let tapStart = null;
  let suppressUntil = 0;
  const stage = $('#stage');
  stage.addEventListener('click', (e) => {
    if (e.target.closest('[data-ch]')) return;       // webtoon 上下话按钮
    if (Date.now() < suppressUntil) return;           // 触摸合成 click 屏蔽
    handleTap(e.clientX, e.clientY, stage);
  });
  stage.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t) tapStart = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!tapStart) return;
    const t = e.touches[0];
    if (t && (Math.abs(t.clientX - tapStart.x) > 10 || Math.abs(t.clientY - tapStart.y) > 10)) tapStart.moved = true;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const s = tapStart; tapStart = null;
    if (!s) return;
    const t = e.changedTouches[0];
    if (!t) return;
    suppressUntil = Date.now() + 500;
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    const dist = Math.hypot(dx, dy), dur = Date.now() - s.t;
    const swipe = Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.3 && dur <= 900;
    if (s.moved || swipe) {
      if (swipe && !webtoon && !isNovel) go(rtl ? (dx < 0 ? -1 : 1) : (dx < 0 ? 1 : -1));
      return;   /* 滑动 / 滚动：绝不弹出按键 */
    }
    if (dist <= 14 && dur <= 500) handleTap(t.clientX, t.clientY, stage);
  }, { passive: true });
  stage.addEventListener('touchcancel', () => { tapStart = null; }, { passive: true });

  /* 角落菜单按钮：点它才显示按键 */
  $('#btnPeek').onclick = () => showUi();
  hideUi();   /* 默认沉浸：一进来就是纯画面 */

  init();
})();
