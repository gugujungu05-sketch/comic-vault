/* 独立阅读窗口：键盘翻页、单/双页、条漫、上一话/下一话，不依赖网站页面 */
(() => {
  'use strict';
  const Host = window.cvApp || window.CVAndroid;
  const isMobile = !!window.CVAndroid;
  if (isMobile) document.body.classList.add('mobile');
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* 跨页大图判定：优先服务端标记，缺失时按真实宽高比兜底（合并后未刷新也能识别） */
  const isWide = (p) => !!(p && (p.wide || (p.width && p.height && p.width / p.height >= 1.15)));

  let comic = null, chapterId = '', comicId = '', pages = [];
  let index = 0, spread = false, webtoon = false, zoom = 100, rtl = false;
  let lastReport = 0;
  let isNovel = false, novelText = '', novelRatio = 0, fontSize = 19;
  /* 新增：滚动并排列数(1-4)、保持单页顺序、连续跨章、小说连续阅读 */
  let scrollCols = 1, keepOrder = true, linkChapters = true, novelContinuous = false;
  /* 观看时把合并跨页拆成左右两张单页（可逆，不改原图） */
  let splitWide = false;
  /* AI 翻译：origIdx(原页索引) → 译文图 URL；按原页缓存，切页可恢复；translateOn 控制是否显示译文 */
  const translated = new Map();
  let translateOn = false;
  let translating = false;
  let novelSegs = [];          // 小说连续阅读：已拼接的章节 [{ idx, text }]
  let novelLoadingMore = false;
  /* 漫画连续跨章：链式渲染的章节索引窗口 + 图片项 [{ p, ci, chapId }] */
  let chainStart = 0, chainEnd = 0;
  let chainImgs = [];
  let chainComp = null;        // 向前扩展后的滚动位置补偿 { heightBefore, topBefore }
  /* 视觉调节：滤镜 / 亮度 / 对比度（与网站 ReaderView 一致，存全局 cv-view-fx） */
  const FX_KEY = 'cv-view-fx';
  let filter = 'none', brightness = 100, contrast = 100;
  const THEMES = [
    { id: 'dark', name: '深空' }, { id: 'light', name: '浅色' }, { id: 'sea', name: '深海蓝' },
    { id: 'forest', name: '松林绿' }, { id: 'sunset', name: '暖橘' }, { id: 'sakura', name: '樱粉' },
  ];
  /* 阅读方式记忆：支持「全部 / 仅这本 / 仅本话」三种作用范围 */
  const PREFS_KEY = 'cv-reader-prefs';
  const SCOPE_KEY = 'cv-reader-scope';
  const DEF_PREFS = { spread: false, webtoon: false, zoom: 100 };
  let prefScope = 'all';
  function readPart(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } }
  function loadFx() {
    const f = readPart(FX_KEY);
    filter = ['none', 'warm', 'gray', 'invert'].includes(f.filter) ? f.filter : 'none';
    brightness = Math.min(150, Math.max(50, Number(f.brightness) || 100));
    contrast = Math.min(180, Math.max(50, Number(f.contrast) || 100));
  }
  function saveFx() {
    try { localStorage.setItem(FX_KEY, JSON.stringify({ filter, brightness, contrast })); } catch {}
    applyFx();
  }
  function applyFx() {
    const stage = $('#stage');
    if (!stage) return;
    const f = filter === 'warm' ? 'sepia(.28) saturate(1.12)'
      : filter === 'gray' ? 'grayscale(1)'
      : filter === 'invert' ? 'invert(1) hue-rotate(180deg)' : '';
    stage.style.filter = `${f} brightness(${brightness / 100}) contrast(${contrast / 100})`.trim();
  }
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
      const snapshot = {
        spread, webtoon, zoom, rtl, direction: rtl ? 'rtl' : 'ltr',
        scrollCols, keepOrder, linkChapters, novelContinuous, splitWide,
      };
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
    /* 兼容旧键 scrollDouble=2 */
    scrollCols = p.scrollCols ? Math.min(4, Math.max(1, Number(p.scrollCols) || 1)) : (p.scrollDouble ? 2 : 1);
    keepOrder = p.keepOrder !== false;
    linkChapters = p.linkChapters !== false;
    novelContinuous = !!p.novelContinuous;
    splitWide = !!p.splitWide;
    syncDirUI();
    syncNewModeUI();
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
  /** 同步新增设置面板控件的选中态 / 小说专属行显隐 */
  function syncNewModeUI() {
    const cw = $('#rsCols');
    if (cw) cw.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', Number(x.dataset.v) === scrollCols));
    const nw = $('#rsNovelCont');
    if (nw) nw.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', (x.dataset.v === '1') === novelContinuous));
    const nr = $('#rsNovelRow'); if (nr) nr.style.display = isNovel ? '' : 'none';
    const sc = $('#rsScrollRow'); if (sc) sc.style.display = isNovel ? 'none' : '';
    const mw = $('#rsModes');
    if (mw) {
      const ko = mw.querySelector('[data-v="keepOrder"]'); if (ko) ko.classList.toggle('active', keepOrder);
      const lc = mw.querySelector('[data-v="linkChapters"]'); if (lc) lc.classList.toggle('active', linkChapters);
      const sw = mw.querySelector('[data-v="splitWide"]'); if (sw) sw.classList.toggle('active', splitWide);
    }
  }

  /** 同步 AI 翻译按钮文案 / 状态 */
  function syncTranslateUI() {
    const b = $('#btnTranslate');
    if (b) {
      b.classList.toggle('active', translateOn);
      b.textContent = translating ? '翻译中…' : translateOn ? '还原译文' : 'AI 翻译';
      b.disabled = translating;
      b.title = translateOn ? '点此还原为原图' : 'AI 翻译当前话（生肉→中文，译文排回原位）';
    }
    const rb = $('#btnTransReset');
    if (rb) rb.style.display = translateOn ? '' : 'none';
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

  /** AI 翻译当前话：把每页图转成 data URL 传给服务端（本地书在远程站点也能翻译），
      译文图按页缓存到 translated；translateOn 开启后用译文图替换显示。 */
  async function translateCurrent() {
    if (isNovel) return toastR('小说是文字，无需翻译图片');
    if (!pages.length) return toastR('这一话还没有页面');
    if (translateOn) { translateOn = false; draw(); syncTranslateUI(); return; }
    const targets = pages.map((p, idx) => ({ p, idx, key: pageKey(p, chapterId) }))
      .filter((x) => x.p && x.p.file && !translated.has(x.key));
    if (!targets.length) { translateOn = true; draw(); syncTranslateUI(); toastR('已恢复上次译文'); return; }
    translating = true; syncTranslateUI(); toastR(`正在翻译 ${targets.length} 页，请稍候…`);
    let ok = 0;
    for (const { p, idx, key } of targets) {
      try {
        let dataUrl = '';
        try { if (Host.imageToDataUrl) dataUrl = await Host.imageToDataUrl(pageSrc(p)); } catch {}
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
        const r = await api('POST', '/api/translate/page', { body: { url: dataUrl } });
        const u = String(r.url || '');
        translated.set(key, u.startsWith('/') ? asset(u) : u);
        ok += 1;
      } catch (err) {
        toastR(`第 ${idx + 1} 页翻译失败：${(err && err.message) || '请检查翻译设置与网络'}`);
      }
    }
    translating = false;
    if (ok) { translateOn = true; draw(); toastR(`已翻译 ${ok} 页（译文在原位显示）`); }
    syncTranslateUI();
  }

  /** 阅读设置面板：主题 / 滤镜 / 亮度 / 对比度（纯增量，不影响原有按键） */
  function initSettingsPanel() {
    const panel = $('#settingsPanel');
    if (!panel) return;
    // 主题色块
    const curTheme = (() => { try { return localStorage.getItem('cv-theme') || 'dark'; } catch { return 'dark'; } })();
    const tw = $('#rsThemes');
    if (tw) {
      tw.innerHTML = THEMES.map((t) =>
        `<button data-v="${t.id}" class="rs-theme ${t.id === curTheme ? 'active' : ''}" title="${t.name}">${t.name}</button>`).join('');
      tw.onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        try { localStorage.setItem('cv-theme', b.dataset.v); } catch {}
        document.documentElement.dataset.theme = b.dataset.v;
        tw.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', x === b));
        // 通知主界面 / 网站其它页面同步主题（同源 storage 事件自动同步，这里额外触发一次当前窗口）
        try { window.dispatchEvent(new StorageEvent('storage', { key: 'cv-theme', newValue: b.dataset.v })); } catch {}
      };
    }
    // 滤镜
    const fw = $('#rsFilter');
    if (fw) {
      const syncF = () => fw.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', x.dataset.v === filter));
      syncF();
      fw.onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        filter = b.dataset.v; syncF(); saveFx();
      };
    }
    // 亮度 / 对比度
    const br = $('#rsBright'), ct = $('#rsContrast');
    if (br) { br.value = brightness; const v = $('#rsBrightVal'); if (v) v.textContent = brightness + '%'; }
    if (ct) { ct.value = contrast; const v = $('#rsContrastVal'); if (v) v.textContent = contrast + '%'; }
    if (br) br.oninput = () => { brightness = Number(br.value); const v = $('#rsBrightVal'); if (v) v.textContent = brightness + '%'; saveFx(); };
    if (ct) ct.oninput = () => { contrast = Number(ct.value); const v = $('#rsContrastVal'); if (v) v.textContent = contrast + '%'; saveFx(); };
    // 滚动并排页数
    const cw = $('#rsCols');
    if (cw) {
      cw.onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        scrollCols = Math.min(4, Math.max(1, Number(b.dataset.v) || 1));
        if (!webtoon && !isNovel) webtoon = true;   // 选并排即进入滚动模式
        syncNewModeUI(); savePrefs(); draw();
      };
    }
    // 小说连续阅读
    const nw = $('#rsNovelCont');
    if (nw) {
      nw.onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        novelContinuous = b.dataset.v === '1';
        novelSegs = novelContinuous && novelText
          ? [{ idx: (comic.chapters || []).findIndex((c) => c.id === chapterId), text: novelText }] : [];
        syncNewModeUI(); savePrefs(); draw();
      };
    }
    // 保持单页顺序 / 连续跨章（ toggles ）
    const mw = $('#rsModes');
    if (mw) {
      mw.onclick = (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        if (b.dataset.v === 'keepOrder') keepOrder = !keepOrder;
        else if (b.dataset.v === 'splitWide') splitWide = !splitWide;
        else if (b.dataset.v === 'linkChapters') {
          linkChapters = !linkChapters;
          if (linkChapters) {
            const ci = Math.max(0, (comic?.chapters || []).findIndex((c) => c.id === chapterId));
            chainStart = ci; chainEnd = ci; chainComp = null; buildChainImgs();
          }
        }
        syncNewModeUI(); savePrefs(); draw();
      };
    }
    syncNewModeUI();
    // 显隐
    const open = () => { panel.classList.add('open'); showUi(); };
    const close = () => panel.classList.remove('open');
    const bs = $('#btnSettings'); if (bs) bs.onclick = (e) => { e.stopPropagation(); panel.classList.contains('open') ? close() : open(); };
    const bc = $('#btnCloseSettings'); if (bc) bc.onclick = (e) => { e.stopPropagation(); close(); };
    panel.addEventListener('click', (e) => e.stopPropagation());
  }

  async function init() {
    /* 阅读器跟随主界面 / 网站所选主题（localStorage 同源共享） */
    try {
      const t = localStorage.getItem('cv-theme') || '';
      if (['dark', 'light', 'sea', 'forest', 'sunset', 'sakura'].includes(t)) {
        document.documentElement.dataset.theme = t;
      }
    } catch { /* 隐私模式下忽略 */ }
    loadFx();
    applyFx();
    initSettingsPanel();
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
      if ($('#btnTranslate')) $('#btnTranslate').style.display = 'none';
      if ($('#btnTransReset')) $('#btnTransReset').style.display = 'none';
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
    translateOn = false;   // 切话回到原图（译文缓存按章节 key 保留，再点翻译可即时恢复）
    syncTranslateUI();
    /* 仅本话范围：切到别的话时按那一话的记忆重新应用 */
    if (prefScope === 'chapter') applyPrefs(loadPrefs());
    const ch = (comic.chapters || []).find((c) => c.id === id);
    pages = ch?.pages || [];
    // 连续跨章：链式窗口重置到当前章
    const ci0 = Math.max(0, (comic.chapters || []).findIndex((c) => c.id === id));
    chainStart = ci0; chainEnd = ci0; chainComp = null; buildChainImgs();
    index = 0;
    $('#chapterSel').value = id;
    $('#stage').scrollTop = 0;
    if (isNovel) {
      // 小说：按需读取本章正文，进度用 0~1000 千分比定位
      novelRatio = 0;
      novelSegs = [];
      $('#slider').max = 1000; $('#slider').value = 0;
      $('#stage').className = 'r-stage novel';
      $('#stage').innerHTML = '<div class="r-empty">正在加载本章…</div>';
      try {
        const r = await api('GET', `/api/novel/${comicId}/${id}`);
        novelText = r.text || '';
        if (novelContinuous) novelSegs = [{ idx: (comic.chapters || []).findIndex((c) => c.id === id), text: novelText }];
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
  /** 小说连续阅读：滚动接近底部时按需加载下一章正文，拼接显示 */
  async function loadNovelMore() {
    if (!novelContinuous || novelLoadingMore || !novelSegs.length) return;
    const cs = comic.chapters || [];
    const last = novelSegs[novelSegs.length - 1].idx;
    if (last < 0 || last >= cs.length - 1) return;
    const nextIdx = last + 1;
    novelLoadingMore = true;
    draw();
    try {
      const r = await api('GET', `/api/novel/${comicId}/${cs[nextIdx].id}`);
      if (!novelSegs.some((s) => s.idx === nextIdx)) novelSegs.push({ idx: nextIdx, text: r.text || '' });
    } catch { /* 失败不中断 */ }
    novelLoadingMore = false;
    draw();
  }
  function pageSrc(p, chapId) { return asset(`/api/files/${comicId}/${chapId || chapterId}/${p.file}`); }
  /** 译文图地址：translateOn 且该原页已翻译时用译文图，否则用原图。key 用 comic/chapter/page 三元组，跨章不串。 */
  function pageKey(p, chapId) { return `${comicId}/${chapId || chapterId}/${p.file}`; }
  function srcFor(p, chapId) {
    if (translateOn) {
      const t = translated.get(pageKey(p, chapId));
      if (t) return t;
    }
    return pageSrc(p, chapId);
  }
  /** 半图宽高比：跨页约 2:1，拆出的单页约 1:1；缺尺寸时按 0.78 兜底 */
  function halfAspect(p) {
    return (p && p.width > 0 && p.height > 0) ? `${(p.width / 2).toFixed(2)} / ${p.height.toFixed(2)}` : '0.78';
  }
  /** 渲染一页媒体：完整页→img；拆出的左/右半→同一张图按 background-position 裁一半 */
  function mediaHtml(p, half, src, extraStyle, alt) {
    if (half === 'full') {
      return `<img src="${esc(src)}" style="${esc(extraStyle || '')}" alt="${esc(alt || '')}" loading="lazy" />`;
    }
    const style = `aspect-ratio:${halfAspect(p)};background-image:url("${esc(src)}");${extraStyle || ''}`;
    return `<div class="media-half media-half-${half}" role="img" style="${esc(style)}" aria-label="${esc(alt || '')}"></div>`;
  }
  /** 把页列表按 splitWide 展开成 [{ p, half }]：跨页→左右两半，其余不变 */
  function buildView(pagesIn) {
    const out = [];
    (pagesIn || []).forEach((p) => {
      if (splitWide && isWide(p)) {
        out.push({ p, half: 'l' });
        out.push({ p, half: 'r' });
      } else out.push({ p, half: 'full' });
    });
    return out;
  }

  /** 重建链式图片列表：把 [chainStart..chainEnd] 章的页面拼起来（跨页大图保留标记，排版时独占） */
  function buildChainImgs() {
    const cs = comic?.chapters || [];
    const out = [];
    for (let ci = chainStart; ci <= chainEnd && ci < cs.length; ci++) {
      const ch = cs[ci];
      if (!ch) continue;
      (ch.pages || []).forEach((p) => out.push({ p, ci, chapId: ch.id }));
    }
    chainImgs = out;
  }

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
      const cs = comic.chapters || [];
      if (novelContinuous && novelSegs.length) {
        // 连续阅读：章节正文拼接，仅首章一个大标题，后续用小标题分隔（去掉每话封面感）
        stage.innerHTML = `<article class="novel-article" style="font-size:${fontSize}px">` +
          novelSegs.map((seg, si) => {
            const t = cs[seg.idx]?.title || '正文';
            const ps = String(seg.text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
            return `<section class="novel-seg">${si === 0 ? `<h1>${esc(t)}</h1>` : `<h2 class="novel-seg-title">${esc(t)}</h2>`}` +
              ps.map((p) => `<p>${esc(p)}</p>`).join('') + `</section>`;
          }).join('') +
          (novelLoadingMore ? '<div class="r-webtoon-edge done">正在加载下一章…</div>' : '') +
          (novelSegs[novelSegs.length - 1]?.idx >= cs.length - 1 ? '<div class="r-webtoon-edge done">— 全文完 —</div>' : '') +
          `</article>`;
      } else {
        const paras = String(novelText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
        const title = cs.find((c) => c.id === chapterId)?.title || '正文';
        stage.innerHTML = `<article class="novel-article" style="font-size:${fontSize}px">
          <h1>${esc(title)}</h1>
          ${paras.map((p) => `<p>${esc(p)}</p>`).join('')}
          <div class="r-webtoon-edge done">— 本章完 · 用「下一话」继续 —</div>
        </article>`;
      }
      $('#pageInfo').textContent = novelContinuous
        ? `连续 · ${novelSegs.length} 章`
        : `${Math.round(novelRatio * 100)}%`;
      return;
    }
    const chained = webtoon && linkChapters && !isNovel && (comic?.chapters || []).length > 1;
    if (!pages.length && !chained) {
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
      // 先按 splitWide 把跨页拆成左右逻辑页；再按 scrollCols 分组并排。
      // 页序始终自然顺序，不被方向镜像；未拆分的跨页大图仍独占一行。
      const raw = chained ? chainImgs : pages.map((p) => ({ p, ci: i, chapId: chapterId }));
      const imgs = [];
      raw.forEach((it) => {
        if (splitWide && isWide(it.p)) {
          imgs.push({ ...it, half: 'l' });
          imgs.push({ ...it, half: 'r' });
        } else imgs.push({ ...it, half: 'full' });
      });
      const itemWide = (it) => it.half === 'full' && isWide(it.p);
      let rowsHtml = '';
      let lastCi = -1;
      for (let k = 0; k < imgs.length;) {
        const item = imgs[k];
        if (chained && item.ci !== lastCi) {
          rowsHtml += `<div class="r-chain-title">${esc(cs[item.ci]?.title || `第 ${item.ci + 1} 话`)}</div>`;
          lastCi = item.ci;
        }
        if (itemWide(item)) {
          rowsHtml += `<div class="r-wt-row" data-cols="1">` +
            mediaHtml(item.p, 'full', srcFor(item.p, item.chapId), '', '跨页大图') + `</div>`;
          k += 1;
          continue;
        }
        const row = [];
        while (k < imgs.length && row.length < scrollCols && !itemWide(imgs[k])) row.push(imgs[k++]);
        if (!row.length) row.push(imgs[k++]);
        rowsHtml += `<div class="r-wt-row" data-cols="${row.length}">` +
          row.map((it) => mediaHtml(it.p, it.half, srcFor(it.p, it.chapId), '', '')).join('') + `</div>`;
      }
      stage.innerHTML =
        (!chained && i > 0 ? `<button class="r-webtoon-edge" data-ch="-1">↑ 上一话 · ${esc(cs[i - 1].title)}</button>` : '') +
        rowsHtml +
        (chained
          ? (chainEnd >= cs.length - 1
            ? '<div class="r-webtoon-edge done">— 已经是最后一话 —</div>'
            : '<div class="r-webtoon-edge done">继续向下滑动，自动接下一话 ↓</div>')
          : (i < cs.length - 1
            ? `<button class="r-webtoon-edge" data-ch="1">↓ 下一话 · ${esc(cs[i + 1].title)}</button>`
            : '<div class="r-webtoon-edge done">— 已经是最后一话 —</div>'));
      $('#pageInfo').textContent = `条漫 · ${scrollCols > 1 ? scrollCols + '页并排 · ' : ''}${imgs.length} 张`;
      $('#slider').value = 0;
      syncNewModeUI();
      return;
    }

    // 跨页大图（含合并生成的）在双页模式下独占一屏，不与相邻页并排。
    // splitWide 开启时：跨页那一屏渲染成左右两张单页（同一张图裁半），index/进度仍按原页计。
    const curWide = isWide(pages[index]);
    const n = spread && !curWide && !splitWide ? 2 : 1;
    const shown = buildView(pages.slice(index, index + n));
    const soloWide = shown.length === 1 && shown[0].half === 'full' && curWide;
    stage.className = 'r-stage' + (spread ? ' spread' : '') + (soloWide ? ' wide-solo' : '');
    const zoomStyle = zoom === 100 ? '' : `height:${zoom}%`;
    stage.innerHTML = shown.map((m) =>
      mediaHtml(m.p, m.half, srcFor(m.p), zoomStyle, m.half === 'l' ? '左页' : m.half === 'r' ? '右页' : '')).join('');
    $('#pageInfo').textContent = `${index + 1}${n > 1 ? `-${index + n}` : ''} / ${pages.length}`;
    $('#slider').value = index;
  }

  function go(delta) {
    const stage = $('#stage');
    if (isNovel) { stage.scrollBy({ top: delta * stage.clientHeight * 0.85, behavior: 'smooth' }); return; }
    if (webtoon) {
      stage.scrollBy({ top: delta * stage.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    const step = spread && !isWide(pages[index]) && !splitWide ? 2 : 1;
    const next = Math.max(0, Math.min(pages.length - 1, index + delta * step));
    if (next === index && delta > 0 && linkChapters && comic?.chapters?.length) {
      // 连续跨章开启时：读到本话最后一页，继续前进自动进入下一话
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
  /* AI 翻译：按钮 + 还原；小说无图时禁用 */
  const btnTrans = $('#btnTranslate');
  if (btnTrans) btnTrans.onclick = () => translateCurrent();
  const btnTransReset = $('#btnTransReset');
  if (btnTransReset) btnTransReset.onclick = () => { translateOn = false; draw(); syncTranslateUI(); };
  syncTranslateUI();
  $('#stage').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (b) goChapter(Number(b.dataset.ch));
  });
  $('#stage').addEventListener('scroll', () => {
    const st = $('#stage');
    if (isNovel) {
      novelRatio = Math.min(1, Math.max(0, st.scrollTop / Math.max(1, st.scrollHeight - st.clientHeight)));
      index = Math.round(novelRatio * 1000);
      $('#slider').value = index;
      if (!novelContinuous) $('#pageInfo').textContent = `${Math.round(novelRatio * 100)}%`;
      // 小说连续阅读：滚到底部自动续下一章
      if (novelContinuous && novelRatio > 0.985) loadNovelMore();
      reportProgress();
      return;
    }
    if (!webtoon) return;
    const cs = comic?.chapters || [];
    const chained = linkChapters && cs.length > 1;
    const ratio = st.scrollTop / Math.max(1, st.scrollHeight - st.clientHeight);
    if (chained) {
      // 链式连续：滚到底追加下一话、滚到顶追加上一话，全程不跳变
      if (ratio >= 0.985 && chainEnd < cs.length - 1) {
        chainEnd += 1; buildChainImgs(); draw();
        $('#pageInfo').textContent = `连续 · ${chainStart + 1}-${chainEnd + 1} 话`;
        return;
      }
      if (ratio <= 0.015 && chainStart > 0) {
        const heightBefore = st.scrollHeight, topBefore = st.scrollTop;
        chainStart -= 1; buildChainImgs(); draw();
        st.scrollTop = topBefore + Math.max(0, st.scrollHeight - heightBefore);
        $('#pageInfo').textContent = `连续 · ${chainStart + 1}-${chainEnd + 1} 话`;
        return;
      }
      $('#pageInfo').textContent = `连续 · ${chainStart + 1}-${chainEnd + 1} 话 · ${Math.round(ratio * 100)}%`;
      return;
    }
    $('#pageInfo').textContent = `条漫 · ${scrollCols > 1 ? scrollCols + '页并排 · ' : ''}${Math.round(ratio * 100)}%`;
    $('#slider').value = Math.round(ratio * Math.max(0, pages.length - 1));
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
