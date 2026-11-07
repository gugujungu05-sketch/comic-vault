/* 漫画库 · 独立桌面/手机客户端
   不加载网站页面，所有数据通过宿主进程直连同一服务器的 /api 接口。 */
(() => {
  'use strict';

  const Host = window.cvApp || window.CVAndroid;
  const isMobile = !!window.CVAndroid;
  if (isMobile) document.body.classList.add('mobile');

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const fmt = (t) => t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  /* 导入项可能是桌面端的绝对文件路径，也可能是 Android 系统选择器返回的 {id,name} */
  const nameOf = (p) => typeof p === 'string' ? base(p) : (p && p.name) || 'page';
  const keyOf = (p) => typeof p === 'string' ? p : (p && p.id) || nameOf(p);
  const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i)?.[1] || 'IMG').toUpperCase();

  const state = {
    view: 'library', user: null, server: '', theme: 'dark',
    comics: [], community: [], categories: [], boards: [], posts: [],
    comic: null, q: '', board: 'all', category: 'all', update: null, busy: false,
    importPaths: null, importSel: new Set(),
    sourcesList: [], sourceId: '', srcResults: [], srcComic: null, srcChecked: new Set(),
    subs: [],
    selecting: false, selComics: new Set(),
  };

  /* ------------------------------ 基础 ------------------------------ */
  function toast(msg, err = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
  }
  function openModal(html, wide = false) {
    $('#modal').innerHTML = html;
    $('#modal').classList.toggle('wide', wide);
    $('#modalMask').classList.add('show');
  }
  function closeModal() { $('#modalMask').classList.remove('show'); }
  function busy(on, text) {
    state.busy = on;
    const el = $('#busyLabel');
    if (el) el.textContent = text || '';
    $$('[data-action]').forEach((b) => { if (b.dataset.busy !== '0') b.disabled = on; });
  }
  async function api(method, path, opts = {}) {
    const r = await Host.api({ method, path, query: opts.query || {}, body: opts.body, files: opts.files });
    if (r.status >= 400) throw new Error((r.data && r.data.error) || `请求失败 (${r.status})`);
    return r.data;
  }
  const asset = (p) => { try { return Host.asset(p); } catch { return p; } };
  const coverUrl = (c) => c && c.coverUrl ? asset(c.coverUrl) : (c && c.cover ? asset(c.cover) : '');

  /* ------------------------------ 启动 ------------------------------ */
  async function boot() {
    $('#buildInfo').textContent = `v${Host.version} · 独立客户端`;
    try {
      const cfg = await Host.getConfig();
      state.server = cfg.server || '';
      state.mode = cfg.mode || 'local';
      state.theme = cfg.theme || 'dark';
      document.documentElement.dataset.theme = state.theme;
    } catch { /* 忽略 */ }
    await refreshStatus();
    render();
  }
  async function refreshStatus() {
    try {
      const s = await api('GET', '/api/auth/status');
      state.user = s.user;
      $('#serverLine').className = 'server-line ok';
      $('#serverLine span').textContent = state.mode === 'remote'
        ? '已连接 · ' + (state.server || '').replace(/^https?:\/\//, '').split('/')[0]
        : '本机模式 · 数据保存在这台设备';
    } catch (err) {
      state.user = null;
      $('#serverLine').className = 'server-line bad';
      $('#serverLine span').textContent = '服务器未连接';
    }
    $('#userBox').innerHTML = state.user
      ? `<div class="user-line">${state.user.avatar ? `<img class="avatar-mini" src="${esc(asset(state.user.avatar))}" />` : '<span class="avatar-mini letter">' + esc(state.user.name.slice(0, 1).toUpperCase()) + '</span>'}
         <div><b>${esc(state.user.name)}</b><br><span>${esc(state.user.email)}</span></div></div>
         <button class="btn sm ghost" data-action="upload-avatar">修改头像</button>
         <button class="btn sm ghost" data-action="logout">退出登录</button>`
      : '<span>未登录 · 公共内容可浏览</span>';
  }
  async function uploadAvatar() {
    let pick = [];
    try { pick = await Host.pickFiles(); } catch { /* Android 走系统选择器 */ }
    if (!pick || !pick.length) return;
    const f = pick[0];
    // 桌面端：先读进内存裁剪；Android / 旧宿主没有读图能力时直接原样上传
    if (typeof f === 'string' && Host.readImageData) {
      const dataUrl = await Host.readImageData(f);
      if (dataUrl) return openAvatarCropper(dataUrl);
    }
    busy(true, '上传头像…');
    try {
      await api('POST', '/api/me/avatar', {
        files: [typeof f === 'string' ? { path: f, name: base(f), field: 'file' } : { id: f.id, name: nameOf(f), field: 'file' }],
      });
      await refreshStatus();
      toast('头像已更新');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 圆形头像裁剪：拖动取景 + 缩放，输出 320×320 PNG */
  function openAvatarCropper(dataUrl) {
    openModal(`<h3>裁剪头像</h3>
      <div class="crop-wrap"><canvas id="cropCanvas" width="320" height="320"></canvas>
        <p class="muted" style="font-size:11px;margin:8px 0 0">在图上拖动调整位置，滑杆缩放</p></div>
      <label class="field" style="margin-top:8px"><input type="range" id="cropZoom" min="30" max="300" value="100" style="width:100%" /></label>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="crop-done">使用这张</button>
      </div>`);
    const cv = $('#cropCanvas'), ctx = cv.getContext('2d');
    const img = new Image();
    img.onload = () => draw();
    img.src = dataUrl;
    let scale = 1, ox = 0, oy = 0, dragging = false, lx = 0, ly = 0;
    function draw() {
      if (!img.width) return;
      scale = Number($('#cropZoom').value) / 100;
      const baseFit = Math.max(320 / img.width, 320 / img.height);
      const w = img.width * baseFit * scale, h = img.height * baseFit * scale;
      const cx = 160 + ox, cy = 160 + oy;
      ctx.clearRect(0, 0, 320, 320);
      ctx.save();
      ctx.beginPath(); ctx.arc(160, 160, 160, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, 320, 320);
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
    }
    cv.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      ox += e.clientX - lx; oy += e.clientY - ly;
      ox = Math.max(-320, Math.min(320, ox)); oy = Math.max(-320, Math.min(320, oy));
      lx = e.clientX; ly = e.clientY; draw();
    });
    cv.addEventListener('pointerup', () => { dragging = false; });
    $('#cropZoom').addEventListener('input', draw);
    $('#modal').querySelector('[data-action="crop-done"]').onclick = async () => {
      const out = cv.toDataURL('image/png');
      closeModal();
      const tmp = await Host.saveTempImage(out);
      if (!tmp) return toast('裁剪保存失败', true);
      busy(true, '上传头像…');
      try {
        await api('POST', '/api/me/avatar', { files: [{ path: tmp, name: 'avatar.png', field: 'file' }] });
        await refreshStatus();
        toast('头像已更新');
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    };
  }

  /* ------------------------------ 视图框架 ------------------------------ */
  const VIEW_META = {
    library: ['我的书架', '本地客户端 · 与网站共用同一份数据'],
    sources: ['在线来源', '配置书源，从漫画站把漫画搬进书库'],
    updates: ['追更', '订阅在更新的漫画，自动检查并下载新章节'],
    community: ['公共书库', '所有人共享的漫画，服务端实时同步'],
    plaza: ['广场', '讨论与分享'],
    settings: ['设置', '服务器、外观与更新'],
  };
  function render() {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    const meta = state.view === 'comic' ? ['漫画详情', '章节与页面'] : VIEW_META[state.view];
    $('#viewTitle').textContent = meta[0];
    $('#viewSub').textContent = meta[1];
    const acts = $('#topActions');
    acts.innerHTML = '';
    if (state.view === 'library') {
      acts.innerHTML = isMobile
        ? `<button class="btn" data-action="toggle-select">${state.selecting ? '取消多选' : '多选'}</button>
        <button class="btn" data-action="refresh-view">刷新</button>
        <button class="btn" data-action="new-comic">新建</button>
        <button class="btn" data-action="pick-import">＋ 导入</button>`
        : `${state.selecting ? '<button class="btn" data-action="toggle-select">取消多选</button>' : '<button class="btn" data-action="toggle-select">多选管理</button>'}
        <button class="btn" data-action="pick-import">＋ 导入漫画</button>
        <button class="btn" data-action="pick-folder">＋ 导入文件夹</button>
        <button class="btn primary" data-action="new-comic">新建漫画</button>`;
    } else if (state.view === 'sources') {
      acts.innerHTML = `<button class="btn" data-action="src-manage">书源管理</button>`;
    } else if (state.view === 'updates') {
      acts.innerHTML = `<button class="btn" data-action="sub-check-all">全部检查</button>`;
    } else if (state.view === 'community' || state.view === 'plaza') {
      acts.innerHTML = `<input class="input search" id="searchInput" placeholder="搜索…" value="${esc(state.q)}" />
        <button class="btn" data-action="search">搜索</button>`;
    } else if (state.view === 'comic') {
      const cont = state.comicData?.progress?.chapterId && (state.comicData?.chapters || []).some((x) => x.id === state.comicData.progress.chapterId);
      acts.innerHTML = `<button class="btn" data-action="back-library">← 返回</button>
        <button class="btn primary" data-action="read-first">${cont ? '▶ 继续阅读' : '▶ 开始阅读'}</button>`;
    }
    const fn = {
      library: renderLibrary, community: renderCommunity, plaza: renderPlaza,
      settings: renderSettings, comic: renderComic, sources: renderSources, updates: renderUpdates,
    }[state.view];
    fn();
  }

  /* ------------------------------ 登录 ------------------------------ */
  function renderAuth() {
    $('#content').innerHTML = `<div class="auth-wrap"><div class="auth-card">
      <h2>登录漫画库</h2><p>与网站、手机端使用同一个账号</p>
      <div class="tabs">
        <button class="active" data-action="auth-tab" data-mode="password">密码登录</button>
        <button data-action="auth-tab" data-mode="code">验证码登录</button>
        <button data-action="auth-tab" data-mode="register">注册账号</button>
      </div>
      <div id="authForm"></div>
    </div></div>`;
    renderAuthForm('password');
  }
  function renderAuthForm(mode) {
    $$('[data-action="auth-tab"]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'code') {
      $('#authForm').innerHTML = `<label class="field"><span>邮箱</span><input class="input" id="authEmail" type="email" placeholder="you@example.com" /></label>
        <div class="row" style="gap:8px;margin-top:2px">
          <button class="btn" id="codeBtn" data-action="auth-send-code">获取验证码</button>
          <input class="input" id="authCode" style="flex:1;min-width:0" inputmode="numeric" maxlength="6" placeholder="6 位验证码" />
        </div>
        <p class="muted" style="font-size:11px;margin:10px 0 0">新邮箱将自动注册，无需密码；密码之后可在设置里补设。</p>
        <button class="btn primary block" data-action="auth-code-login">登录 / 注册</button>`;
      return;
    }
    $('#authForm').innerHTML = `<label class="field"><span>邮箱</span><input class="input" id="authEmail" type="email" placeholder="you@example.com" /></label>
      <label class="field"><span>密码（至少 6 位）</span><span class="pwd-wrap"><input class="input" id="authPwd" type="password" placeholder="••••••" /><button type="button" class="pwd-toggle" data-action="auth-toggle-pwd">显示</button></span></label>
      ${mode === 'register' ? '<label class="field"><span>昵称（可选）</span><input class="input" id="authName" /></label>' : ''}
      <button class="btn primary block" data-action="auth-submit" data-mode="${mode}">${mode === 'register' ? '注册并登录' : '登录'}</button>`;
  }
  let codeTimer = null;
  function startCodeCountdown() {
    const btn = $('#codeBtn');
    if (!btn) return;
    let left = 60;
    btn.disabled = true;
    btn.textContent = `${left} 秒后再发`;
    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(codeTimer); btn.disabled = false; btn.textContent = '重新获取'; }
      else btn.textContent = `${left} 秒后再发`;
    }, 1000);
  }
  async function sendCode() {
    const email = $('#authEmail')?.value.trim();
    if (!email) return toast('请先填写邮箱', true);
    busy(true, '发送中…');
    try {
      const r = await api('POST', '/api/auth/send-code', { body: { email } });
      startCodeCountdown();
      if (r.devCode) {
        showCodePanel(r.devCode, email);
      } else {
        toast('验证码已发送，请查收邮箱');
      }
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 验证码单独放大展示，一键复制，自动填入输入框 */
  function showCodePanel(code, email) {
    openModal(`<h3>邮箱验证码</h3>
      <p class="muted" style="margin:4px 0 10px">已发送到 <b>${esc(email)}</b>，10 分钟内有效</p>
      <div class="code-big" id="codeBig">${esc(code)}</div>
      <div class="modal-actions">
        <button class="btn" data-action="copy-code">📋 复制验证码</button>
        <button class="btn primary" data-action="use-code">填入并关闭</button>
      </div>`);
    const c = $('#authCode'); if (c) c.value = code;
  }
  async function authCodeLogin() {    const email = $('#authEmail')?.value.trim(), code = $('#authCode')?.value.trim();
    if (!email || !code) return toast('请填写邮箱和验证码', true);
    busy(true, '登录中…');
    try {
      await api('POST', '/api/auth/login-code', { body: { email, code } });
      await refreshStatus(); render(); toast('登录成功');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  async function authSubmit(mode) {
    const email = $('#authEmail').value.trim(), password = $('#authPwd').value;
    if (!email || !password) return toast('请填写邮箱和密码', true);
    busy(true, '登录中…');
    try {
      const body = { email, password };
      if (mode === 'register') body.name = $('#authName')?.value.trim() || '';
      await api('POST', mode === 'register' ? '/api/auth/register' : '/api/auth/login', { body });
      await refreshStatus();
      toast(mode === 'register' ? '注册成功' : '登录成功');
      render();
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }

  /* ------------------------------ 书架 ------------------------------ */
  async function renderLibrary() {
    if (!state.user) { renderAuth(); return; }
    $('#content').innerHTML = '<div class="empty">正在读取书架…</div>';
    try {
      const r = await api('GET', '/api/comics');
      state.comics = r.comics || [];
    } catch (err) { $('#content').innerHTML = `<div class="empty"><h3>读取失败</h3>${esc(err.message)}</div>`; return; }
    if (!state.comics.length) {
      $('#content').innerHTML = `<div class="empty"><h3>书架还是空的</h3>
        <p>点「＋ 导入」选择图片、文件夹或 ZIP / CBZ / RAR / 7Z 压缩包；也可以去「在线来源」从漫画站搬。</p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-action="pick-import">导入漫画</button>
        <button class="btn" data-action="goto-sources">在线来源</button></div></div>`;
      return;
    }
    const sel = state.selecting;
    $('#content').innerHTML = `${sel ? `<div class="panel row" style="gap:8px">
      <span class="muted">已选 ${state.selComics.size} 本</span>
      <button class="btn sm" data-action="sel-all">全选</button>
      <button class="btn sm" data-action="sel-none">清空</button>
      <span class="spacer"></span>
      <button class="btn sm danger" data-action="sel-delete" ${state.selComics.size ? '' : 'disabled'}>删除选中</button></div>` : ''}
      <div class="grid">${state.comics.map((c) => `
      <div class="card ${sel && state.selComics.has(c.id) ? 'sel' : ''}" data-action="${sel ? 'sel-comic' : 'open-comic'}" data-id="${esc(c.id)}">
        <div class="cover">${coverUrl(c) ? `<img src="${esc(coverUrl(c))}" loading="lazy" />` : '📖'}
          ${sel ? `<span class="pick ${state.selComics.has(c.id) ? 'on' : ''}">${state.selComics.has(c.id) ? '✓' : ''}</span>` : ''}
          ${!sel && c.progress?.chapterId ? '<span class="cover-progress"></span><span class="cover-reading">在读</span>' : ''}</div>
        <div class="card-body"><div class="card-title">${esc(c.title)}</div>
          <div class="card-meta">${c.chapterCount || 0} 话 · ${c.pageCount || 0} 页${c.scope === 'community' ? ' · <span class="badge">公共</span>' : ''}</div></div>
      </div>`).join('')}</div>`;
  }

  /* ------------------------------ 在线来源 ------------------------------ */
  async function renderSources() {
    if (!state.user) { renderAuth(); return; }
    $('#content').innerHTML = '<div class="empty">正在读取书源…</div>';
    try {
      const r = await api('GET', '/api/sources');
      state.sourcesList = r.sources || [];
    } catch (err) { $('#content').innerHTML = `<div class="empty"><h3>读取失败</h3>${esc(err.message)}</div>`; return; }
    if (!state.sourcesList.length) {
      $('#content').innerHTML = `<div class="empty"><h3>还没有书源</h3>
        <p>添加一个书源（站点地址 + 解析规则），就能搜索并导入漫画。</p>
        <button class="btn primary" data-action="src-manage">添加书源</button></div>`;
      return;
    }
    if (!state.sourcesList.find((s) => s.id === state.sourceId)) state.sourceId = state.sourcesList[0].id;
    const opts = state.sourcesList.map((s) => `<option value="${esc(s.id)}" ${s.id === state.sourceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    $('#content').innerHTML = `<div class="panel row" style="gap:8px;flex-wrap:wrap">
        <select class="select" id="srcSel" style="max-width:220px">${opts}</select>
        <input class="input" id="srcKw" placeholder="输入漫画名搜索…" style="flex:1;min-width:140px" />
        <button class="btn primary" data-action="src-search">搜索</button></div>
      <div id="srcOut"></div>`;
    $('#srcSel').addEventListener('change', (e) => { state.sourceId = e.target.value; });
    renderSrcResults();
    $('#srcKw').addEventListener('keydown', (e) => { if (e.key === 'Enter') srcSearch(); });
  }
  function renderSrcResults() {
    const out = $('#srcOut');
    if (!out) return;
    out.innerHTML = state.srcResults.length
      ? `<div class="grid">${state.srcResults.map((r, i) => `
        <div class="card" data-action="src-open" data-i="${i}">
          <div class="cover">${r.cover ? `<img src="${esc(r.cover)}" />` : '🌐'}</div>
          <div class="card-body"><div class="card-title">${esc(r.title)}</div></div></div>`).join('')}</div>`
      : '<div class="empty">输入关键词搜索，结果会显示在这里</div>';
  }
  async function srcSearch() {
    const kw = $('#srcKw')?.value.trim();
    if (!kw) return toast('请输入搜索关键词', true);
    busy(true, '搜索中…');
    try {
      const r = await api('GET', `/api/sources/${state.sourceId}/search`, { query: { kw } });
      state.srcResults = r.items || [];
      renderSrcResults();
      if (!state.srcResults.length) toast('没有搜到结果，试试别的关键词或检查书源规则');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  async function srcOpen(i) {
    const item = state.srcResults[i];
    if (!item) return;
    busy(true, '读取章节…');
    try {
      const r = await api('POST', `/api/sources/${state.sourceId}/comic`, { body: { url: item.link } });
      state.srcComic = { ...r, url: item.link };
      state.srcChecked = new Set((r.chapters || []).map((_, j) => j));
      openModal(`<h3>${esc(r.title)}</h3>
        ${r.cover ? `<div class="row"><img src="${esc(r.cover)}" style="width:96px;border-radius:8px" /></div>` : ''}
        <div class="row" style="gap:8px;margin:10px 0"><span class="muted">共 ${(r.chapters || []).length} 话，已选 ${state.srcChecked.size} 话</span>
          <button class="btn sm" id="srcAll" type="button">全选</button>
          <button class="btn sm" id="srcNone" type="button">清空</button></div>
        <div class="src-chapters">${(r.chapters || []).map((ch, j) => `
          <label class="src-ch"><input type="checkbox" data-j="${j}" ${state.srcChecked.has(j) ? 'checked' : ''} />
            <span>${esc(ch.title)}</span></label>`).join('')}</div>
        <div class="modal-actions"><button class="btn" data-action="close-modal">取消</button>
        <button class="btn" data-action="src-subscribe" data-url="${esc(item.link)}" data-title="${esc(r.title)}" data-cover="${esc(r.cover || '')}">🔔 加入追更</button>
        <button class="btn primary" data-action="src-import">导入选中章节</button></div>
      <span id="busyLabel" class="muted" style="font-size:11px"></span>`, true);
      $('#modal').onchange = (e) => {
        const cb = e.target.closest('input[type=checkbox][data-j]');
        if (!cb) return;
        const j = Number(cb.dataset.j);
        if (cb.checked) state.srcChecked.add(j); else state.srcChecked.delete(j);
      };
      $('#srcAll').onclick = () => { state.srcChecked = new Set((state.srcComic?.chapters || []).map((_, j) => j)); syncSrcChecks(); };
      $('#srcNone').onclick = () => { state.srcChecked = new Set(); syncSrcChecks(); };
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  function syncSrcChecks() {
    $$('#modal input[type=checkbox][data-j]').forEach((cb) => { cb.checked = state.srcChecked.has(Number(cb.dataset.j)); });
    const label = $('#modal .muted');
    if (label) label.textContent = `共 ${(state.srcComic?.chapters || []).length} 话，已选 ${state.srcChecked.size} 话`;
  }
  async function srcImport() {
    const sc = state.srcComic;
    if (!sc) return;
    const picked = (sc.chapters || []).filter((_, j) => state.srcChecked.has(j));
    if (!picked.length) return toast('请先勾选章节', true);
    const btn = $('#modal [data-action="src-import"]');
    if (btn) btn.disabled = true;
    let comicId = '', failed = 0;
    for (let k = 0; k < picked.length; k++) {
      const el = $('#busyLabel');
      if (el) el.textContent = `导入中 ${k + 1}/${picked.length}…`;
      try {
        const r = await api('POST', '/api/sources/import', {
          body: {
            comicId: comicId || undefined, sourceId: state.sourceId, sourceName: '',
            title: sc.title, cover: sc.cover, comicUrl: sc.url,
            chapterTitle: picked[k].title, chapterUrl: picked[k].url,
          },
        });
        if (!comicId) comicId = r.comicId;
      } catch { failed++; }
    }
    closeModal();
    if (comicId) { state.comic = comicId; state.view = 'comic'; render(); }
    toast(`导入完成：成功 ${picked.length - failed} 话${failed ? `，失败 ${failed} 话` : ''}`);
  }
  function srcManage() {
    openModal(`<h3>书源管理</h3>
      <p class="muted" style="font-size:12px;margin:6px 0 10px">每个书源 = 站点地址 + 解析规则。选择器写法：<code>.thumb img@data-src</code> 取属性、<code>@text</code> 取文本、<code>|</code> 列多个兜底。</p>
      <div class="row" style="gap:8px">
        <label class="field" style="flex:1"><span>书源名称</span><input class="input" id="srcName" placeholder="如：某漫画站" /></label>
        <label class="field" style="flex:1"><span>站点地址</span><input class="input" id="srcBase" placeholder="https://example.com" /></label></div>
      <label class="field"><span>解析规则（JSON）</span><textarea class="textarea" id="srcRules" style="font-family:monospace;font-size:12px" rows="12">${esc(JSON.stringify({
      search: { url: '/search?q={kw}', item: '.item', title: '.title@text', link: 'a@href', cover: 'img@src|data-src' },
      comic: { title: 'h1@text', cover: '.cover img@src|data-src', chapterItem: '.chapter a', chapterTitle: '@text', chapterLink: '@href' },
      chapter: { image: '.content img@src|data-src|data-original', nextPage: 'a:contains("下一页")@href' },
    }, null, 2))}</textarea></label>
      <div class="modal-actions"><button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="src-save">保存书源</button></div>`, true);
  }
  async function srcSave() {
    const name = $('#srcName').value.trim(), baseUrl = $('#srcBase').value.trim();
    let rules;
    try { rules = JSON.parse($('#srcRules').value); } catch { return toast('规则不是合法 JSON', true); }
    busy(true, '保存中…');
    try {
      await api('POST', '/api/sources', { body: { name, baseUrl, rules } });
      closeModal(); toast('书源已保存'); state.sourceId = ''; renderSources();
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }

  /* ------------------------------ 追更 ------------------------------ */
  async function subscribe(url, title, cover) {
    if (!state.user) return toast('请先登录', true);
    busy(true, '创建订阅…');
    try {
      await api('POST', '/api/subscriptions', {
        body: { sourceId: state.sourceId, url, title, cover, comicId: state.comic || undefined },
      });
      closeModal();
      toast('已加入追更，服务器会定时检查新章节');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  async function renderUpdates() {
    if (!state.user) { renderAuth(); return; }
    $('#content').innerHTML = '<div class="empty">正在读取订阅…</div>';
    try {
      const r = await api('GET', '/api/subscriptions');
      state.subs = r.subscriptions || [];
    } catch (err) { $('#content').innerHTML = `<div class="empty"><h3>读取失败</h3>${esc(err.message)}</div>`; return; }
    if (!state.subs.length) {
      $('#content').innerHTML = `<div class="empty"><h3>还没有追更订阅</h3>
        <p>去「在线来源」搜索漫画，在详情弹窗里点「🔔 加入追更」。<br>之后服务器会按间隔自动检查新章节，可开启自动下载。</p>
        <button class="btn primary" data-action="goto-sources">去在线来源</button></div>`;
      return;
    }
    $('#content').innerHTML = `<div class="sub-list">${state.subs.map((s) => `
      <div class="sub-card ${s.enabled ? '' : 'off'}">
        <div class="cover">${s.cover ? `<img src="${esc(s.cover)}" />` : '🔔'}</div>
        <div class="sub-main">
          <div class="card-title">${esc(s.title)}</div>
          <div class="sub-meta">
            <span class="badge">${esc(s.sourceName || '书源')}</span>
            ${s.comicExists ? `已关联书库 · ${s.chapterCount ?? '—'} 话` : '<span class="muted">未关联书库（自动下载时新建）</span>'}
          </div>
          <div class="sub-status">
            上次检查 ${fmt(s.lastCheckAt)}
            ${s.newCount ? ` · 已追到 ${s.newCount} 话新内容` : ''}
            ${s.latestChapterTitle ? ` · 最新：${esc(s.latestChapterTitle.slice(0, 24))}` : ''}
          </div>
          ${s.lastError ? `<div class="sub-err">${esc(s.lastError)}</div>` : ''}
        </div>
        <div class="sub-ops">
          <label class="sub-field">间隔
            <select class="select sm" data-sub-interval="${esc(s.id)}">
              ${[10, 30, 60, 180, 360, 720, 1440].map((m) =>
                `<option value="${m}" ${s.intervalMin === m ? 'selected' : ''}>${m < 60 ? m + ' 分钟' : m / 60 + ' 小时'}</option>`).join('')}
            </select></label>
          <button class="btn sm ${s.autoDownload ? 'primary' : ''}" data-action="sub-auto" data-id="${esc(s.id)}">${s.autoDownload ? '自动下载 ✓' : '自动下载'}</button>
          <button class="btn sm" data-action="sub-check" data-id="${esc(s.id)}">立即检查</button>
          ${s.comicExists ? `<button class="btn sm" data-action="sub-open" data-id="${esc(s.comicId)}">打开书库</button>` : ''}
          <button class="btn sm ${s.enabled ? '' : 'primary'}" data-action="sub-toggle" data-id="${esc(s.id)}">${s.enabled ? '暂停' : '已暂停'}</button>
          <button class="btn sm danger" data-action="sub-del" data-id="${esc(s.id)}">删除</button>
        </div>
      </div>`).join('')}</div>`;
  }
  function onSubInterval(e) {
    const sel = e.target.closest('[data-sub-interval]');
    if (!sel) return;
    api('PUT', `/api/subscriptions/${sel.dataset.subInterval}`, { body: { intervalMin: Number(sel.value) } })
      .then(() => toast('检查间隔已更新'))
      .catch((err) => toast(err.message, true));
  }
  async function subCheck(id) {
    const btn = $(`[data-action="sub-check"][data-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
    try {
      const r = await api('POST', `/api/subscriptions/${id}/check`);
      if (r.imported > 0) toast(`发现 ${r.fresh} 话新内容，已自动下载 ${r.imported} 话`);
      else if (r.fresh > 0) toast(`发现 ${r.fresh} 话新内容（自动下载未开启）`);
      else toast('没有新章节');
      renderUpdates();
    } catch (err) { toast(err.message, true); if (btn) { btn.disabled = false; btn.textContent = '立即检查'; } }
  }
  async function subCheckAll() {
    busy(true, '全部检查中…');
    let fresh = 0, imported = 0, failed = 0;
    for (const s of state.subs.filter((x) => x.enabled)) {
      try {
        const r = await api('POST', `/api/subscriptions/${s.id}/check`);
        fresh += r.fresh; imported += r.imported;
      } catch { failed++; }
    }
    busy(false);
    renderUpdates();
    toast(`检查完成：新章节 ${fresh} 话，下载 ${imported} 话${failed ? `，失败 ${failed} 个订阅` : ''}`);
  }

  /* ------------------------------ 漫画详情 ------------------------------ */
  async function renderComic() {
    const id = state.comic;
    if (!id) return renderLibrary();
    $('#content').innerHTML = '<div class="empty">正在载入…</div>';
    let c;
    try { c = await api('GET', `/api/comics/${id}`); }
    catch (err) { $('#content').innerHTML = `<div class="empty"><h3>打不开</h3>${esc(err.message)}</div>`; return; }
    state.comicData = c;
    const chapters = c.chapters || [];
    const totalPages = chapters.reduce((n, x) => n + (x.pages || []).length, 0);

    // 阅读进度（服务器同步）：定位到话 + 页
    let progressHtml = '';
    const pg = c.progress;
    if (pg && pg.chapterId) {
      const ci = chapters.findIndex((x) => x.id === pg.chapterId);
      if (ci >= 0) {
        const ch = chapters[ci];
        const pct = ch.pages.length ? Math.min(100, Math.round(((pg.pageIndex || 0) + 1) / ch.pages.length * 100)) : 0;
        progressHtml = `<div class="progress-line">
          <div class="progress-info"><span class="badge">进度</span>
            上次读到 <b>第 ${ci + 1} 话 · ${esc(ch.title)}</b> 第 ${(pg.pageIndex || 0) + 1} 页（${pct}%）
            <span class="muted">· ${fmt(pg.updatedAt)} 同步</span></div>
          <div class="progress-bar"><i style="width:${pct}%"></i></div>
        </div>`;
      }
    }

    $('#content').innerHTML = `<div class="panel"><div class="panel-title"><h3>${esc(c.title)}</h3>
        <span class="muted">${chapters.length} 话 · ${totalPages} 页</span></div>
      ${progressHtml}
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="add-chapter">＋ 新建一话</button>
        <button class="btn" data-action="add-pages" data-id="${esc(chapters[0]?.id || '')}">↑ 上传页面到第一话</button>
        <span class="spacer"></span>
        ${!isMobile ? `<button class="btn" data-action="export-comic">⇩ 导出整本 CBZ</button>` : ''}
      </div></div>
      ${chapters.length ? `<table class="table"><thead><tr><th style="width:52px">#</th><th>话标题</th><th style="width:70px">页数</th><th style="width:340px">操作</th></tr></thead><tbody>
        ${chapters.map((ch, i) => `<tr class="${pg && pg.chapterId === ch.id ? 'reading' : ''}">
          <td>${pg && pg.chapterId === ch.id ? '<span class="badge">读</span>' : i + 1}</td>
          <td>${esc(ch.title)}${pg && pg.chapterId === ch.id ? ` <span class="muted" style="font-size:11px">· 第 ${(pg.pageIndex || 0) + 1} 页</span>` : ''}</td>
          <td>${(ch.pages || []).length}</td>
          <td class="ch-ops">
            <button class="btn sm" data-action="read-chapter" data-id="${esc(ch.id)}">阅读</button>
            <button class="btn sm" data-action="rename-chapter" data-id="${esc(ch.id)}">重命名</button>
            <button class="btn sm icon" data-action="move-chapter" data-id="${esc(ch.id)}" data-dir="-1" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm icon" data-action="move-chapter" data-id="${esc(ch.id)}" data-dir="1" title="下移" ${i === chapters.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn sm" data-action="add-pages" data-id="${esc(ch.id)}">加页</button>
            ${!isMobile ? `<button class="btn sm" data-action="export-chapter" data-id="${esc(ch.id)}">导出</button>` : ''}
            <button class="btn sm danger" data-action="del-chapter" data-id="${esc(ch.id)}">删除</button>
          </td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有话，点「新建一话」开始</div>'}`;
  }
  function chapterOf(id) { return (state.comicData?.chapters || []).find((x) => x.id === id); }
  async function renameChapter(id) {
    const ch = chapterOf(id);
    if (!ch) return;
    const title = prompt('修改话标题', ch.title);
    if (!title || title === ch.title) return;
    await api('PATCH', `/api/comics/${state.comic}/chapters/${id}`, { body: { title } });
    renderComic(); toast('已重命名');
  }
  async function moveChapter(id, dir) {
    const chs = state.comicData?.chapters || [];
    const i = chs.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= chs.length) return;
    const order = chs.map((x) => x.id);
    [order[i], order[j]] = [order[j], order[i]];
    await api('PUT', `/api/comics/${state.comic}/chapters/reorder`, { body: { order } });
    renderComic();
  }
  async function delChapter(id) {
    const ch = chapterOf(id);
    if (!ch) return;
    if (!confirm(`删除「${ch.title}」及其 ${(ch.pages || []).length} 页？不可恢复。`)) return;
    await api('DELETE', `/api/comics/${state.comic}/chapters/${id}`);
    renderComic(); toast('已删除');
  }
  async function exportCbz(chapterId) {
    const c = state.comicData;
    if (!c) return;
    const ch = chapterId ? chapterOf(chapterId) : null;
    const q = chapterId ? `&chapters=${encodeURIComponent(chapterId)}` : '';
    const name = `${c.title}${ch ? '·' + ch.title : ''}.cbz`.replace(/[\\/:*?"<>|]/g, '_');
    if (!Host.saveApiFile) return toast('这个客户端版本暂不支持导出，请升级', true);
    const r = await Host.saveApiFile(`/api/export/${c.id}?format=cbz${q}`, name);
    if (r && r.ok) toast(`已保存：${r.path}`);
    else if (r && !r.canceled) toast(r.error || '导出失败', true);
  }
  async function addChapter() {
    const title = prompt('新一话的标题', `第 ${(state.comicData?.chapters || []).length + 1} 话`);
    if (!title) return;
    try { await api('POST', `/api/comics/${state.comic}/chapters`, { body: { title } }); renderComic(); toast('已新建'); }
    catch (err) { toast(err.message, true); }
  }
  async function addPages(chapterId) {
    if (!chapterId) return toast('请先新建一话', true);
    const paths = await Host.pickFiles();
    if (!paths || !paths.length) return;
    await uploadInto(state.comic, chapterId, paths);
  }

  /* ------------------------------ 导入（桌面核心优势） ------------------------------ */
  async function uploadInto(comicId, chapterId, paths) {
    const total = paths.length;
    let done = 0;
    busy(true, `正在上传 ${done}/${total}`);
    try {
      for (let i = 0; i < paths.length; i += 12) {
        const batch = paths.slice(i, i + 12).map((p) => typeof p === 'string'
          ? { path: p, name: base(p), field: 'files' }
          : { id: p.id, name: nameOf(p), field: 'files' });
        await api('POST', `/api/comics/${comicId}/chapters/${chapterId}/pages`, { files: batch });
        done += batch.length;
        const el = $('#busyLabel'); if (el) el.textContent = `正在上传 ${done}/${total}`;
      }
      toast(`已导入 ${done} 页`);
      state.view = 'comic'; state.comic = comicId; render();
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /* 章节页式网格：点选/取消、编号即页序、按名称排序，缩略图由宿主提供 */
  function updateImportCount() {
    const el = $('#impCount');
    if (el) el.textContent = `已选 ${state.importSel.size} / ${(state.importPaths || []).length} 个文件`;
  }
  function renderImportGrid() {
    const grid = $('#impGrid');
    if (!grid) return;
    grid.innerHTML = (state.importPaths || []).map((p, i) => {
      const key = keyOf(p), name = nameOf(p), on = state.importSel.has(key);
      return `<label class="imp-cell ${on ? 'on' : ''}" title="${esc(name)}">
        <input type="checkbox" data-key="${esc(key)}" ${on ? 'checked' : ''} />
        <span class="imp-thumb" data-thumb="${esc(key)}"><span class="imp-ext">${esc(extOf(name))}</span></span>
        <span class="imp-n">${i + 1}</span>
        <span class="imp-name">${esc(name)}</span>
      </label>`;
    }).join('');
    updateImportCount();
    if (Host.thumb) {
      $$('#impGrid .imp-thumb').forEach((box) => {
        const key = box.dataset.thumb;
        Promise.resolve(Host.thumb(key)).then((u) => {
          if (u) box.innerHTML = `<img src="${esc(u)}" alt="" />`;
        }).catch(() => {});
      });
    }
  }
  /** 统一导入入口：压缩包走服务端 7z 解压（和网站一样），图片走本地网格 */
  async function startImportFrom(rawPaths) {
    if (!rawPaths || !rawPaths.length) return;
    let paths = rawPaths.filter((p) => typeof p === 'string');
    // 与网站 ImportDialog 完全一致的支持格式（图片 / 各类压缩包 / EPUB / PDF）
    const archives = paths.filter((p) => /\.(zip|cbz|rar|cbr|cb7|7z|r\d{2}|tar|tgz|gz|bz2|xz|epub|pdf|ace|arj|lzh|lha|cab|iso)$/i.test(p));
    const images = paths.filter((p) => !archives.includes(p));
    if (images.length) await startImport(images);
    if (archives.length) await importArchives(archives);
  }
  /** ZIP/CBZ/RAR/7Z/EPUB/PDF：交给服务端解压/渲染 → 按目录分话确认 → 落盘成章节。
   *  每个压缩包用自己独立的 sessionId 提交（旧版多包只保留最后一个 session，前面的会全丢），
   *  第一个包创建新漫画，后续包追加到同一本漫画的章节里。 */
  async function importArchives(paths) {
    if (!state.user) return toast('请先登录再导入', true);
    const packs = [];
    for (const p of paths) {
      busy(true, `解析 ${base(p)}…`);
      try {
        const r = await api('POST', '/api/import/archive', {
          files: [{ path: p, name: base(p), field: 'file' }],
        });
        if (r.sessionId && (r.files || []).length) {
          packs.push({ path: p, sessionId: r.sessionId, files: r.files, meta: r.fields || {} });
        } else if (r.error) {
          toast(`${base(p)}：${r.error}`, true);
        }
      } catch (err) { toast(`${base(p)}：${err.message}`, true); }
      finally { busy(false); }
    }
    if (!packs.length) return toast('没有解析出可导入的页面', true);
    const meta = packs[0].meta || {};
    const totalPages = packs.reduce((n, k) => n + k.files.length, 0);
    // 每个包一个确认项：包内按一级目录分话，标题默认取包名
    const plan = packs.map((k) => {
      const groupsMap = new Map();
      for (const f of k.files) {
        const parts = String(f.path || f.name).split('/');
        const g = parts.length > 1 ? parts[0] : '';
        if (!groupsMap.has(g)) groupsMap.set(g, []);
        groupsMap.get(g).push(f.path);
      }
      const groups = [...groupsMap.entries()].map(([dir, list], i) => ({
        title: dir || base(k.path).replace(/\.[^.]+$/, '') || `第 ${i + 1} 话`,
        paths: list.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { numeric: true })),
      }));
      return { ...k, groups };
    });
    const groupCount = plan.reduce((n, k) => n + k.groups.length, 0);
    // 扁平化为纯数字索引，避免属性选择器里的特殊字符/CSS.escape 兼容问题
    const flat = [];
    plan.forEach((k, pi) => k.groups.forEach((g) => flat.push({ pi, g, pack: k, idx: flat.length })));
    openModal(`<h3>导入 · ${packs.length} 个文件 / ${totalPages} 页 / ${groupCount} 话</h3>
      <div class="imp-archive-groups" style="max-height:300px;overflow:auto">
        ${flat.map((row) => `<label class="field" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <span class="muted" style="font-size:11px;min-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(base(row.pack.path))}">${esc(base(row.pack.path))}</span>
          <input class="input" data-arc-gi="${row.idx}" value="${esc(row.g.title)}" />
          <span class="muted" style="font-size:11px;white-space:nowrap">${row.g.paths.length} 页</span></label>`).join('')}
      </div>
      <label class="field"><span>漫画标题</span><input class="input" id="arcTitle" value="${esc(meta.title || base(packs[0].path).replace(/\.[^.]+$/, ''))}" /></label>
      <label class="field"><span>作者（可选）</span><input class="input" id="arcAuthor" value="${esc(meta.author || '')}" /></label>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="arc-commit">导入书库</button>
      </div>`, true);
    $('#modal').querySelector('[data-action="arc-commit"]').onclick = async () => {
      busy(true, '正在导入书库…');
      let comicId = '';
      try {
        for (let pi = 0; pi < plan.length; pi++) {
          const k = plan[pi];
          const groups = flat.filter((r) => r.pi === pi).map((r) => {
            const el = document.querySelector(`[data-arc-gi="${r.idx}"]`);
            return { ...r.g, title: el?.value.trim() || r.g.title };
          });
          const r = await api('POST', `/api/import/archive/${k.sessionId}/commit`, { body: {
            groups,
            comicId: comicId || undefined,
            title: $('#arcTitle').value.trim() || '导入的漫画',
            author: $('#arcAuthor').value.trim(),
            direction: meta.direction || 'ltr',
          } });
          if (!comicId) comicId = r.comic?.id || r.comicId || '';
        }
        closeModal();
        toast('导入完成');
        state.view = 'comic'; state.comic = comicId; render();
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    };
  }
  async function startImport(rawPaths) {
    if (!state.user) { state.view = 'library'; render(); return toast('请先登录再导入', true); }
    let paths = rawPaths;
    try { paths = await Host.resolvePaths(rawPaths); } catch { /* 已是文件列表 */ }
    if (!paths || !paths.length) return toast('没有找到可用图片', true);
    paths = paths.slice();
    try { paths.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { numeric: true })); } catch { /* 忽略 */ }
    state.importPaths = paths;
    state.importSel = new Set(paths.map(keyOf));
    let comics = state.comics;
    try { comics = (await api('GET', '/api/comics')).comics || []; } catch { /* 忽略 */ }
    const options = comics.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    openModal(`<h3>导入漫画 · ${paths.length} 个文件</h3>
      <div class="imp-tools"><span class="muted" id="impCount"></span>
        <span class="spacer"></span>
        <button class="btn sm" id="impAll" type="button">全选</button>
        <button class="btn sm" id="impInvert" type="button">反选</button>
        <button class="btn sm" id="impSort" type="button">按名称排序</button>
        <button class="btn sm" id="impReverse" type="button">倒序</button></div>
      <div class="imp-grid" id="impGrid"></div>
      <p class="muted" style="font-size:11px;margin:10px 0 0">像章节页一样点格子勾选或取消，编号就是导入后的页序。手机端可在系统选择器里进入 Kotatsu 等「漫画页面」来源一次多选。</p>
      <label class="field"><span>导入到</span>
        <select class="select" id="impTarget"><option value="__new__">＋ 新建一本漫画</option>${options}</select></label>
      <label class="field" id="impTitleRow"><span>漫画标题</span><input class="input" id="impTitle" value="${esc(nameOf(paths[0]).replace(/\.[^.]+$/, ''))}" /></label>
      <label class="field"><span>话标题</span><input class="input" id="impChapter" value="第 1 话" /></label>
      <div class="modal-actions"><button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="do-import">开始导入</button></div>
      <span id="busyLabel" class="muted" style="font-size:11px"></span>`, true);
    renderImportGrid();
    $('#impTarget').addEventListener('change', (e) => {
      $('#impTitleRow').style.display = e.target.value === '__new__' ? '' : 'none';
    });
    $('#impGrid').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      if (cb.checked) state.importSel.add(cb.dataset.key); else state.importSel.delete(cb.dataset.key);
      cb.closest('.imp-cell')?.classList.toggle('on', cb.checked);
      updateImportCount();
    });
    const setAll = (fn) => {
      state.importSel = new Set((state.importPaths || []).filter(fn).map(keyOf));
      renderImportGrid();
    };
    $('#impAll').onclick = () => setAll(() => true);
    $('#impInvert').onclick = () => setAll((p) => !state.importSel.has(keyOf(p)));
    $('#impSort').onclick = () => {
      state.importPaths.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { numeric: true }));
      renderImportGrid();
    };
    $('#impReverse').onclick = () => { state.importPaths.reverse(); renderImportGrid(); };
  }
  async function doImport() {
    const paths = (state.importPaths || []).filter((p) => state.importSel.has(keyOf(p)));
    if (!paths.length) return toast('请至少勾选一个文件', true);
    const target = $('#impTarget').value;
    let comicId = target, chapterId = '';
    busy(true, '准备中…');
    try {
      if (target === '__new__') {
        const c = await api('POST', '/api/comics', { body: { title: $('#impTitle').value.trim() || '导入的漫画' } });
        comicId = c.id;
        const chs = await api('POST', `/api/comics/${comicId}/chapters`, { body: { title: $('#impChapter').value.trim() || '第 1 话' } });
        chapterId = (Array.isArray(chs) ? chs[chs.length - 1] : chs.chapters?.slice(-1)[0])?.id;
      } else {
        const c = await api('GET', `/api/comics/${comicId}`);
        const chs = await api('POST', `/api/comics/${comicId}/chapters`, { body: { title: $('#impChapter').value.trim() || `第 ${(c.chapters || []).length + 1} 话` } });
        chapterId = (Array.isArray(chs) ? chs[chs.length - 1] : chs.chapters?.slice(-1)[0])?.id;
      }
      if (!chapterId) throw new Error('创建章节失败');
      closeModal();
      await uploadInto(comicId, chapterId, paths);
      state.importPaths = null;
      state.importSel = new Set();
    } catch (err) { toast(err.message, true); busy(false); }
  }

  /* ------------------------------ 公共书库 ------------------------------ */
  async function renderCommunity() {
    $('#content').innerHTML = '<div class="empty">载入中…</div>';
    try {
      const [cat, list] = await Promise.all([
        api('GET', '/api/community/categories'),
        api('GET', '/api/community/comics', { query: { q: state.q, category: state.category, sort: 'updated' } }),
      ]);
      state.categories = cat.categories || [];
      state.community = list.comics || [];
    } catch (err) { $('#content').innerHTML = `<div class="empty"><h3>读取失败</h3>${esc(err.message)}</div>`; return; }
    const chips = state.categories.map((c) => `<button class="chip ${state.category === c.id ? 'active' : ''}" data-action="category" data-id="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)} ${c.count ?? ''}</button>`).join('');
    const cards = state.community.map((c) => `<div class="card" data-action="open-comic" data-id="${esc(c.id)}">
      <div class="cover">${coverUrl(c) ? `<img src="${esc(coverUrl(c))}" loading="lazy" />` : '📚'}</div>
      <div class="card-body"><div class="card-title">${esc(c.title)}</div>
        <div class="card-meta">${c.pageCount || 0} 页 · 👁 ${c.views || 0}</div></div></div>`).join('');
    $('#content').innerHTML = `<div class="chips">${chips}</div>
      ${state.community.length ? `<div class="grid">${cards}</div>` : '<div class="empty"><h3>没有匹配的漫画</h3></div>'}`;
  }

  /* ------------------------------ 广场 ------------------------------ */
  async function renderPlaza() {
    $('#content').innerHTML = '<div class="empty">载入中…</div>';
    let ann = [], canAnnounce = false;
    try { const a = await api('GET', '/api/announcements'); ann = a.announcements || []; } catch { /* 忽略 */ }
    try {
      const r = await api('GET', '/api/plaza/posts', { query: { board: state.board, q: state.q } });
      state.posts = r.posts || []; state.boards = r.boards || [];
    } catch (err) { $('#content').innerHTML = `<div class="empty"><h3>读取失败</h3>${esc(err.message)}</div>`; return; }
    canAnnounce = !!state.user?.canAnnounce;
    const chips = state.boards.map((b) => `<button class="chip ${state.board === b.id ? 'active' : ''}" data-action="board" data-id="${esc(b.id)}">${esc(b.name)} ${b.count ?? ''}</button>`).join('');
    const composer = state.user ? `<div class="panel"><textarea class="textarea" id="postText" placeholder="说点什么…"></textarea>
      <div class="row" style="margin-top:9px"><span class="spacer"></span><button class="btn primary" data-action="publish">发布</button></div></div>` : '<div class="panel muted">登录后可以发帖</div>';
    const annPanel = `
      ${ann.length ? `<div class="panel"><h3>📢 公告</h3>${ann.slice(0, 5).map((a) => `
        <div class="ann-item" style="padding:8px 0;border-bottom:1px solid var(--line)">
          <b>${esc(a.title)}</b> <span class="muted" style="font-size:11px">${fmt(a.at)}</span>
          <div style="font-size:13px;margin-top:3px;white-space:pre-wrap">${esc(a.content)}</div></div>`).join('')}</div>` : ''}
      ${canAnnounce ? `<div class="panel"><h3>发布公告</h3>
        <label class="field"><span>标题</span><input class="input" id="annTitle" placeholder="公告标题" /></label>
        <label class="field"><span>内容</span><textarea class="textarea" id="annBody" placeholder="公告内容…"></textarea></label>
        <div class="row"><span class="spacer"></span><button class="btn primary" data-action="announce">发公告</button></div></div>` : ''}`;
    const posts = state.posts.map((p) => `<div class="post"><div class="post-head"><b>${esc(p.authorName || '匿名')}</b>
      <span>${esc(p.boardName || '')}</span><span class="spacer"></span><span>${fmt(p.createdAt)}</span></div>
      <div class="post-body">${esc(p.content || '')}</div></div>`).join('');
    $('#content').innerHTML = `${annPanel}<div class="chips">${chips}</div>${composer}
      ${state.posts.length ? posts : '<div class="empty">还没有帖子</div>'}`;
  }
  async function publishAnnouncement() {
    const title = $('#annTitle')?.value.trim(), content = $('#annBody')?.value.trim();
    if (!title || !content) return toast('请填写公告标题和内容', true);
    busy(true, '发布中…');
    try {
      await api('POST', '/api/announcements', { body: { title, content } });
      toast('公告已发布'); renderPlaza();
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  async function publish() {
    const content = $('#postText')?.value.trim();
    if (!content) return toast('写点内容吧', true);
    try { await api('POST', '/api/plaza/posts', { body: { content, board: state.board === 'all' ? 'chat' : state.board } }); toast('已发布'); renderPlaza(); }
    catch (err) { toast(err.message, true); }
  }

  /* ------------------------------ 设置 ------------------------------ */
  async function renderSettings() {
    const rt = await api('GET', '/api/runtime').catch(() => null);
    const u = state.update;
    const cfg = await Host.getConfig().catch(() => ({}));
    const isLocal = cfg.mode !== 'remote';
    $('#content').innerHTML = `${state.user ? `<div class="panel"><h3>账号</h3>
      <div class="user-line" style="margin-bottom:10px">${state.user.avatar ? `<img class="avatar-mini" style="width:52px;height:52px" src="${esc(asset(state.user.avatar))}" />` : `<span class="avatar-mini letter" style="width:52px;height:52px;font-size:22px">${esc(state.user.name.slice(0, 1).toUpperCase())}</span>`}
        <div><b>${esc(state.user.name)}</b><br><span class="muted">${esc(state.user.email)}</span></div></div>
      <div class="row"><button class="btn" data-action="upload-avatar">修改头像</button>
        <button class="btn ghost" data-action="logout">退出登录</button></div></div>` : ''}
      <div class="panel"><h3>数据与同步</h3>
      <div class="row">
        <button class="btn ${isLocal ? 'primary' : ''}" data-action="set-mode" data-id="local">本机模式（推荐）</button>
        <button class="btn ${!isLocal ? 'primary' : ''}" data-action="set-mode" data-id="remote">连接站点</button></div>
      ${isLocal
        ? `<p class="muted" style="font-size:12px;margin:10px 0 0">软件内置了完整服务，打开就能用：<b>导入、阅读、账号都在本机</b>，不需要填任何链接。想和手机 / 网站共用数据时切到「连接站点」。</p>`
        : `<label class="field" style="margin-top:10px"><span>站点地址</span>
            <input class="input" id="setServer" value="${esc(cfg.server || '')}" placeholder="https://你的站点" /></label>
          <div class="row"><button class="btn" data-action="save-server">保存并连接</button>
          <button class="btn ghost" data-action="open-site">在浏览器打开</button></div>`}
      <div class="kv" style="margin-top:10px"><span>服务版本</span><b>${esc(rt?.version || '—')}</b></div></div>

      <div class="panel"><h3>外观</h3>
        <div class="row"><button class="btn ${state.theme === 'dark' ? 'primary' : ''}" data-action="theme" data-id="dark">深色</button>
          <button class="btn ${state.theme === 'light' ? 'primary' : ''}" data-action="theme" data-id="light">浅色</button></div></div>

      <div class="panel"><div class="panel-title"><h3>检查更新</h3>
        <button class="btn primary" data-action="check-update">检查更新</button></div>
        <div id="updateBox">${u ? updateHtml(u) : '<span class="muted">尚未检查</span>'}</div></div>

      <div class="panel"><h3>关于</h3>
        <div class="kv"><span>版本</span><b>v${esc(Host.version || '—')}（${isMobile ? 'Android' : '桌面'}）</b></div>
        <div class="kv"><span>数据</span><b>${isLocal ? '保存在本机' : '与网站 / 手机实时互通'}</b></div></div>`;
  }
  function updateHtml(u) {
    if (!u.ok) return `<span style="color:var(--danger)">检查失败：${esc(u.error || '未知错误')}</span>`;
    return `<div class="kv"><span>当前版本</span><b>v${esc(u.current || Host.version || '—')}</b></div>
      <div class="kv"><span>最新版本</span><b>v${esc(u.latest || '—')}</b></div>
      <div class="kv"><span>状态</span><b style="color:${u.hasUpdate ? 'var(--warn)' : 'var(--accent)'}">${u.hasUpdate ? '发现新版本' : '已是最新'}</b></div>
      ${(u.notes || []).length ? `<ul class="notes">${u.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${u.hasUpdate ? `<div class="row" style="margin-top:10px">
        ${u.installerUrl && !isMobile ? '<button class="btn primary" data-action="install-update">⬇ 一键下载并安装</button>' : ''}
        <button class="btn" data-action="open-download">在浏览器打开下载</button></div>` : ''}`;
  }
  async function checkUpdate() {
    busy(true, '检查中…');
    try { state.update = await Host.checkUpdate(); renderSettings(); toast(state.update.hasUpdate ? '发现新版本' : '已是最新版本'); }
    catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 软件内直接更新：下载安装包并运行安装 */
  async function installUpdate() {
    const u = state.update;
    const url = u?.installerUrl || u?.downloadUrl;
    if (!url) return toast('没有可用的下载地址', true);
    busy(true, '下载新版本…');
    try {
      const r = await Host.installUpdate(url);
      if (!r?.ok) throw new Error(r?.error || '下载失败');
      toast(r.installed ? '安装包已就绪，安装完成后重新打开软件' : '已保存到下载目录');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }

  /* ------------------------------ 事件 ------------------------------ */
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-sub-interval]');
    if (!sel) return;
    api('PUT', `/api/subscriptions/${sel.dataset.subInterval}`, { body: { intervalMin: Number(sel.value) } })
      .then(() => toast('检查间隔已更新'))
      .catch((err) => toast(err.message, true));
  });
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action, id = el.dataset.id;
    try {
      if (a === 'nav' || el.classList.contains('nav-item')) { state.view = el.dataset.view; render(); }
      else if (a === 'auth-tab') renderAuthForm(el.dataset.mode);
      else if (a === 'auth-submit') await authSubmit(el.dataset.mode);
      else if (a === 'auth-send-code') await sendCode();
      else if (a === 'auth-toggle-pwd') {
        const pwd = $('#authPwd'), btn = el;
        if (pwd) {
          pwd.type = pwd.type === 'password' ? 'text' : 'password';
          btn.textContent = pwd.type === 'password' ? '显示' : '隐藏';
        }
      }
      else if (a === 'auth-code-login') await authCodeLogin();
      else if (a === 'logout') { await api('POST', '/api/auth/logout'); await refreshStatus(); render(); }
      else if (a === 'new-comic') {
        const title = prompt('漫画标题', '未命名漫画');
        if (title) { await api('POST', '/api/comics', { body: { title } }); renderLibrary(); toast('已创建'); }
      }
      else if (a === 'pick-import') await startImportFrom(Host.pickImport ? await Host.pickImport() : await Host.pickFiles());
      else if (a === 'pick-files') startImport(await Host.pickFiles());
      else if (a === 'pick-folder') startImport(await Host.pickFolder());
      else if (a === 'open-comic') { state.comic = id; state.view = 'comic'; render(); }
      else if (a === 'back-library') { state.view = 'library'; state.comic = null; render(); }
      else if (a === 'add-chapter') await addChapter();
      else if (a === 'add-pages') await addPages(id);
      else if (a === 'read-first' || a === 'read-chapter') {
        const c = state.comicData;
        let ch;
        if (a === 'read-chapter') ch = id;
        else {
          // 有同步进度就从上次读到的话继续
          const p = c?.progress;
          ch = p?.chapterId && (c.chapters || []).some((x) => x.id === p.chapterId) ? p.chapterId : (c?.chapters || [])[0]?.id;
        }
        if (ch) await Host.openReader(state.comic, ch); else toast('这一本还没有话', true);
      }
      else if (a === 'refresh-view') await renderLibrary();
      else if (a === 'search') { state.q = $('#searchInput')?.value.trim() || ''; render(); }
      else if (a === 'category') { state.category = id; renderCommunity(); }
      else if (a === 'board') { state.board = id; renderPlaza(); }
      else if (a === 'publish') await publish();
      else if (a === 'announce') await publishAnnouncement();
      else if (a === 'close-modal') closeModal();
      else if (a === 'copy-code') {
        const code = $('#codeBig')?.textContent.trim() || '';
        try { await Host.copyText(code); } catch { try { await navigator.clipboard.writeText(code); } catch { /* 忽略 */ } }
        toast('验证码已复制');
      }
      else if (a === 'use-code') closeModal();
      else if (a === 'do-import') await doImport();
      else if (a === 'toggle-select') { state.selecting = !state.selecting; state.selComics = new Set(); render(); }
      else if (a === 'sel-comic') { if (state.selComics.has(id)) state.selComics.delete(id); else state.selComics.add(id); renderLibrary(); }
      else if (a === 'sel-all') { state.selComics = new Set(state.comics.map((c) => c.id)); renderLibrary(); }
      else if (a === 'sel-none') { state.selComics = new Set(); renderLibrary(); }
      else if (a === 'sel-delete') {
        const n = state.selComics.size;
        if (!n) return;
        if (!confirm(`确定删除选中的 ${n} 本漫画？删除后无法恢复。`)) return;
        busy(true, '删除中…');
        let ok = 0;
        for (const cid of state.selComics) {
          try { await api('DELETE', `/api/comics/${cid}`); ok++; } catch { /* 忽略单个失败 */ }
        }
        state.selComics = new Set(); state.selecting = false;
        busy(false); render(); toast(`已删除 ${ok} 本`);
      }
      else if (a === 'goto-sources') { state.view = 'sources'; render(); }
      else if (a === 'src-search') await srcSearch();
      else if (a === 'src-open') await srcOpen(Number(el.dataset.i));
      else if (a === 'src-import') await srcImport();
      else if (a === 'src-manage') srcManage();
      else if (a === 'src-save') await srcSave();
      else if (a === 'src-subscribe') await subscribe(el.dataset.url, el.dataset.title, el.dataset.cover);
      else if (a === 'rename-chapter') await renameChapter(id);
      else if (a === 'move-chapter') await moveChapter(id, Number(el.dataset.dir));
      else if (a === 'del-chapter') await delChapter(id);
      else if (a === 'export-chapter') await exportCbz(id);
      else if (a === 'export-comic') await exportCbz('');
      else if (a === 'sub-check') await subCheck(id);
      else if (a === 'sub-check-all') await subCheckAll();
      else if (a === 'sub-toggle') {
        const s = state.subs.find((x) => x.id === id);
        await api('PUT', `/api/subscriptions/${id}`, { body: { enabled: !(s?.enabled !== false) } });
        renderUpdates();
      }
      else if (a === 'sub-auto') {
        const on = $(`[data-action="sub-auto"][data-id="${id}"]`)?.classList.contains('primary');
        await api('PUT', `/api/subscriptions/${id}`, { body: { autoDownload: !on } });
        renderUpdates();
      }
      else if (a === 'sub-open') { state.comic = id; state.view = 'comic'; render(); }
      else if (a === 'sub-del') {
        if (!confirm('取消追更这个订阅？（不会删除已下载的漫画）')) return;
        await api('DELETE', `/api/subscriptions/${id}`);
        renderUpdates(); toast('已取消订阅');
      }
      else if (a === 'upload-avatar') await uploadAvatar();
      else if (a === 'set-mode') {
        await Host.setMode(id);
        await refreshStatus(); renderSettings();
        toast(id === 'local' ? '已切换到本机模式' : '请填写站点地址后连接');
      }
      else if (a === 'save-server') {
        busy(true, '连接中…');
        await Host.setServer($('#setServer').value.trim());
        await refreshStatus();
        toast(state.user ? '已连接' : '已保存，请检查地址是否正确');
        busy(false); renderSettings();
      }
      else if (a === 'install-update') await installUpdate();
      else if (a === 'theme') { state.theme = id; document.documentElement.dataset.theme = id; await Host.setTheme(id); renderSettings(); }
      else if (a === 'check-update') await checkUpdate();
      else if (a === 'open-site') await Host.openExternal(await Host.siteUrl());
      else if (a === 'open-download') await Host.openDownload();
    } catch (err) { toast(err.message || String(err), true); busy(false); }
  });
  $('#sideNav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item'); if (!b) return;
    state.view = b.dataset.view; render();
  });
  $('#modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('#searchInput') === document.activeElement) { state.q = $('#searchInput').value.trim(); render(); }
    if (e.key === 'Escape') closeModal();
  });

  /* 拖拽：Electron 用 webUtils 拿真实路径；手机端忽略 */
  if (Host.pathForFile) {
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); } });
    document.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
      const paths = [...(e.dataTransfer?.files || [])].map((f) => Host.pathForFile(f)).filter(Boolean);
      if (paths.length) startImport(paths);
    });
  }
  if (Host.onMenu) Host.onMenu((action) => {
    if (action === 'new-comic') { state.view = 'library'; render(); document.querySelector('[data-action="new-comic"]')?.click(); }
    else if (action === 'pick-import') startImportFrom(await (Host.pickImport ? Host.pickImport() : Host.pickFiles()));
    else if (action === 'pick-files') Host.pickFiles().then(startImport);
    else if (action === 'pick-folder') Host.pickFolder().then(startImport);
    else if (action === 'settings') { state.view = 'settings'; render(); }
    else if (action === 'check-update') { state.view = 'settings'; render(); checkUpdate(); }
    else if (action === 'refresh') render();
    else if (action === 'back') { state.view = 'library'; state.comic = null; render(); }
  });

  boot();
})();
