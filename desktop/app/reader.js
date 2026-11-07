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
  let index = 0, spread = false, webtoon = false, zoom = 100;
  let lastReport = 0;

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
    if (!chapterId) chapterId = chapters[0]?.id || '';
    $('#chapterSel').innerHTML = chapters.map((c) =>
      `<option value="${esc(c.id)}" ${c.id === chapterId ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
    $('#rTitle').textContent = comic.title || '阅读器';
    loadChapter(chapterId);
  }
  function loadChapter(id) {
    chapterId = id;
    const ch = (comic.chapters || []).find((c) => c.id === id);
    pages = ch?.pages || [];
    index = 0;
    $('#chapterSel').value = id;
    $('#slider').max = Math.max(0, pages.length - 1);
    $('#stage').scrollTop = 0;
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
    if (!pages.length) {
      stage.className = 'r-stage';
      stage.innerHTML = '<div class="r-empty">这一话还没有页面</div>';
      $('#pageInfo').textContent = '— / —';
      return;
    }
    $('#btnWebtoon').textContent = webtoon ? '条漫 ✓' : '条漫';
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

  $('#btnPrev').onclick = () => go(-1);
  $('#btnNext').onclick = () => go(1);
  $('#btnPrevChapter').onclick = () => goChapter(-1);
  $('#btnNextChapter').onclick = () => goChapter(1);
  $('#btnWebtoon').onclick = () => { webtoon = !webtoon; $('#stage').scrollTop = 0; draw(); };
  $('#btnZoomIn').onclick = () => { zoom = Math.min(200, zoom + 10); draw(); };
  $('#btnZoomOut').onclick = () => { zoom = Math.max(50, zoom - 10); draw(); };
  $('#btnSpread').onclick = () => { if (webtoon) { webtoon = false; } spread = !spread; draw(); };
  $('#chapterSel').onchange = (e) => loadChapter(e.target.value);
  $('#slider').oninput = (e) => { index = Number(e.target.value); draw(); };
  $('#btnBack').onclick = () => {
    if (Host.closeReader) Host.closeReader();
    else if (history.length > 1) history.back();
    else location.href = 'index.html';
  };
  $('#btnFull').onclick = () => {
    if (Host.toggleFullscreen) Host.toggleFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $('#stage').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (b) goChapter(Number(b.dataset.ch));
  });
  $('#stage').addEventListener('scroll', () => {
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
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (e.key === '[') { goChapter(-1); }
    else if (e.key === ']') { goChapter(1); }
    else if (e.key === 'Home') { index = 0; $('#stage').scrollTop = 0; draw(); }
    else if (e.key === 'End') { index = Math.max(0, pages.length - 1); draw(); }
    else if (e.key === '+' || e.key === '=') { zoom = Math.min(200, zoom + 10); draw(); }
    else if (e.key === '-') { zoom = Math.max(50, zoom - 10); draw(); }
    else if (e.key.toLowerCase() === 'd') { spread = !spread; draw(); }
    else if (e.key.toLowerCase() === 'w') { webtoon = !webtoon; $('#stage').scrollTop = 0; draw(); }
    else if (e.key === 'Escape' && Host.closeReader && document.fullscreenElement) Host.toggleFullscreen?.();
  });
  /* 触摸滑动（手机）：条漫模式交给系统上下滚动 */
  let sx = 0, sy = 0;
  $('#stage').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; });
  $('#stage').addEventListener('touchend', (e) => {
    if (webtoon) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
  });

  /* 沉浸模式：无操作 2.6 秒自动隐藏工具栏 */
  let idleT = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (pages.length) document.body.classList.add('idle'); }, 2600);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
    document.addEventListener(ev, wake, { passive: true }));
  wake();

  init();
})();
