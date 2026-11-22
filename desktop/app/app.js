/* 漫画库 · 独立桌面/手机客户端
   不加载网站页面，所有数据通过宿主进程直连同一服务器的 /api 接口。 */
(() => {
  'use strict';

  const Host = window.cvApp || window.CVAndroid;
  const isMobile = !!window.CVAndroid;
  if (isMobile) document.body.classList.add('mobile');

  /* 固定后端与公开站点：即使宿主进程没有提供 cv:share-config（旧客户端 / 升级途中），
     分享链接也必须拼成完整可打开的 URL，绝不退化成裸 token 的一串随机字母。
     与网站 src/lib/api.ts 的 shareLandingUrl() 保持同一套地址与凭据。 */
  const FALLBACK_SERVER = 'https://a3375579f1d0038dc.app.workbuddy.host';
  const FALLBACK_SHARECODE = 'HDZTNNHTBW';
  const FALLBACK_PUBLIC_SITE = 'https://gugujungu05-sketch.github.io/comic-vault/';

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
    importPaths: null, importSel: new Set(), importIntoChapter: '', comicCoverPick: null,
    sourcesList: [], sourceId: '', srcResults: [], srcComic: null, srcChecked: new Set(),
    srcMode: 'discover', srcTabs: [], srcTab: 0, srcPage: 1, srcMaxPage: 1, srcKw: '',
    subs: [],
    selecting: false, selComics: new Set(),
    trCfg: null,   // AI 翻译配置（生肉漫画→中文）
    // 全局导入任务：{active, done, total, failed, label, comicId, finished}
    importTask: { active: false, done: 0, total: 0, failed: 0, label: '', comicId: '', finished: false },
  };

  /* ------------------------------ 全局导入任务栏 ------------------------------ */
  const IT_KEY = 'cv_import_task';
  function saveImportTask() {
    try { localStorage.setItem(IT_KEY, JSON.stringify(state.importTask)); } catch { /* 忽略 */ }
  }
  function loadImportTask() {
    try {
      const raw = localStorage.getItem(IT_KEY);
      if (raw) state.importTask = Object.assign(state.importTask, JSON.parse(raw));
    } catch { /* 忽略 */ }
  }
  function renderImportTask() {
    const box = $('#importTaskbar');
    if (!box) return;
    const t = state.importTask;
    if (!t || (!t.active && !t.finished)) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
    const status = t.finished
      ? `<b>${t.failed ? `完成 · 失败 ${t.failed} 话` : '导入完成'}</b>`
      : `<b>${esc(t.label || '正在导入…')}</b><span>${t.done}/${t.total || '?'} 话${t.failed ? ` · 失败 ${t.failed}` : ''}</span>`;
    box.innerHTML = `<div class="itb-icon">${t.finished ? '✓' : '⇩'}</div>
      <div class="itb-body">${status}
        ${t.finished ? '' : `<div class="itb-track"><i style="width:${pct}%"></i></div>`}</div>
      ${t.finished && t.comicId ? `<button class="itb-btn" data-action="itb-open">查看</button>` : ''}
      <button class="itb-close" data-action="itb-close" aria-label="关闭">×</button>`;
  }
  loadImportTask();

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
  /* GET 结果短时内存缓存：来源发现页/书源列表等读多写少的接口，几秒内重复进入直接复用，
     明显减少"每次点进来都重新联网抓取"造成的卡顿。写操作与带 noCache 的请求不走缓存。 */
  const _apiCache = new Map();
  function cacheGet(path, query) {
    const key = path + '?' + JSON.stringify(query || {});
    const hit = _apiCache.get(key);
    if (hit && Date.now() - hit.t < 8000) return hit.v;
    return null;
  }
  function cachePut(path, query, v) {
    const key = path + '?' + JSON.stringify(query || {});
    _apiCache.set(key, { t: Date.now(), v });
    if (_apiCache.size > 120) {
      const now = Date.now();
      for (const [k, x] of _apiCache) if (now - x.t > 30000) _apiCache.delete(k);
    }
  }
  async function api(method, path, opts = {}) {
    if (method === 'GET' && !opts.noCache) {
      const cached = cacheGet(path, opts.query);
      if (cached !== null) return cached;
    }
    const r = await Host.api({ method, path, query: opts.query || {}, body: opts.body, files: opts.files });
    if (r.status >= 400) throw new Error((r.data && r.data.error) || `请求失败 (${r.status})`);
    if (method === 'GET' && !opts.noCache) cachePut(path, opts.query, r.data);
    return r.data;
  }
  const asset = (p) => { try { return Host.asset(p); } catch { return p; } };
  const coverUrl = (c) => c && c.coverUrl ? asset(c.coverUrl) : (c && c.cover ? asset(c.cover) : '');

  /* 头像图片加载失败（旧缓存、文件缺失）时回退字母头像，避免整块空白。
     用捕获阶段监听：所有视图里动态生成的头像 img 都能覆盖到。 */
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el.tagName === 'IMG' && el.classList && el.classList.contains('avatar-mini')) {
      const span = document.createElement('span');
      span.className = 'avatar-mini letter';
      span.textContent = (state.user && state.user.name ? state.user.name : '?').slice(0, 1).toUpperCase();
      if (el.parentNode) el.parentNode.replaceChild(span, el);
    }
  }, true);

  /* ------------------------------ 启动 ------------------------------ */
  async function boot() {
    $('#buildInfo').textContent = `v${Host.version} · 独立客户端`;
    /* 主题先在同步阶段套用缓存值：避免启动时先闪一下深色；宿主配置读不到时也不回退 */
    let cachedTheme = '';
    const THEME_IDS = ['dark', 'light', 'sea', 'forest', 'sunset', 'sakura'];
    try { cachedTheme = localStorage.getItem('cv-theme') || ''; } catch { /* 忽略 */ }
    if (THEME_IDS.includes(cachedTheme)) document.documentElement.dataset.theme = cachedTheme;
    try {
      const cfg = await Host.getConfig();
      state.server = cfg.server || '';
      state.mode = cfg.mode || 'local';
      state.theme = THEME_IDS.includes(cachedTheme) ? cachedTheme : (THEME_IDS.includes(cfg.theme) ? cfg.theme : 'dark');
      document.documentElement.dataset.theme = state.theme;
      try { localStorage.setItem('cv-theme', state.theme); } catch { /* 忽略 */ }
    } catch {
      state.theme = cachedTheme || 'dark';
      document.documentElement.dataset.theme = state.theme;
    }
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
         <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">
           <button class="btn sm ghost" data-action="edit-profile">编辑资料</button>
           <button class="btn sm ghost" data-action="upload-avatar">修改头像</button>
           <button class="btn sm ghost" data-action="logout">退出登录</button>
         </div>`
      : '<span>未登录 · 公共内容可浏览</span>';
  }
  /** 编辑个人资料：昵称 / 简介 / 密码，统一走 /api/me（POST 兼容所有宿主） */
  function openProfileEditor() {
    if (!state.user) return toast('请先登录', true);
    const u = state.user;
    openModal(`<h3>编辑个人资料</h3>
      <label class="field"><span>昵称</span><input class="input" id="pfName" maxlength="30" value="${esc(u.name || '')}" placeholder="显示名称" /></label>
      <label class="field"><span>个人简介</span><textarea class="textarea" id="pfBio" rows="3" maxlength="300" placeholder="写点什么介绍自己…">${esc(u.bio || '')}</textarea></label>
      <label class="field"><span>新密码（不改请留空）</span><input class="input" id="pfPwd" type="password" minlength="6" placeholder="至少 6 位" /></label>
      <p class="muted" style="font-size:11px;margin:6px 0 0">邮箱暂不支持自助修改。修改密码后当前登录保持有效。</p>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="profile-save">保存资料</button>
      </div>`);
    setTimeout(() => { const el = $('#pfName'); if (el) el.focus(); }, 30);
  }
  async function saveProfile() {
    const name = String($('#pfName')?.value || '').trim();
    const bio = String($('#pfBio')?.value || '').trim();
    const pwd = String($('#pfPwd')?.value || '');
    if (!name) return toast('昵称不能为空', true);
    if (pwd && pwd.length < 6) return toast('密码至少 6 位', true);
    const body = { name, bio };
    if (pwd) body.password = pwd;
    busy(true, '保存中…');
    try {
      const r = await api('POST', '/api/me', { body });
      if (r && r.user) state.user = { ...state.user, ...r.user };
      closeModal();
      await refreshStatus();
      if (state.view === 'settings') await renderSettings(); else render();
      toast('个人资料已保存');
    } catch (err) { toast(err.message, true); } finally { busy(false); }
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
  /** 圆形头像裁剪：拖动取景 + 缩放，输出 320×320 压缩 JPEG */
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
      // 先铺满整张画布：输出改为 JPEG 后圆外区域不会变成黑块
      ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, 320, 320);
      ctx.save();
      ctx.beginPath(); ctx.arc(160, 160, 160, 0, Math.PI * 2); ctx.clip();
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
      // 压缩 JPEG：体积小一个数量级，上传与加载都更快
      const out = cv.toDataURL('image/jpeg', 0.9);
      closeModal();
      // 先把顶部头像换成本地裁剪结果，不等网络；上传成功后 refreshStatus 会换成正式地址
      const mini = $('#userBox img.avatar-mini');
      if (mini) mini.src = out;
      const tmp = await Host.saveTempImage(out, 'avatar');
      if (!tmp) return toast('裁剪保存失败', true);
      busy(true, '上传头像…');
      try {
        await api('POST', '/api/me/avatar', { files: [{ path: tmp, name: 'avatar.jpg', field: 'file' }] });
        await refreshStatus();
        toast('头像已更新');
      } catch (err) { toast(err.message, true); await refreshStatus(); } finally { busy(false); }
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
    renderImportTask();
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
        <select class="select" id="srcSel" style="max-width:200px">${opts}</select>
        <button class="btn sm ${state.srcMode === 'discover' ? 'primary' : ''}" data-action="src-mode" data-mode="discover">发现</button>
        <button class="btn sm ${state.srcMode === 'search' ? 'primary' : ''}" data-action="src-mode" data-mode="search">搜索</button>
        <button class="btn sm" data-action="src-account" title="给需要登录的站点设置 Cookie">站点账号</button>
        <input class="input" id="srcKw" placeholder="输入漫画名搜索…" value="${esc(state.srcKw)}" style="flex:1;min-width:140px;${state.srcMode === 'discover' ? 'display:none' : ''}" />
        <button class="btn primary" data-action="src-search" style="${state.srcMode === 'discover' ? 'display:none' : ''}">搜索</button>
      </div>
      <div id="srcTabs" class="panel row" style="gap:6px;flex-wrap:wrap;margin-top:8px"></div>
      <div id="srcOut"></div>
      <div id="srcPager" class="row" style="gap:8px;justify-content:center;margin:12px 0"></div>`;
    $('#srcSel').addEventListener('change', (e) => {
      state.sourceId = e.target.value; state.srcTab = 0; state.srcPage = 1;
      if (state.srcMode === 'discover') srcDiscover();
    });
    $('#srcKw').addEventListener('keydown', (e) => { if (e.key === 'Enter') srcSearch(); });
    /* 进入来源页默认加载发现页（漫画不再"必须搜索才有"） */
    if (state.srcMode === 'discover') srcDiscover(); else renderSrcResults();
  }
  function renderSrcTabs() {
    const box = $('#srcTabs');
    if (!box) return;
    if (state.srcMode !== 'discover' || !state.srcTabs.length) { box.innerHTML = ''; return; }
    box.innerHTML = state.srcTabs.map((t) =>
      `<button class="chip ${t.index === state.srcTab ? 'active' : ''}" data-action="src-tab" data-tab="${t.index}">${esc(t.title)}</button>`).join('');
  }
  function renderSrcResults() {
    const out = $('#srcOut');
    if (!out) return;
    out.innerHTML = state.srcResults.length
      ? `<div class="grid">${state.srcResults.map((r, i) => `
        <div class="card" data-action="src-open" data-i="${i}">
          <div class="cover">${r.cover ? `<img src="${esc(r.cover)}" referrerpolicy="no-referrer" />` : '🌐'}</div>
          <div class="card-body"><div class="card-title">${esc(r.title)}</div></div></div>`).join('')}</div>`
      : `<div class="empty">${state.srcMode === 'discover'
          ? (state.srcDiscoverError
              ? `发现页加载失败：${esc(state.srcDiscoverError)}　<button class="btn sm" data-action="src-retry">重试</button>　也可切到「搜索」`
              : '这个书源没有发现页内容，试试「搜索」')
          : '输入关键词搜索，结果会显示在这里'}</div>`;
    /* 发现页分页 */
    const pager = $('#srcPager');
    if (pager) {
      if (state.srcMode === 'discover' && state.srcMaxPage > 1) {
        pager.innerHTML = `<button class="btn sm" data-action="src-page" data-d="-1" ${state.srcPage <= 1 ? 'disabled' : ''}>← 上一页</button>
          <span class="muted">第 ${state.srcPage} / ${state.srcMaxPage} 页</span>
          <button class="btn sm" data-action="src-page" data-d="1" ${state.srcPage >= state.srcMaxPage ? 'disabled' : ''}>下一页 →</button>`;
      } else pager.innerHTML = '';
    }
    renderSrcTabs();
  }
  function setSrcMode(mode) {
    state.srcMode = mode;
    if (mode === 'search') {
      $$('[data-action="src-mode"]').forEach((b) => b.classList.toggle('primary', b.dataset.mode === 'search'));
      const kw = $('#srcKw'); if (kw) kw.style.display = '';
      const sb = $('[data-action="src-search"]'); if (sb) sb.style.display = '';
      state.srcResults = []; renderSrcResults();
    } else srcDiscover();
    $$('[data-action="src-mode"]').forEach((b) => b.classList.toggle('primary', b.dataset.mode === mode));
    if (mode === 'discover') { const kw = $('#srcKw'); if (kw) kw.style.display = 'none'; const sb = $('[data-action="src-search"]'); if (sb) sb.style.display = 'none'; }
  }
  async function srcDiscover() {
    if (!state.sourceId) return;
    busy(true, '加载发现页…');
    try {
      const r = await api('GET', `/api/sources/${state.sourceId}/discover`, {
        query: { tab: state.srcTab, page: state.srcPage },
      });
      state.srcTabs = r.tabs || [];
      state.srcTab = r.tab ?? state.srcTab;
      state.srcMaxPage = r.maxPage || 1;
      state.srcResults = r.items || [];
      state.srcDiscoverError = '';
      renderSrcResults();
    } catch (err) {
      state.srcResults = [];
      state.srcDiscoverError = err?.message || '发现页加载失败';
      renderSrcResults();
    }
    finally { busy(false); }
  }
  async function srcSearch() {
    const kw = $('#srcKw')?.value.trim();
    if (!kw) return toast('请输入搜索关键词', true);
    state.srcKw = kw;
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
      <span id="busyLabel" class="muted" style="font-size:12px;display:block;margin-top:6px;color:var(--accent)"></span>`, true);
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
    // 轮询后端图片级进度：显示「第 N 话 · 第 x/y 张」，不再卡住不动
    let progAlive = true;
    (async () => {
      while (progAlive) {
        try {
          const pg = await api('GET', '/api/sources/import/progress');
          if (pg && !pg.idle && pg.imageTotal) {
            const el = $('#busyLabel');
            if (el) el.textContent = `第 ${failed + doneDone + 1}/${picked.length} 话 · ${pg.chapterTitle || ''} ${pg.imageDone}/${pg.imageTotal} 张`;
          }
        } catch { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
    let doneDone = 0;
    // 续导：同一本书（来源+书名）上次导入建的书 id 存在本地，中断后重新导入直接续，不再另建一本
    const resumeKey = 'cv_resume_' + state.sourceId + '_' + encodeURIComponent(sc.title).slice(0, 60);
    let comicId = '';
    try { comicId = localStorage.getItem(resumeKey) || ''; } catch { /* 忽略 */ }
    let failed = 0;
    state.importTask = { active: true, done: 0, total: picked.length, failed: 0, label: `正在导入 ${sc.title}`, comicId: '', finished: false };
    saveImportTask(); renderImportTask();
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
        if (!comicId && r.comicId) {
          comicId = r.comicId;
          try { localStorage.setItem(resumeKey, comicId); } catch { /* 忽略 */ }
        }
        doneDone++;
        state.importTask.done = doneDone;
        state.importTask.failed = failed;
        state.importTask.label = `正在导入 ${sc.title} · ${k + 1}/${picked.length} 话`;
        saveImportTask(); renderImportTask();
      } catch { failed++; }
    }
    progAlive = false;
    closeModal();
    state.importTask = { active: false, done: picked.length - failed, total: picked.length, failed, label: '', comicId, finished: true };
    saveImportTask(); renderImportTask();
    toast(`导入完成：成功 ${picked.length - failed} 话${failed ? `，失败 ${failed} 话` : ''}`);
  }
  /** 站点账号：给需要登录的书源（拷贝/热辣/vomic 等）粘贴登录后的 Cookie */
  async function srcAccount() {
    const sid = state.sourceId;
    const src = state.sourcesList.find((s) => s.id === sid);
    let info = {};
    try { info = await api('GET', `/api/sources/${encodeURIComponent(sid)}/cookies`); } catch { /* 忽略 */ }
    openModal(`<h3>站点账号 · ${esc(src?.name || '书源')}</h3>
      <p class="muted" style="font-size:12px;margin:6px 0 10px;line-height:1.7">
        部分站点（拷贝漫画、热辣漫画、vomic 等）看详情/图片需要登录。<br>
        在浏览器登录该站点后，打开开发者工具 → Network → 任选一个请求 → 复制请求头里的 <b>Cookie</b>，粘贴到下面保存即可。<br>
        保存后本软件访问该源会自动带上登录态。Cookie 只存在你的服务端，不会上传第三方。
      </p>
      <label class="field"><span>Cookie（留空并保存 = 清除登录）</span>
        <textarea class="textarea" id="srcCookie" rows="4" style="font-family:monospace;font-size:11px" placeholder="key1=value1; key2=value2">${esc(info?.cookie || '')}</textarea></label>
      <div class="modal-actions"><button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="src-account-save">保存登录态</button></div>`, true);
  }
  async function srcAccountSave() {
    const cookies = $('#srcCookie')?.value || '';
    busy(true, '保存中…');
    try {
      const r = await api('POST', `/api/sources/${encodeURIComponent(state.sourceId)}/cookies`, { body: { cookies } });
      closeModal();
      toast(r?.cleared ? '已清除该站点登录态' : `已保存登录态（${r?.count || 0} 项）`);
    } catch (err) { toast(err.message || '保存失败', true); }
    finally { busy(false); }
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
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="btn primary" data-action="import-into-current">＋ 导入页面到本书（可多选 / 排序）</button>
        <button class="btn" data-action="edit-comic">✎ 编辑漫画信息</button>
        <button class="btn" data-action="add-chapter">＋ 新建一话</button>
        <button class="btn" data-action="add-pages" data-id="${esc(chapters[0]?.id || '')}">↑ 追加页面到第一话（可排序）</button>
        <button class="btn" data-action="merge-chapters" ${chapters.length > 1 ? '' : 'hidden'} title="把连续几话按顺序合并成一话（小说拼正文 / 漫画拼页面）">⇒ 合并章节</button>
        <button class="btn" data-action="undo-merge" id="undoMergeBtn" hidden title="恢复到最近一次合并前">↶ 撤销合并</button>
        <button class="btn" data-action="clean-empty" title="删除导入失败留下的 0 页空话">清理空章</button>
        <span class="spacer"></span>
        <button class="btn primary" data-action="share-comic">↗ 分享链接 / 二维码</button>
        <button class="btn" data-action="export-comic">⇩ 下载 / 导出（分话）</button>
      </div></div>
      ${chapters.length ? `<table class="table"><thead><tr><th style="width:52px">#</th><th>话标题</th><th style="width:70px">页数</th><th style="width:340px">操作</th></tr></thead><tbody>
        ${chapters.map((ch, i) => `<tr class="${pg && pg.chapterId === ch.id ? 'reading' : ''}">
          <td>${pg && pg.chapterId === ch.id ? '<span class="badge">读</span>' : i + 1}</td>
          <td>${esc(ch.title)}${pg && pg.chapterId === ch.id ? ` <span class="muted" style="font-size:11px">· 第 ${(pg.pageIndex || 0) + 1} 页</span>` : ''}</td>
          <td>${(ch.pages || []).length}</td>
          <td class="ch-ops">
            <button class="btn sm" data-action="read-chapter" data-id="${esc(ch.id)}">阅读</button>
            <button class="btn sm" data-action="rename-chapter" data-id="${esc(ch.id)}">重命名</button>
            <button class="btn sm" data-action="manage-pages" data-id="${esc(ch.id)}" title="查看 / 排序 / 删除这一话的页面">页面</button>
            <button class="btn sm icon" data-action="move-chapter" data-id="${esc(ch.id)}" data-dir="-1" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm icon" data-action="move-chapter" data-id="${esc(ch.id)}" data-dir="1" title="下移" ${i === chapters.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn sm" data-action="add-pages" data-id="${esc(ch.id)}">加页</button>
            <button class="btn sm" data-action="export-chapter" data-id="${esc(ch.id)}" title="只下载这一话">⇩ 本话</button>
            <button class="btn sm danger" data-action="del-chapter" data-id="${esc(ch.id)}">删除</button>
          </td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有话，点「新建一话」开始</div>'}`;
    // 「撤销合并」按钮：有可撤销记录才显示（失败不影响主界面）
    api('GET', `/api/comics/${id}/chapters/merge/undo/status`).then((st) => {
      const b = $('#undoMergeBtn'); if (b) b.hidden = !st.canUndo;
    }).catch(() => {});
  }
  /* ------------------------------ 漫画整本编辑 ------------------------------ */
  function openComicEditor(c) {
    state.comicCoverPick = null;
    const cover = coverUrl(c);
    openModal(`<h3>编辑漫画信息</h3>
      <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <div id="ceCoverBox">${cover ? `<img src="${esc(cover)}" style="width:72px;height:100px;object-fit:cover;border-radius:8px" />` : '<div style="width:72px;height:100px;border-radius:8px;display:grid;place-items:center;background:var(--panel-2,#1b2130);font-size:28px">📖</div>'}</div>
        <div style="flex:1;min-width:160px">
          <button class="btn sm" data-action="pick-comic-cover">＋ 更换封面</button>
          <p class="muted" style="font-size:11px;margin:6px 0 0" id="ceCoverHint">支持 JPG / PNG / WebP；不更换请留空</p>
        </div>
      </div>
      <label class="field"><span>漫画标题</span><input class="input" id="ceTitle" value="${esc(c.title || '')}" /></label>
      <label class="field"><span>作者</span><input class="input" id="ceAuthor" value="${esc(c.author || '')}" /></label>
      <label class="field"><span>简介</span><textarea class="textarea" id="ceDesc" rows="4" placeholder="写点内容介绍…">${esc(c.description || '')}</textarea></label>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="save-comic">保存</button>
      </div>`);
  }
  /* ------------------------------ 分享（与网站同一套接口） ------------------------------ */
  /** 重新拉取详情并刷新分享面板，保证 token / 设置是服务端最新值 */
  async function reloadShare() {
    try { state.comicData = await api('GET', `/api/comics/${state.comic}`); } catch { /* 用旧数据 */ }
    await openShare();
  }
  async function openShare() {
    const c = state.comicData;
    if (!c) return;
    /* 内置兜底：宿主没提供 cv:share-config（旧客户端 / 升级途中）也能生成完整链接。
       历史 bug：cfg.landing 为空时 mainLink 只剩裸 token，界面上就是「一串乱排字母」。 */
    const cfg = {
      landing: `${FALLBACK_SERVER}/comic-vault/?s=`,
      backup: `${FALLBACK_PUBLIC_SITE}?s=`,
      credential: FALLBACK_SHARECODE,
    };
    try {
      const remote = Host.shareConfig ? await Host.shareConfig() : null;
      if (remote && /^https?:\/\//i.test(String(remote.landing || ''))) {
        cfg.landing = remote.landing;
        if (/^https?:\/\//i.test(String(remote.backup || ''))) cfg.backup = remote.backup;
        if (remote.credential) cfg.credential = remote.credential;
      }
    } catch { /* 用内置兜底 */ }
    /** 落地页前缀必须完整、且以 ?s= 结尾，保证拼出来是别人能打开的 URL */
    const landingPrefix = (raw) => {
      const l = /^https?:\/\//i.test(String(raw || ''))
        ? String(raw) : `${FALLBACK_SERVER}/comic-vault/?s=`;
      return /[?&]s=$/.test(l)
        ? l : `${l.replace(/[?&]+$/, '')}${l.includes('?') ? '&' : '?'}s=`;
    };
    const sh = c.share || {};
    const token = sh.token || '';
    const enabled = !!sh.enabled;
    const chapters = c.chapters || [];
    const sel = new Set(sh.chapterIds || []);
    const expireDays = sh.expiresAt ? Math.max(0, Math.ceil((sh.expiresAt - Date.now()) / 86400000)) : 0;
    const cred = `&sharecode=${encodeURIComponent(cfg.credential)}`;
    const mainLink = token ? `${landingPrefix(cfg.landing)}${encodeURIComponent(token)}${cred}` : '';
    const backupLink = token ? `${landingPrefix(cfg.backup)}${encodeURIComponent(token)}${cred}` : '';
    const linkRow = (label, url, id) => url ? `<label class="field"><span>${label}</span>
      <div class="share-link"><input class="input" id="${id}" readonly value="${esc(url)}" />
        <button class="btn sm" data-copy="${id}" type="button">复制</button>
        <button class="btn sm" data-open="${id}" type="button">打开</button></div></label>` : '';

    openModal(`<h3>分享《${esc(c.title)}》</h3>
      ${!token ? `<div class="empty" style="padding:16px 0">
          <p class="muted" style="font-size:12px">生成后，别人点链接或扫二维码就能直接在线观看、下载，不需要登录。</p>
          <button class="btn primary" id="shCreate" type="button">生成分享链接与二维码</button></div>` : `
      <div class="share-panel">
        <div class="share-qr" id="shareQrBox">
          <img id="shareQr" alt="分享二维码" />
          <div class="muted" style="font-size:11px;text-align:center">扫码直接打开</div>
          <button id="shareQrDl" class="btn sm" type="button">保存二维码</button>
          <div class="row" style="gap:6px;justify-content:center;flex-wrap:wrap">
            <select id="qrSizeSel" class="select sm" title="导出尺寸">
              <option value="512">标准 512px</option>
              <option value="1024">高清 1024px</option>
              <option value="256">轻量 256px</option>
            </select>
            <select id="qrFmtSel" class="select sm" title="导出格式（平台限制图片大小时选 JPG 轻量）">
              <option value="png">PNG 无损</option>
              <option value="jpg-high">JPG 高清</option>
              <option value="jpg-small">JPG 轻量</option>
            </select>
          </div>
        </div>
        <div class="share-main">
          ${linkRow('主链接 · 可直接打开（推荐）', mainLink, 'shMain')}
          ${linkRow('备用链接 · GitHub 静态入口', backupLink, 'shBackup')}
          <div class="row" style="margin-top:8px;flex-wrap:wrap">
            <button class="btn" id="shPreview" type="button">预览链接</button>
            <button class="btn" id="shRotate" type="button">刷新链接（旧链接立即失效）</button>
          </div>
          <p class="muted" style="font-size:11px;margin:8px 0 0;line-height:1.7">${enabled ? '分享已开启' : '<b style="color:var(--warn)">分享已关闭，别人暂时打不开</b>'}。链接里的 <b>sharecode</b> 是服务器访问凭据，请勿删除；${sh.allowDownload !== false ? '对方可下载 CBZ' : '下载已关闭'}。<br><code>?s=</code> 后面那串字符是分享令牌（不是乱码），请<b>整条复制</b>发送，不要删改；点「打开」可先自己验证能不能看。</p>
        </div>
      </div>
      <div class="panel" style="margin-top:12px"><h3>分享设置</h3>
        <div class="field-row">
          <label class="chk"><input type="checkbox" id="shEnabled" ${enabled ? 'checked' : ''} /> 启用分享</label>
          <label class="chk"><input type="checkbox" id="shDownload" ${sh.allowDownload !== false ? 'checked' : ''} /> 允许下载</label>
        </div>
        <div class="field-row">
          <label class="field"><span>访问密码（留空不设）</span>
            <input class="input" id="shPwd" type="text" placeholder="${sh.passwordHash ? '已设置，留空则保持不变' : '不设密码'}" /></label>
          <label class="field"><span>有效期（天，0 = 永久）</span>
            <input class="input" id="shExpire" type="number" min="0" max="365" value="${expireDays}" /></label>
        </div>
        ${chapters.length ? `<label class="field"><span>按话分享（不勾 = 分享整本）</span>
          <div id="shChapters" class="share-chapters">${chapters.map((ch, i) => `<label class="chk"><input type="checkbox" value="${esc(ch.id)}" ${sel.has(ch.id) ? 'checked' : ''} /> 第 ${i + 1} 话 · ${esc(ch.title)}</label>`).join('')}</div></label>` : ''}
        <div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button>
          <button class="btn primary" id="shSave" type="button">保存设置</button></div>
      </div>`}
    `, true);

    /* 离线生成二维码：PNG 优先，失败退回纯矩阵 SVG（不依赖 canvas / 不请求外部服务）。
       任何一步失败都在面板里显示可见提示，绝不留一张空白图让用户以为「二维码没做」。 */
    const QR = window.QRCode && (window.QRCode.create ? window.QRCode : window.QRCode.default);
    function qrSvgDataUrl(qr) {
      const n = qr.modules.size, d = qr.modules.data, quiet = 2, cell = 8;
      const dim = (n + quiet * 2) * cell;
      let rects = `<rect width="${dim}" height="${dim}" fill="#ffffff"/>`;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (d[r * n + c]) rects += `<rect x="${(c + quiet) * cell}" y="${(r + quiet) * cell}" width="${cell}" height="${cell}" fill="#241a45"/>`;
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">${rects}</svg>`;
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
    if (token && mainLink) {
      let pic = '', ext = 'png';
      if (QR && typeof QR.toDataURL === 'function') {
        try {
          pic = await QR.toDataURL(mainLink, { width: 240, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#241a45', light: '#ffffff' } });
        } catch { /* 试下一种 */ }
      }
      if (!pic && QR && typeof QR.toString === 'function') {
        try {
          pic = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            await QR.toString(mainLink, { type: 'svg', width: 240, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#241a45', light: '#ffffff' } }));
          ext = 'svg';
        } catch { /* 试下一种 */ }
      }
      if (!pic && QR && typeof QR.create === 'function') {
        try { pic = qrSvgDataUrl(QR.create(mainLink, { errorCorrectionLevel: 'M' })); ext = 'svg'; } catch { /* 忽略 */ }
      }
      const img = $('#shareQr'), dl = $('#shareQrDl'), box = $('#shareQrBox');
      if (pic) {
        if (img) { img.src = pic; img.style.display = ''; }
        if (dl) { dl.href = pic; dl.setAttribute('download', `ComicVault-分享二维码.${ext}`); dl.style.display = ''; }
        if (img) img.onerror = () => { if (box) box.innerHTML = '<div class="muted" style="font-size:12px;line-height:1.7;padding:12px;text-align:center">二维码图片加载失败<br>请直接复制上方链接发送</div>'; };
      } else if (box) {
        box.innerHTML = '<div class="muted" style="font-size:12px;line-height:1.7;padding:12px;text-align:center">二维码生成失败<br>请直接复制上方链接发送</div>';
      }
    }
    $$('#modal [data-copy]').forEach((b) => {
      b.onclick = async () => {
        const text = $('#' + b.dataset.copy)?.value || '';
        if (!text) return;
        try { await Host.copyText(text); toast('链接已复制'); }
        catch { try { await navigator.clipboard.writeText(text); toast('链接已复制'); } catch { toast('复制失败，请手动选择复制', true); } }
      };
    });
    $$('#modal [data-open]').forEach((b) => {
      b.onclick = () => {
        const url = $('#' + b.dataset.open)?.value || '';
        if (!/^https?:\/\//i.test(url)) return toast('链接无效，请刷新后重试', true);
        if (Host.openExternal) Host.openExternal(url);
        else window.open(url, '_blank', 'noopener');
      };
    });
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

    /* 按所选尺寸 / 格式重新生成导出二维码。
       可识别性保证：2 模块静区、纠错 M（25% 容错）、JPG 质量不低于 0.82。 */
    async function qrExportDataUrl(size, format) {
      const jpeg = format !== 'png';
      if (QR && typeof QR.toDataURL === 'function') {
        try {
          return await QR.toDataURL(mainLink, {
            width: size,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#241a45', light: '#ffffff' },
            type: jpeg ? 'image/jpeg' : 'image/png',
            rendererOpts: { quality: format === 'jpg-small' ? 0.82 : 0.92 },
          });
        } catch { /* 退回 canvas 转换 */ }
      }
      const pic = $('#shareQr')?.src || '';
      if (!pic) return '';
      try {
        const image = new Image();
        image.src = pic;
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(image, 0, 0, size, size);
        return jpeg ? cv.toDataURL('image/jpeg', format === 'jpg-small' ? 0.82 : 0.92) : cv.toDataURL('image/png');
      } catch { return ''; }
    }
    bind('#shareQrDl', async () => {
      const size = Number($('#qrSizeSel')?.value || 512) || 512;
      const format = $('#qrFmtSel')?.value || 'png';
      let pic = '';
      try { pic = await qrExportDataUrl(size, format); } catch { /* 下面统一提示 */ }
      if (!pic) return toast('二维码还没生成好，请稍后再试或升级客户端', true);
      const ext = format === 'png' ? 'png' : 'jpg';
      const name = `ComicVault-分享二维码-${size}px.${ext}`;
      if (Host.saveImage) {
        try {
          const r = await Host.saveImage(pic, name.replace(/\.[^.]+$/, ''));
          if (r && r.ok) return toast(`已保存：${r.path || '图片'}`);
          if (r && r.canceled) return;
          if (r && !r.unsupported) return toast(r.error || '保存失败', true);
        } catch (err) { return toast('保存失败：' + err.message, true); }
      }
      if (!isMobile) {
        const a = document.createElement('a');
        a.href = pic;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('已触发下载；若仍没反应请升级客户端');
      } else {
        toast('当前客户端版本暂不支持保存二维码，请升级到新版本', true);
      }
    });
    bind('#shCreate', async () => {
      busy(true, '生成中…');
      try {
        await api('POST', `/api/comics/${state.comic}/share`, { body: { enabled: true, allowDownload: true } });
        await reloadShare();
        toast('分享链接已生成');
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    });
    bind('#shPreview', () => { if (mainLink && Host.openExternal) Host.openExternal(mainLink); });
    bind('#shRotate', async () => {
      if (!confirm('重新生成链接后，之前发出去的旧链接会立即失效，确定吗？')) return;
      try { await api('POST', `/api/comics/${state.comic}/share/rotate`, { body: {} }); await reloadShare(); toast('链接已刷新'); }
      catch (err) { toast(err.message, true); }
    });
    bind('#shSave', async () => {
      const pwd = $('#shPwd')?.value.trim() || '';
      const body = {
        enabled: !!$('#shEnabled')?.checked,
        allowDownload: !!$('#shDownload')?.checked,
        expiresInDays: Number($('#shExpire')?.value) || 0,
        chapterIds: $$('#shChapters input:checked').map((x) => x.value),
      };
      // 输入了新密码就更新；没输入且原本没密码则明确清空；原本有密码则保持不变
      if (pwd) body.password = pwd;
      else if (!sh.passwordHash) body.password = '';
      busy(true, '保存中…');
      try {
        await api('POST', `/api/comics/${state.comic}/share`, { body });
        await reloadShare();
        toast('分享设置已保存');
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    });
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
  async function exportCbz(chapterIds) {
    const c = state.comicData;
    if (!c) return;
    const ids = Array.isArray(chapterIds) ? chapterIds.filter(Boolean)
      : (chapterIds ? [chapterIds] : []);
    const q = ids.length ? `&chapters=${encodeURIComponent(ids.join(','))}` : '';
    const picked = (c.chapters || []).filter((x) => ids.includes(x.id));
    const suffix = picked.length === 1 ? `·${picked[0].title}` : ids.length > 1 ? `·${ids.length}话` : '';
    const name = `${c.title}${suffix}.cbz`.replace(/[\\/:*?"<>|]/g, '_');
    if (!Host.saveApiFile) return toast('这个客户端版本暂不支持导出，请升级', true);
    const r = await Host.saveApiFile(`/api/export/${c.id}?format=cbz${q}`, name);
    if (r && r.ok) toast(`已保存：${r.path}`);
    else if (r && !r.canceled) toast(r.error || '导出失败', true);
  }

  /** 下载范围：整本 / 单话 / 多话（勾选），与网站分享页保持一致 */
  function openExportDialog() {
    const c = state.comicData;
    if (!c) return;
    const chs = c.chapters || [];
    openModal(`<h3>下载《${esc(c.title)}》</h3>
      <p class="muted" style="font-size:12px;line-height:1.7;margin:0 0 12px">
        可选整本、单独一话，或自己勾选多话一起打包成一个 CBZ（按话分目录）。</p>
      <div class="field-row">
        <label class="chk"><input type="radio" name="expScope" value="all" checked /> 整本（${chs.length} 话）</label>
        <label class="chk"><input type="radio" name="expScope" value="single" /> 单话</label>
        <label class="chk"><input type="radio" name="expScope" value="multi" /> 多话（勾选）</label>
      </div>
      <div id="expSingleWrap" style="display:none;margin-top:10px">
        <label class="field"><span>选择要下载的那一话</span>
          <select class="input" id="expSingle">${chs.map((ch, i) =>
            `<option value="${esc(ch.id)}">第 ${i + 1} 话 · ${esc(ch.title)}（${(ch.pages || []).length} 页）</option>`).join('')}</select></label>
      </div>
      <div id="expMultiWrap" style="display:none;margin-top:10px;max-height:230px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
        ${chs.map((ch, i) => `<label class="chk" style="display:block;margin:4px 0"><input type="checkbox" class="expCh" value="${esc(ch.id)}" /> 第 ${i + 1} 话 · ${esc(ch.title)}（${(ch.pages || []).length} 页）</label>`).join('')}
        <div class="row" style="gap:6px;margin-top:8px">
          <button class="btn sm" id="expAll" type="button">全选</button>
          <button class="btn sm" id="expNone" type="button">清空</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" id="expGo" type="button">下载 CBZ</button>
      </div>`, true);
    const scope = () => $('#modal input[name="expScope"]:checked')?.value || 'all';
    const sync = () => {
      const s = scope(), a = $('#expSingleWrap'), b = $('#expMultiWrap');
      if (a) a.style.display = s === 'single' ? '' : 'none';
      if (b) b.style.display = s === 'multi' ? '' : 'none';
    };
    $$('#modal input[name="expScope"]').forEach((r) => { r.onchange = sync; });
    const b2 = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    b2('#expAll', () => $$('#modal .expCh').forEach((x) => { x.checked = true; }));
    b2('#expNone', () => $$('#modal .expCh').forEach((x) => { x.checked = false; }));
    b2('#expGo', async () => {
      const s = scope();
      let ids = [];
      if (s === 'single') { const v = $('#expSingle')?.value; if (v) ids = [v]; }
      else if (s === 'multi') ids = $$('#modal .expCh').filter((x) => x.checked).map((x) => x.value);
      if (s !== 'all' && !ids.length) return toast('请先选择要下载的话', true);
      closeModal();
      await exportCbz(ids);
    });
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
    /* 「加页」也走带勾选 / 拖拽 / ↑↓ / 倒序的排序网格，不再无脑直接上传 */
    await startImport(paths, { intoChapterId: chapterId });
  }

  /** 章节合并：按话号范围把连续几话合并进第一话（小说拼正文 / 漫画拼页面），可撤销 */
  async function mergeChaptersDialog() {
    const chs = state.comicData?.chapters || [];
    if (chs.length < 2) return toast('至少要有两话才能合并', true);
    const range = prompt(`把第几话到第几话合并成一话？填话号范围，例如 3-5（共 ${chs.length} 话）`, `1-${chs.length}`);
    if (!range) return;
    const m = range.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return toast('格式应为「起始话号-结束话号」，例如 3-5', true);
    let a = Math.max(1, Number(m[1])), b = Math.min(chs.length, Number(m[2]));
    if (a > b) [a, b] = [b, a];
    if (b - a + 1 < 2) return toast('至少要选两话', true);
    const ids = chs.slice(a - 1, b).map((x) => x.id);
    const title = prompt('合并后的标题（留空保留第一话标题）', chs[a - 1].title);
    if (title === null) return;
    if (!confirm(`将把第 ${a} 到 ${b} 话（共 ${ids.length} 话）按顺序合并进「${chs[a - 1].title}」，合并后可一键撤销。继续？`)) return;
    try {
      await api('POST', `/api/comics/${state.comic}/chapters/merge`, { body: { chapterIds: ids, title: title.trim() || undefined } });
      await renderComic();
      toast(`已合并 ${ids.length} 话`);
    } catch (err) { toast(err.message, true); }
  }
  /** 撤销最近一次章节合并：目录与内容恢复到合并前 */
  async function undoChapterMerge() {
    if (!confirm('撤销最近一次章节合并？目录与内容会恢复到合并前的状态。')) return;
    try {
      const res = await api('POST', `/api/comics/${state.comic}/chapters/merge/undo`);
      await renderComic();
      toast(res.ok ? '已撤销合并，目录已恢复' : '没有可撤销的合并');
    } catch (err) { toast(err.message, true); }
  }
  /** 清理导入失败留下的 0 页空话（有内容的章节不动） */
  async function cleanEmptyChapters() {
    if (!confirm('清理所有 0 页 / 无正文的空话？有内容的章节不会受影响。')) return;
    try {
      const res = await api('POST', `/api/comics/${state.comic}/clean-empty`);
      await renderComic();
      toast(res.removed ? `已清理 ${res.removed} 个空话` : '没有空话需要清理');
    } catch (err) { toast(err.message, true); }
  }

  /* ------------------------------ 页面管理（每话：查看 / 排序 / 删除） ------------------------------ */
  /** 打开某一话的页面管理网格：点格子勾选、↑↓ 或拖动调序（改动立即保存）、删除选中 */
  async function openPageManager(chapterId) {
    const c = state.comicData;
    const ch = (c?.chapters || []).find((x) => x.id === chapterId);
    if (!ch) return toast('找不到这一话', true);
    const pages = (ch.pages || []).slice();
    if (!pages.length) return toast('这一话还没有页面', true);
    state.pageMgr = { comicId: state.comic, chapterId, pages, sel: new Set(), title: ch.title };
    openModal(`<h3>页面管理 · ${esc(ch.title)} · ${pages.length} 页</h3>
      <div class="imp-tools"><span class="muted" id="pmCount"></span>
        <span class="spacer"></span>
        <button class="btn sm primary" id="pmAdd" type="button">＋ 继续加页</button>
        <button class="btn sm" id="pmUndo" type="button" disabled title="撤销上一次编辑">↶ 撤销<span id="pmUndoN"></span></button>
        <button class="btn sm" id="pmAll" type="button">全选</button>
        <button class="btn sm" id="pmNone" type="button">取消选择</button>
        <button class="btn sm" id="pmSort" type="button">按名称排序</button>
        <button class="btn sm" id="pmReverse" type="button">倒序</button>
        <button class="btn sm danger" id="pmDel" type="button">删除选中</button></div>
      <div class="imp-grid" id="pmGrid"></div>
      <p class="muted" style="font-size:11px;margin:10px 0 0">点格子勾选后「删除选中」；拖动格子或点 ↑↓ 调整页序，<b>每次调整立即保存</b>。误操作可点「撤销」恢复（含被删除的原图）。编号就是阅读时的页序。</p>
      <div class="modal-actions"><button class="btn primary" data-action="close-modal">完成</button></div>`, true);
    renderPageGrid();
    // 加载可撤销步数，驱动「撤销」按钮
    (async () => {
      try {
        const st = await api('GET', `/api/comics/${state.comic}/chapters/${chapterId}/undo/status`, { noCache: true });
        const btn = $('#pmUndo'); const n = $('#pmUndoN');
        if (btn && n) { btn.disabled = !st.canUndo; n.textContent = st.canUndo ? ` (${st.canUndo})` : ''; if (st.latest?.label) btn.title = `撤销上一步：${st.latest.label}`; }
      } catch { /* 忽略 */ }
    })();
    const addBtn = $('#pmAdd');
    if (addBtn) addBtn.onclick = async () => {
      let paths = [];
      try { paths = (Host.pickImport ? await Host.pickImport() : await Host.pickFiles()) || []; }
      catch { return toast('选择图片失败', true); }
      if (!paths || !paths.length) return;
      try { paths = await Host.resolvePaths(paths); } catch { /* 已是文件列表 */ }
      busy(true, `追加 ${paths.length} 页…`);
      try {
        const batch = paths.map((p) => ({ path: p, name: base(p), field: 'files' }));
        // 不传 index → 服务端默认追加到章节末尾，正是「继续加页」
        await api('POST', `/api/comics/${state.comic}/chapters/${chapterId}/pages`, { files: batch });
        const c = await api('GET', `/api/comics/${state.comic}`, { noCache: true });
        const fresh = (c.chapters || []).find((x) => x.id === chapterId);
        state.comicData = c;
        state.pageMgr.pages = (fresh?.pages || []).slice();
        renderPageGrid();
        toast(`已追加 ${paths.length} 页`);
        const u = $('#pmUndo'); if (u) u.disabled = false;
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    };
    const undoBtn = $('#pmUndo');
    if (undoBtn) undoBtn.onclick = async () => {
      busy(true, '撤销中…');
      try {
        const res = await api('POST', `/api/comics/${state.comic}/chapters/${chapterId}/undo`);
        const n = $('#pmUndoN'); const btn = $('#pmUndo');
        const fresh = (res.chapter || {}).pages || [];
        state.pageMgr.pages = fresh.slice();
        state.pageMgr.sel.clear();
        renderPageGrid();
        if (state.comicData) {
          const ch2 = (state.comicData.chapters || []).find((x) => x.id === chapterId);
          if (ch2) ch2.pages = fresh;
        }
        toast(`已撤销「${res.label || '上一步'}」${res.remaining ? `，还可撤销 ${res.remaining} 步` : ''}`);
        if (btn && n) { btn.disabled = !res.remaining; n.textContent = res.remaining ? ` (${res.remaining})` : ''; }
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    };
    $('#pmAll').onclick = () => { state.pageMgr.sel = new Set(state.pageMgr.pages.map((p) => p.id)); renderPageGrid(); };
    $('#pmNone').onclick = () => { state.pageMgr.sel.clear(); renderPageGrid(); };
    const enableUndo = () => { const u = $('#pmUndo'); if (u) u.disabled = false; };
    $('#pmSort').onclick = async () => {
      state.pageMgr.pages.sort((a, b) => String(a.name || a.file).localeCompare(String(b.name || b.file), 'zh-CN', { numeric: true }));
      await savePageOrder(); enableUndo();
    };
    $('#pmReverse').onclick = async () => { state.pageMgr.pages.reverse(); await savePageOrder(); enableUndo(); };
    $('#pmDel').onclick = async () => {
      const ids = state.pageMgr.pages.filter((p) => state.pageMgr.sel.has(p.id)).map((p) => p.id);
      if (!ids.length) return toast('请先勾选要删除的页面', true);
      if (!confirm(`确定删除选中的 ${ids.length} 页？此操作不可撤销。`)) return;
      busy(true, `正在删除 ${ids.length} 页…`);
      try {
        for (const pid of ids) {
          await api('DELETE', `/api/comics/${state.pageMgr.comicId}/chapters/${state.pageMgr.chapterId}/pages/${pid}`);
        }
        state.pageMgr.pages = state.pageMgr.pages.filter((p) => !state.pageMgr.sel.has(p.id));
        state.pageMgr.sel.clear();
        renderPageGrid();
        enableUndo();
        toast(`已删除 ${ids.length} 页`);
      } catch (err) { toast(err.message, true); } finally { busy(false); }
    };
    const grid = $('#pmGrid');
    grid.addEventListener('click', (e) => {
      const mv = e.target.closest('[data-pm-move]');
      if (mv) {
        e.preventDefault(); e.stopPropagation();
        const i = Number(mv.dataset.idx);
        const list = state.pageMgr.pages;
        const to = i + Number(mv.dataset.pmMove);
        if (i < 0 || to < 0 || i >= list.length || to >= list.length || i === to) return;
        const [moved] = list.splice(i, 1);
        list.splice(to, 0, moved);
        savePageOrder();
        return;
      }
      if (e.target.closest('input[type=checkbox]')) return;
      const cell = e.target.closest('.pm-cell');
      const box = cell?.querySelector('input[type=checkbox]');
      if (box) box.click();
    });
    grid.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      if (cb.checked) state.pageMgr.sel.add(cb.dataset.id); else state.pageMgr.sel.delete(cb.dataset.id);
      cb.closest('.pm-cell')?.classList.toggle('on', cb.checked);
      const el = $('#pmCount'); if (el) el.textContent = `已选 ${state.pageMgr.sel.size} 页`;
    });
    let dragFrom = -1;
    grid.addEventListener('dragstart', (e) => {
      const cell = e.target.closest('.pm-cell');
      if (!cell) return;
      dragFrom = Number(cell.dataset.idx);
      cell.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); } catch { /* 忽略 */ }
    });
    grid.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { /* 忽略 */ } });
    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      const cell = e.target.closest('.pm-cell');
      if (cell && dragFrom >= 0) {
        const list = state.pageMgr.pages;
        const to = Math.min(list.length - 1, Number(cell.dataset.idx));
        const [moved] = list.splice(dragFrom, 1);
        list.splice(to, 0, moved);
        savePageOrder();
      }
      dragFrom = -1;
    });
    grid.addEventListener('dragend', () => { $$('#pmGrid .pm-cell').forEach((x) => x.classList.remove('dragging')); dragFrom = -1; });
  }

  function renderPageGrid() {
    const grid = $('#pmGrid');
    if (!grid || !state.pageMgr) return;
    const list = state.pageMgr.pages;
    grid.innerHTML = list.map((p, i) => {
      const on = state.pageMgr.sel.has(p.id);
      const thumb = p.thumbUrl || p.url || '';
      return `<div class="imp-cell pm-cell ${on ? 'on' : ''}" data-idx="${i}" draggable="true" title="${esc(p.name || p.file || '')}">
        <input type="checkbox" data-id="${esc(p.id)}" ${on ? 'checked' : ''} />
        <span class="imp-thumb">${thumb ? `<img loading="lazy" src="${esc(asset(thumb))}" alt="" />` : ''}</span>
        <span class="imp-n">${i + 1}</span>
        <span class="imp-name">${esc(p.name || p.file || '')}</span>
        <span class="imp-ops">
          <button type="button" data-pm-move="-1" data-idx="${i}" title="前移一页" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-pm-move="1" data-idx="${i}" title="后移一页" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </div>`;
    }).join('');
    const el = $('#pmCount'); if (el) el.textContent = `已选 ${state.pageMgr.sel.size} 页`;
  }

  async function savePageOrder() {
    renderPageGrid();
    try {
      await api('PUT', `/api/comics/${state.pageMgr.comicId}/chapters/${state.pageMgr.chapterId}/pages/reorder`,
        { body: { order: state.pageMgr.pages.map((p) => p.id) } });
      const u = $('#pmUndo'); if (u) u.disabled = false;
    } catch (err) { toast(err.message, true); }
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
    if (el) {
      const news = (state.importPaths || []).filter((p) => !p.existing);
      el.textContent = `新选 ${state.importSel.size} / ${news.length} 个文件${(state.importExisting || []).length ? ` · 含已有 ${(state.importExisting || []).length} 页` : ''}`;
    }
  }
  function renderImportGrid() {
    const grid = $('#impGrid');
    if (!grid) return;
    const list = state.importPaths || [];
    grid.innerHTML = list.map((p, i) => {
      const key = keyOf(p), name = nameOf(p), on = state.importSel.has(key);
      if (p.existing) {
        return `<div class="imp-cell pm-cell exist" data-idx="${i}" draggable="true" title="${esc(name)}">
          <span class="imp-badge">已有</span>
          <span class="imp-thumb">${p.url ? `<img loading="lazy" src="${esc(asset(p.url))}" alt="" />` : ''}</span>
          <span class="imp-n">${i + 1}</span>
          <span class="imp-name">${esc(name)}</span>
          <span class="imp-ops">
            <button type="button" data-imp-move="-1" data-idx="${i}" title="前移一页" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" data-imp-move="1" data-idx="${i}" title="后移一页" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </div>`;
      }
      return `<div class="imp-cell ${on ? 'on' : ''}" data-idx="${i}" draggable="true" title="${esc(name)}">
        <input type="checkbox" data-key="${esc(key)}" ${on ? 'checked' : ''} />
        <span class="imp-thumb" data-thumb="${esc(key)}"><span class="imp-ext">${esc(extOf(name))}</span></span>
        <span class="imp-n">${i + 1}</span>
        <span class="imp-name">${esc(name)}</span>
        <span class="imp-ops">
          <button type="button" data-imp-move="-1" data-idx="${i}" title="前移一页" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-imp-move="1" data-idx="${i}" title="后移一页" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </div>`;
    }).join('');
    updateImportCount();
    if (Host.thumb) {
      $$('#impGrid .imp-thumb[data-thumb]').forEach((box) => {
        const key = box.dataset.thumb;
        Promise.resolve(Host.thumb(key)).then((u) => {
          if (u) box.innerHTML = `<img src="${esc(u)}" alt="" />`;
        }).catch(() => {});
      });
    }
  }
  /** 手动调序：拖动格子或点 ↑↓，编号即导入后的页序 */
  function moveImport(from, to) {
    const list = state.importPaths || [];
    if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    renderImportGrid();
  }
  /** PDF：在渲染进程用 pdf.js 逐页渲染成 PNG（与网站 ImportDialog 一致）。
   *  桌面内置服务不带原生 PDF 渲染模块，故 PDF 不走服务端，全部由 Chromium 渲染，
   *  转出的临时图片路径并入图片网格导入，页序由 0001 前缀保证。 */
  let pdfjsPromise = null;
  async function loadPdfjs() {
    if (!Host.pdfjsSource) return null;
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const src = await Host.pdfjsSource();
        if (!src || !src.lib || !src.worker) return null;
        const libUrl = URL.createObjectURL(new Blob([src.lib], { type: 'text/javascript' }));
        const wrkUrl = URL.createObjectURL(new Blob([src.worker], { type: 'text/javascript' }));
        const pdfjs = await import(libUrl);
        pdfjs.GlobalWorkerOptions.workerSrc = wrkUrl;
        return pdfjs;
      })().catch(() => null);
    }
    return pdfjsPromise;
  }
  async function pdfToImagePaths(pdfPath, onProgress) {
    const pdfjs = await loadPdfjs();
    if (!pdfjs || !Host.readFileBase64 || !Host.saveTempImage) return null;
    const b64 = await Host.readFileBase64(pdfPath);
    if (!b64) return null;
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const doc = await pdfjs.getDocument({ data: u8, isEvalSupported: false }).promise;
    const out = [], stem = base(pdfPath).replace(/\.pdf$/i, '');
    const pad = Math.max(4, String(doc.numPages).length);
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1.5 });
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.ceil(vp.width)); cv.height = Math.max(1, Math.ceil(vp.height));
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise;
        const hint = `${stem}-${String(i).padStart(pad, '0')}`;
        const tmp = await Host.saveTempImage(cv.toDataURL('image/png'), hint);
        if (tmp) out.push(tmp);
        page.cleanup();
        if (onProgress) onProgress(i, doc.numPages);
      }
    } finally { try { await doc.destroy(); } catch { /* 忽略 */ } }
    return out;
  }
  /** 统一导入入口：压缩包走服务端 7z 解压（和网站一样），PDF 本地渲染，图片走本地网格 */
  /** 归一化导入条目：桌面是磁盘路径字符串，Android 是 {id,name} 句柄。
   *  分类一律按显示名判断；上传时句柄带 id、磁盘文件带 path，宿主各自解析。 */
  function fileSpec(p, field = 'files') {
    if (typeof p === 'string') return { path: p, name: base(p), field };
    return { id: p.id, name: nameOf(p), field };
  }
  const FILE_NAME = (p) => nameOf(p);

  async function startImportFrom(rawPaths, opts = {}) {
    if (!rawPaths || !rawPaths.length) return;
    // 关键：不能按「是否字符串」过滤——Android 系统选择器返回的是 {id,name} 句柄，
    // 旧代码在这里把手机端选中的文件全部丢掉，导致「选完之后什么也不会发生」。
    let paths = rawPaths.slice();
    const PDF_RE = /\.pdf$/i;
    const NOVEL_RE = /\.(txt|text|md|markdown|epub)$/i;

    // 小说 TXT / 文字 EPUB：一次上传，服务端自动分章生成目录（旧版会只导入 EPUB 封面一页）。
    // 图片型 EPUB 服务端返回 kind:'image'，退回下面的压缩包导入流程。
    const novelPaths = paths.filter((p) => NOVEL_RE.test(FILE_NAME(p)));
    const imageEpubs = [];
    for (const p of novelPaths) {
      busy(true, `解析 ${FILE_NAME(p)}…`);
      try {
        const r = await api('POST', '/api/import/novel-file', { files: [fileSpec(p, 'file')] });
        if (r && r.kind === 'image') imageEpubs.push(p);
        else toast(`${FILE_NAME(p)} 已导入，章节目录自动生成`);
      } catch (err) { toast(`${FILE_NAME(p)} 导入失败：${err.message}`, true); }
      finally { busy(false); }
    }
    paths = paths.filter((p) => !novelPaths.includes(p));
    if (novelPaths.length) renderLibrary();

    // 与网站 ImportDialog 完全一致的支持格式（图片 / 各类压缩包 / EPUB / PDF）
    const archives = paths.filter((p) => /\.(zip|cbz|rar|cbr|cb7|7z|r\d{2}|tar|tgz|gz|bz2|xz|epub|ace|arj|lzh|lha|cab|iso)$/i.test(FILE_NAME(p)));
    const pdfs = paths.filter((p) => PDF_RE.test(FILE_NAME(p)) && !archives.includes(p));
    // PDF 只有磁盘路径才能本地渲染；Android 句柄直接交给服务端渲染
    const pdfHandles = pdfs.filter((p) => typeof p !== 'string');
    const pdfDisk = pdfs.filter((p) => typeof p === 'string');
    let images = paths.filter((p) => !novelPaths.includes(p) && !archives.includes(p) && !pdfs.includes(p));
    const failedPdfs = [];
    for (const p of pdfDisk) {
      try {
        busy(true, `渲染 ${FILE_NAME(p)}…`);
        const rendered = await pdfToImagePaths(p, (i, n) => busy(true, `渲染 ${FILE_NAME(p)}… ${i}/${n}`));
        if (rendered && rendered.length) images = images.concat(rendered);
        else failedPdfs.push(p);
      } catch (err) {
        failedPdfs.push(p);
      } finally { busy(false); }
    }
    // 渲染能力不可用（如手机端）或渲染失败的 PDF，回退交给服务端（服务端会给出明确指引）
    const archivesFinal = archives.concat(failedPdfs, imageEpubs, pdfHandles);
    if (images.length) await startImport(images, opts);
    if (archivesFinal.length) await importArchives(archivesFinal);
  }
  /** ZIP/CBZ/RAR/7Z/EPUB/PDF：交给服务端解压/渲染 → 按目录分话确认 → 落盘成章节。
   *  每个压缩包用自己独立的 sessionId 提交（旧版多包只保留最后一个 session，前面的会全丢），
   *  第一个包创建新漫画，后续包追加到同一本漫画的章节里。 */
  async function importArchives(paths) {
    if (!state.user) return toast('请先登录再导入', true);
    const packs = [];
    for (const p of paths) {
      const label = FILE_NAME(p);
      busy(true, `解析 ${label}…`);
      try {
        const r = await api('POST', '/api/import/archive', { files: [fileSpec(p, 'file')] });
        if (r.sessionId && (r.files || []).length) {
          packs.push({ path: p, label, sessionId: r.sessionId, files: r.files, meta: r.fields || {} });
        } else if (r.error) {
          toast(`${label}：${r.error}`, true);
        }
      } catch (err) { toast(`${label}：${err.message}`, true); }
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
        title: dir || k.label.replace(/\.[^.]+$/, '') || `第 ${i + 1} 话`,
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
          <span class="muted" style="font-size:11px;min-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.pack.label)}">${esc(row.pack.label)}</span>
          <input class="input" data-arc-gi="${row.idx}" value="${esc(row.g.title)}" />
          <span class="muted" style="font-size:11px;white-space:nowrap">${row.g.paths.length} 页</span></label>`).join('')}
      </div>
      <label class="field"><span>漫画标题</span><input class="input" id="arcTitle" value="${esc(meta.title || packs[0].label.replace(/\.[^.]+$/, ''))}" /></label>
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
  async function startImport(rawPaths, opts = {}) {
    if (!state.user) { state.view = 'library'; render(); return toast('请先登录再导入', true); }
    state.importIntoChapter = opts.intoChapterId || '';
    const intoChapter = !!state.importIntoChapter;
    let paths = rawPaths;
    try { paths = await Host.resolvePaths(rawPaths); } catch { /* 已是文件列表 */ }
    if (!paths || !paths.length) return toast('没有找到可用图片', true);
    paths = paths.slice();
    try { paths.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { numeric: true })); } catch { /* 忽略 */ }
    /* 「加页」模式：把这一话已有的页面也放进网格（标「已有」），新图片与它们混排，
       编号就是最终页序 —— 不再是只能把新图追加到末尾 */
    state.importExisting = [];
    if (intoChapter) {
      try {
        const c = await api('GET', `/api/comics/${state.comic}`);
        const ch = (c.chapters || []).find((x) => x.id === state.importIntoChapter);
        if (ch && (ch.pages || []).length) {
          state.importExisting = ch.pages.map((p) => ({
            existing: true, id: p.id, name: p.name || p.file || '', url: p.thumbUrl || p.url || '',
          }));
        }
      } catch { /* 读不到已有页面就退回纯新增模式 */ }
    }
    state.importPaths = [...(state.importExisting || []), ...paths];
    state.importSel = new Set(paths.map(keyOf));
    let comics = state.comics;
    try { comics = (await api('GET', '/api/comics')).comics || []; } catch { /* 忽略 */ }
    const options = comics.map((c) => `<option value="${esc(c.id)}"${opts.defaultComicId === c.id ? ' selected' : ''}>${esc(c.title)}</option>`).join('');
    const targetBlock = intoChapter
      ? `<label class="field"><span>导入到</span><div class="muted" style="font-size:12px">当前漫画的这一话 · 新图可与「已有」页面混排，编号就是最终页序</div></label>`
      : `<label class="field"><span>导入到</span>
          <select class="select" id="impTarget"><option value="__new__">＋ 新建一本漫画</option>${options}</select></label>
        <label class="field" id="impTitleRow"><span>漫画标题</span><input class="input" id="impTitle" value="${esc(nameOf(paths[0]).replace(/\.[^.]+$/, ''))}" /></label>
        <label class="field"><span>话标题</span><input class="input" id="impChapter" value="第 1 话" /></label>`;
    openModal(`<h3>${intoChapter ? '追加页面' : '导入漫画'} · 新选 ${paths.length} 个文件${(state.importExisting || []).length ? ` · 已有 ${(state.importExisting || []).length} 页` : ''}</h3>
      <div class="imp-tools"><span class="muted" id="impCount"></span>
        <span class="spacer"></span>
        <button class="btn sm primary" id="impAddMore" type="button">＋ 继续添加图片</button>
        <button class="btn sm" id="impAll" type="button">全选</button>
        <button class="btn sm" id="impInvert" type="button">反选</button>
        <button class="btn sm" id="impSort" type="button">按名称排序</button>
        <button class="btn sm" id="impReverse" type="button">倒序</button></div>
      <div class="imp-grid" id="impGrid"></div>
      <p class="muted" style="font-size:11px;margin:10px 0 0">一次可选多个文件；点格子勾选或取消，<b>拖动格子或点 ↑↓ 可手动调整页序</b>，编号就是导入后的页序。点「继续添加图片」可再选一批，新图片会追加到本列表一起排序、编号连续；手机端一次只能选一个时反复点即可。</p>
      ${targetBlock}
      <div class="modal-actions"><button class="btn" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="do-import">开始导入</button></div>
      <span id="busyLabel" class="muted" style="font-size:12px;display:block;margin-top:6px;color:var(--accent)"></span>`, true);
    renderImportGrid();
    const addMore = $('#impAddMore');
    if (addMore) addMore.onclick = async () => {
      let more = [];
      try { more = (Host.pickImport ? await Host.pickImport() : await Host.pickFiles()) || []; }
      catch { return toast('选择图片失败', true); }
      try { more = await Host.resolvePaths(more); } catch { /* 已是文件列表 */ }
      if (!more || !more.length) return;
      const before = (state.importPaths || []).length;
      state.importPaths = [...(state.importPaths || []), ...more];
      more.forEach((p) => state.importSel.add(keyOf(p)));
      renderImportGrid();
      toast(`已追加 ${state.importPaths.length - before} 张，与之前的图片一起排序`);
    };
    const targetSel = $('#impTarget');
    if (targetSel) {
      const syncTitle = () => {
        const row = $('#impTitleRow');
        if (row) row.style.display = targetSel.value === '__new__' ? '' : 'none';
      };
      targetSel.addEventListener('change', syncTitle);
      syncTitle();
    }
    const grid = $('#impGrid');
    grid.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      if (cb.checked) state.importSel.add(cb.dataset.key); else state.importSel.delete(cb.dataset.key);
      cb.closest('.imp-cell')?.classList.toggle('on', cb.checked);
      updateImportCount();
    });
    /* 点格子任意位置即可勾选；点 ↑↓ 只调顺序，不改勾选状态 */
    grid.addEventListener('click', (e) => {
      const mv = e.target.closest('[data-imp-move]');
      if (mv) {
        e.preventDefault(); e.stopPropagation();
        const i = Number(mv.dataset.idx);
        moveImport(i, i + Number(mv.dataset.impMove));
        return;
      }
      if (e.target.closest('input[type=checkbox]')) return;
      const cell = e.target.closest('.imp-cell');
      const box = cell?.querySelector('input[type=checkbox]');
      if (box) box.click();
    });
    let dragFrom = -1;
    grid.addEventListener('dragstart', (e) => {
      const cell = e.target.closest('.imp-cell');
      if (!cell) return;
      dragFrom = Number(cell.dataset.idx);
      cell.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); } catch { /* 忽略 */ }
    });
    grid.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { /* 忽略 */ } });
    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      const cell = e.target.closest('.imp-cell');
      if (cell && dragFrom >= 0) moveImport(dragFrom, Number(cell.dataset.idx));
      dragFrom = -1;
    });
    grid.addEventListener('dragend', () => {
      $$('#impGrid .imp-cell').forEach((c) => c.classList.remove('dragging'));
      dragFrom = -1;
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
    const paths = (state.importPaths || []).filter((p) => !p.existing && state.importSel.has(keyOf(p)));
    if (!paths.length) return toast('请至少勾选一个文件', true);
    const target = $('#impTarget')?.value || '__new__';
    let comicId = target, chapterId = '';
    busy(true, '准备中…');
    try {
      if (state.importIntoChapter) {
        /* 「加页」路径：追加到当前漫画的指定话，页序沿用排序网格的编号 */
        comicId = state.comic; chapterId = state.importIntoChapter;
      } else if (target === '__new__') {
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
      const plan = (state.importPaths || []).filter((p) => p.existing || state.importSel.has(keyOf(p)));
      closeModal();
      state.importIntoChapter = '';
      await uploadInto(comicId, chapterId, paths);
      /* 加页模式且网格里混有「已有」页面：按网格编号做最终页序，
         新上传的页面按文件名对号入座，插到用户拖好的位置 */
      if ((state.importExisting || []).length && plan.some((p) => p.existing)) {
        busy(true, '正在按排序整理页序…');
        const c = await api('GET', `/api/comics/${comicId}`);
        const ch = (c.chapters || []).find((x) => x.id === chapterId);
        const existIds = new Set(state.importExisting.map((p) => p.id));
        const nameMap = new Map();
        for (const p of (ch?.pages || [])) {
          if (!existIds.has(p.id)) {
            const k = p.name || p.file || '';
            if (!nameMap.has(k)) nameMap.set(k, []);
            nameMap.get(k).push(p);
          }
        }
        const order = [];
        let missing = 0;
        for (const item of plan) {
          if (item.existing) { order.push(item.id); continue; }
          const pool = nameMap.get(nameOf(item)) || [];
          const pg = pool.shift();
          if (pg) order.push(pg.id); else missing += 1;
        }
        // 漏匹配的页补到末尾，保证不丢页
        for (const p of (ch?.pages || [])) if (!order.includes(p.id)) order.push(p.id);
        if (order.length) {
          await api('PUT', `/api/comics/${comicId}/chapters/${chapterId}/pages/reorder`, { body: { order } });
        }
        if (missing) toast(`有 ${missing} 张新页因文件名对不上被排到了末尾`, true);
      }
      state.importPaths = null;
      state.importSel = new Set();
      state.importExisting = [];
      busy(false);
      state.view = 'comic'; state.comic = comicId; render();
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
    const annItem = (a) => `<div class="ann-item" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <b style="cursor:pointer;text-decoration:underline dotted" data-action="ann-open" data-id="${esc(a.id)}" title="点开查看详情与评论">${esc(a.title)}</b>
      <span class="muted" style="font-size:11px">${fmt(a.at)}${a.comments?.length ? ` · 💬 ${a.comments.length}` : ''}</span>
      <div style="font-size:13px;margin-top:3px;white-space:pre-wrap;cursor:pointer" data-action="ann-open" data-id="${esc(a.id)}">${esc(a.content)}</div>
      ${state.user && state.user.id === a.by ? `<div class="row" style="gap:6px;margin-top:5px">
        <button class="btn sm" data-action="ann-edit" data-id="${esc(a.id)}">编辑</button>
        <button class="btn sm ghost" data-action="ann-del" data-id="${esc(a.id)}">删除</button></div>` : ''}
    </div>`;
    const annPanel = `
      ${ann.length ? `<div class="panel"><h3>📢 公告</h3>${ann.slice(0, 5).map(annItem).join('')}</div>` : ''}
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
      toast('公告已发布');
      if (state.view === 'settings') renderSettings(); else renderPlaza();
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 公告详情弹窗：全文 + 评论列表 + 评论输入框（与网站一致） */
  async function openAnnDetail(id) {
    busy(true, '载入中…');
    try {
      const r = await api('GET', `/api/announcements/${id}`);
      const n = r.announcement, me = state.user;
      const canManage = !!me && me.id === n.by;
      const comments = n.comments || [];
      openModal(`<h3>📢 ${esc(n.title)}</h3>
        <div class="muted" style="font-size:11px;margin-bottom:10px">${esc(n.byName || '')} · ${fmt(n.at)}${n.editedAt ? ` · 编辑于 ${fmt(n.editedAt)}` : ''}</div>
        <div style="white-space:pre-wrap;line-height:1.8">${esc(n.content)}</div>
        <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
          <b style="font-size:13px">💬 评论（${comments.length}）</b>
          ${canManage ? `<div class="row" style="gap:6px;margin:8px 0">
            <input class="input" id="annETitle" value="${esc(n.title)}" style="flex:1" placeholder="标题" />
            <button class="btn sm primary" data-action="ann-save" data-id="${esc(n.id)}">保存修改</button></div>
          <textarea class="textarea" id="annEBody" rows="3">${esc(n.content)}</textarea>` : ''}
          <div id="annCmts" style="margin-top:10px">${comments.length ? comments.map((c) => `
            <div style="padding:8px 0;border-bottom:1px solid var(--line)">
              <b style="font-size:12px">${esc(c.byName)}</b>
              <span class="muted" style="font-size:11px">${fmt(c.at)}</span>
              ${me && (me.id === c.by || canManage) ? `<button class="btn sm ghost" style="float:right" data-action="ann-cmt-del" data-id="${esc(n.id)}" data-cid="${esc(c.id)}">删除</button>` : ''}
              <div style="font-size:13px;margin-top:4px;white-space:pre-wrap">${esc(c.text)}</div>
            </div>`).join('') : '<div class="muted sm-text">还没有评论</div>'}</div>
          ${me ? `<div class="row" style="gap:8px;margin-top:10px">
            <input class="input" id="annCmtText" placeholder="写下你的评论…" style="flex:1" />
            <button class="btn sm primary" data-action="ann-cmt" data-id="${esc(n.id)}">评论</button></div>`
          : '<div class="muted sm-text" style="margin-top:10px">登录后可以评论公告。</div>'}
        </div>`, true);
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 编辑公告（公告账号，只能改自己的） */
  async function openAnnEditor(id) {
    busy(true, '载入中…');
    try {
      const r = await api('GET', `/api/announcements/${id}`);
      const n = r.announcement;
      if (!r.canManage) return toast('只能编辑自己发布的公告', true);
      openModal(`<h3>编辑公告</h3>
        <label class="field"><span>公告标题</span><input class="input" id="annETitle" value="${esc(n.title)}" /></label>
        <label class="field"><span>公告内容</span><textarea class="textarea" id="annEBody" rows="5">${esc(n.content)}</textarea></label>
        <div class="modal-actions">
          <button class="btn" data-action="close-modal">取消</button>
          <button class="btn primary" data-action="ann-save" data-id="${esc(n.id)}">保存修改</button>
        </div>`, true);
    } catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  async function saveAnnouncement(id) {
    const title = $('#annETitle')?.value.trim(), content = $('#annEBody')?.value.trim();
    if (!title || !content) return toast('标题和内容不能为空', true);
    busy(true, '保存中…');
    try {
      await api('PATCH', `/api/announcements/${id}`, { body: { title, content } });
      closeModal();
      toast('公告已更新');
      if (state.view === 'settings') renderSettings(); else renderPlaza();
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
    const ann = await api('GET', '/api/announcements').catch(() => ({ announcements: [] }));
    if (state.trCfg === null) state.trCfg = await api('GET', '/api/translate/config').catch(() => null);
    const u = state.update;
    const cfg = await Host.getConfig().catch(() => ({}));
    const isLocal = cfg.mode !== 'remote';
    // 公告发布入口放到「设置」里，避免只在广场页不好找；与网站共用同一套权限与接口
    const annList = ann.announcements || [];
    const canAnn = !!state.user?.canAnnounce;
    const annPanel = `<div class="panel"><h3>📢 站点公告${canAnn ? ' · 管理' : ''}</h3>
      ${canAnn ? `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <input class="input" id="annTitle" placeholder="公告标题" style="flex:1;min-width:160px" />
          <button class="btn primary" data-action="announce">发布公告</button></div>
        <textarea class="textarea" id="annBody" rows="3" placeholder="公告内容…"></textarea>`
        : `<p class="muted" style="font-size:12px">当前账号无发布权限（仅站长可发），可在此查看站点公告。</p>`}
      <div style="margin-top:8px">${annList.length
        ? annList.slice(0, 8).map((a) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
            <b style="cursor:pointer;text-decoration:underline dotted" data-action="ann-open" data-id="${esc(a.id)}" title="点开查看详情与评论">${esc(a.title)}</b>
            <span class="muted" style="font-size:11px">${fmt(a.at)}${a.comments?.length ? ` · 💬 ${a.comments.length}` : ''}</span>
            <div style="font-size:13px;margin-top:3px;white-space:pre-wrap;cursor:pointer" data-action="ann-open" data-id="${esc(a.id)}">${esc(a.content)}</div>
            ${canAnn && state.user && state.user.id === a.by ? `<div class="row" style="gap:6px;margin-top:5px">
              <button class="btn sm" data-action="ann-edit" data-id="${esc(a.id)}">编辑</button>
              <button class="btn sm ghost" data-action="ann-del" data-id="${esc(a.id)}">删除</button></div>` : ''}
          </div>`).join('')
        : '<div class="muted sm-text">还没有发布过公告</div>'}</div>
    </div>`;
    $('#content').innerHTML = `${state.user ? `<div class="panel"><h3>账号</h3>
      <div class="user-line" style="margin-bottom:10px">${state.user.avatar ? `<img class="avatar-mini" style="width:52px;height:52px" src="${esc(asset(state.user.avatar))}" />` : `<span class="avatar-mini letter" style="width:52px;height:52px;font-size:22px">${esc(state.user.name.slice(0, 1).toUpperCase())}</span>`}
        <div><b>${esc(state.user.name)}</b><br><span class="muted">${esc(state.user.email)}</span></div></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn primary" data-action="edit-profile">编辑个人资料</button>
        <button class="btn" data-action="upload-avatar">修改头像</button>
        <button class="btn ghost" data-action="logout">退出登录</button></div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">可修改昵称、个人简介与登录密码；邮箱暂不支持自助更换。</p></div>` : ''}
      ${annPanel}
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
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${[['dark', '经典深色'], ['light', '清爽浅色'], ['sea', '深海之蓝'], ['forest', '松林绿'], ['sunset', '暮色暖橘'], ['sakura', '樱粉物语']]
            .map(([tid, label]) => `<button class="btn ${state.theme === tid ? 'primary' : ''}" data-action="theme" data-id="${tid}">${label}</button>`).join('')}
        </div>
        <p class="muted" style="font-size:11px;margin:8px 0 0">阅读器窗口也会跟随所选主题。</p></div>

      ${translatePanelHtml()}

      <div class="panel"><div class="panel-title"><h3>检查更新</h3>
        <button class="btn primary" data-action="check-update">检查更新</button></div>
        <div id="updateBox">${u ? updateHtml(u) : '<span class="muted">尚未检查</span>'}</div></div>

      <div class="panel"><h3>关于</h3>
        <div class="kv"><span>版本</span><b>v${esc(Host.version || '—')}（${isMobile ? 'Android' : '桌面'}）</b></div>
        <div class="kv"><span>数据</span><b>${isLocal ? '保存在本机' : '与网站 / 手机实时互通'}</b></div></div>`;
  }
  /** AI 翻译配置面板：多模态大模型看图翻译生肉漫画，服务端原位渲染（与网站设置页一致） */
  const TR_PRESETS = {
    gemini: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', label: 'Google Gemini（识图最准 · 需访问谷歌）' },
    glm4v: { provider: 'custom', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', label: '智谱 GLM-4V-Flash（国内直连 · 免费）' },
    siliconflow: { provider: 'custom', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-32B-Instruct', label: '硅基流动 Qwen-VL（国内直连）' },
    openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', label: 'OpenAI GPT-4o（付费）' },
  };
  function detectTrPreset(t) {
    const hit = Object.entries(TR_PRESETS).find(([, p]) => p.provider === t.provider && p.baseUrl === t.baseUrl && (!p.model || !t.model || p.model === t.model));
    return hit ? hit[0] : (t.provider === 'gemini' ? 'gemini' : 'custom');
  }
  function translatePanelHtml() {
    const t = state.trCfg;
    if (!t) return '';
    const d = (t.defaults || {})[t.provider] || { baseUrl: '', model: '' };
    const curPreset = detectTrPreset(t);
    const psel = (v, p) => `<option value="${v}" ${curPreset === v ? 'selected' : ''}>${esc(p.label)}</option>`;
    return `<div class="panel"><h3>🌐 AI 翻译生肉漫画</h3>
      <p class="muted" style="font-size:12px;margin:0 0 10px">
        阅读器里对非中文页面点「AI 翻译」：多模态大模型看懂画面上下文后翻译，服务端自动修补底图、把译文按原文位置与配色排回去。
        译文默认跟随原文颜色/粗细；需自备对应服务的 API Key（保存在服务端，不会外传）。</p>
      <label class="field"><span>① 选翻译服务（一键填好服务商/地址/模型）</span>
        <select class="input" id="trPreset">
          ${Object.entries(TR_PRESETS).map(([k, p]) => psel(k, p)).join('')}
        </select></label>
      <label class="field" style="margin-top:8px"><span>API Key${t.hasKey ? '（已保存，留空则保持不变）' : ''}</span>
        <input class="input" id="trKey" type="password" autocomplete="off" value="${esc(t.apiKey || '')}"
          placeholder="${t.hasKey ? '••••••••（已保存）' : '粘贴 API Key'}" /></label>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <label class="field" style="flex:0 0 auto"><span>当前服务商</span>
          <div class="input" style="display:flex;align-items:center;min-width:120px;cursor:default">${t.provider === 'gemini' ? 'Google Gemini' : t.provider === 'openai' ? 'OpenAI' : '自定义接口'}</div></label>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <label class="field" style="flex:1 1 240px"><span>接口地址（可留空用默认）</span>
          <input class="input" id="trBase" value="${esc(t.baseUrl || '')}" placeholder="${esc(d.baseUrl)}" /></label>
        <label class="field" style="flex:1 1 180px"><span>模型</span>
          <input class="input" id="trModel" value="${esc(t.model || '')}" placeholder="${esc(d.model)}" /></label>
      </div>
      <label class="field" style="margin-top:8px"><span>② 译文样式</span>
        <label class="row" style="gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" id="trAutoStyle" ${t.autoStyle !== false ? 'checked' : ''} />
          <span>跟随原文（自动用气泡里原文的颜色与粗细，推荐开启）</span></label></label>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <label class="field" style="flex:1 1 120px"><span>目标语言</span>
          <input class="input" id="trLang" value="${esc(t.targetLang || '简体中文')}" placeholder="简体中文" /></label>
        <label class="field" style="flex:1 1 120px"><span>字号调整</span>
          <input class="input" id="trSize" type="number" min="-6" max="12" value="${Number(t.fontSizeOffset) || 0}" /></label>
        <label class="field" style="flex:0 0 90px"><span>文字颜色</span>
          <input class="input" id="trInk" type="color" value="${esc(t.inkColor || '#ffffff')}" style="width:64px;padding:2px" /></label>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn primary" data-action="tr-save">保存翻译设置</button>
        <button class="btn" data-action="tr-test">测试连接</button>
        <span id="trTestMsg" class="muted" style="font-size:12px"></span>
      </div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">本机模式与连接站点均可翻译；翻译需联网调用所选模型的 API（Key 保存在服务端）。</p>
    </div>`;
  }
  function updateHtml(u) {
    if (!u.ok) return `<span style="color:var(--danger)">检查失败：${esc(u.error || '未知错误')}</span>`;
    return `<div class="kv"><span>当前版本</span><b>v${esc(u.current || Host.version || '—')}</b></div>
      <div class="kv"><span>最新版本</span><b>v${esc(u.latest || '—')}</b></div>
      <div class="kv"><span>状态</span><b style="color:${u.hasUpdate ? 'var(--warn)' : 'var(--accent)'}">${u.hasUpdate ? '发现新版本' : '已是最新'}</b></div>
      ${(u.notes || []).length ? `<ul class="notes">${u.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${u.hasUpdate ? `<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        ${u.installerUrl ? `<button class="btn primary" data-action="install-update">${isMobile ? '⬇ 下载新版本' : '⬇ 一键下载并安装'}</button>` : '<span class="muted">暂无对应平台的安装包，请到软件下载页查看</span>'}
        ${u.installerUrl ? `<button class="btn" data-action="open-download-url">在浏览器打开下载</button>` : ''}
        </div>
        ${u.updateError ? `<p style="color:var(--danger);font-size:12px;margin:8px 0 0">上次下载失败：${esc(u.updateError)}。可点上方「在浏览器打开下载」手动获取安装包。</p>` : ''}
        <p class="muted" style="font-size:11px;margin:8px 0 0">${u.installerFile ? `安装包：${esc(u.installerFile)}<br>` : ''}${isMobile ? '点击后由系统下载安装包，下载完成点通知按提示安装。' : '安装包约 100MB+，下载期间按钮暂时不可点，任务栏进度条显示进度；完成后自动打开安装程序。'}</p>` : ''}`;
  }
  async function checkUpdate() {
    busy(true, '检查中…');
    try { state.update = await Host.checkUpdate(); renderSettings(); toast(state.update.hasUpdate ? '发现新版本' : '已是最新版本'); }
    catch (err) { toast(err.message, true); } finally { busy(false); }
  }
  /** 软件内直接更新：优先走宿主下载安装；没有该能力的宿主退回系统下载 */
  async function installUpdate() {
    const u = state.update;
    const url = u?.installerUrl || u?.downloadUrl || u?.apkUrl;
    if (!url) return toast('没有可用的下载地址', true);
    busy(true, '下载新版本…');
    try {
      let r;
      if (typeof Host.installUpdate === 'function') {
        r = await Host.installUpdate(url);
      } else if (typeof Host.openExternal === 'function') {
        await Host.openExternal(url);
        r = { ok: true, opened: true };
      } else {
        throw new Error('当前客户端不支持软件内下载，请点「在浏览器打开下载」');
      }
      if (r && r.ok === false) throw new Error(r.error || '下载失败');
      if (u) u.updateError = '';
      toast(r?.installed ? '安装包已就绪，正在打开安装程序'
        : r?.opened ? '已打开下载页面，完成后点击安装'
        : '已开始下载，完成后按提示安装');
      renderSettings();
    } catch (err) {
      const msg = err.message || String(err);
      if (u) u.updateError = msg;
      toast('下载失败：' + msg, true);
      renderSettings();
    } finally { busy(false); }
  }

  /* ------------------------------ 事件 ------------------------------ */
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-sub-interval]');
    if (sel) {
      api('PUT', `/api/subscriptions/${sel.dataset.subInterval}`, { body: { intervalMin: Number(sel.value) } })
        .then(() => toast('检查间隔已更新'))
        .catch((err) => toast(err.message, true));
      return;
    }
    /* 翻译预设切换：立即把服务商/地址/模型写入后端，避免与字段错位 */
    if (e.target && e.target.id === 'trPreset') {
      const key = e.target.value;
      const preset = TR_PRESETS[key];
      if (preset && state.trCfg) {
        const patch = { provider: preset.provider, baseUrl: preset.baseUrl, model: preset.model };
        state.trCfg = { ...state.trCfg, ...patch };
        const b = $('#trBase'), m = $('#trModel');
        if (b) b.value = preset.baseUrl;
        if (m) m.value = preset.model;
        api('POST', '/api/translate/config', { body: patch })
          .then(() => toast('已切换翻译服务：' + preset.label.split('（')[0]))
          .catch((err) => toast(err.message || String(err), true));
      }
    }
  });
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action, id = el.dataset.id;
    try {
      if (a === 'nav' || el.classList.contains('nav-item')) { state.view = el.dataset.view; render(); }
      else if (a === 'itb-open') {
        if (state.importTask.comicId) { state.comic = state.importTask.comicId; state.view = 'comic'; render(); }
        state.importTask = { active: false, done: 0, total: 0, failed: 0, label: '', comicId: '', finished: false };
        saveImportTask(); renderImportTask();
      }
      else if (a === 'itb-close') {
        state.importTask = { active: false, done: 0, total: 0, failed: 0, label: '', comicId: '', finished: false };
        saveImportTask(); renderImportTask();
      }
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
      /* 所有导入入口统一走全格式流程：压缩包解压、PDF 渲染、小说分章、图片网格调序 */
      else if (a === 'pick-files') await startImportFrom(await Host.pickFiles());
      else if (a === 'pick-folder') await startImportFrom(await Host.pickFolder());
      else if (a === 'open-comic') { state.comic = id; state.view = 'comic'; render(); }
      else if (a === 'back-library') { state.view = 'library'; state.comic = null; render(); }
      else if (a === 'add-chapter') await addChapter();
      else if (a === 'add-pages') await addPages(id);
      else if (a === 'share-comic') await openShare();
      else if (a === 'import-into-current') {
        /* 漫画详情页直接导入：一次多选 → 排序网格 → 默认落到当前漫画的新话 */
        const p = Host.pickFiles ? await Host.pickFiles() : null;
        if (p && p.length) await startImportFrom(p, { defaultComicId: state.comic });
      }
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
      else if (a === 'ann-open') await openAnnDetail(id);
      else if (a === 'ann-edit') await openAnnEditor(id);
      else if (a === 'ann-save') await saveAnnouncement(id);
      else if (a === 'ann-del') {
        if (!window.confirm('确定删除这条公告吗？删除后无法恢复。')) return;
        busy(true, '删除中…');
        try { await api('DELETE', `/api/announcements/${id}`); toast('公告已删除'); state.view === 'settings' ? renderSettings() : renderPlaza(); }
        catch (err) { toast(err.message, true); } finally { busy(false); }
      }
      else if (a === 'ann-cmt') {
        const text = $('#annCmtText')?.value.trim();
        if (!text) return toast('请输入评论内容', true);
        busy(true, '发送中…');
        try { await api('POST', `/api/announcements/${id}/comments`, { body: { text } }); await openAnnDetail(id); }
        catch (err) { toast(err.message, true); } finally { busy(false); }
      }
      else if (a === 'ann-cmt-del') {
        busy(true, '删除中…');
        try { await api('DELETE', `/api/announcements/${id}/comments/${el.dataset.cid}`); await openAnnDetail(id); }
        catch (err) { toast(err.message, true); } finally { busy(false); }
      }
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
      else if (a === 'src-mode') setSrcMode(el.dataset.mode);
      else if (a === 'src-retry') await srcDiscover();
      else if (a === 'src-tab') { state.srcTab = Number(el.dataset.tab); state.srcPage = 1; await srcDiscover(); }
      else if (a === 'src-page') { state.srcPage = Math.max(1, state.srcPage + Number(el.dataset.d)); await srcDiscover(); }
      else if (a === 'src-search') await srcSearch();
      else if (a === 'src-open') await srcOpen(Number(el.dataset.i));
      else if (a === 'src-import') await srcImport();
      else if (a === 'src-manage') srcManage();
      else if (a === 'src-save') await srcSave();
      else if (a === 'src-account') await srcAccount();
      else if (a === 'src-account-save') await srcAccountSave();
      else if (a === 'src-subscribe') await subscribe(el.dataset.url, el.dataset.title, el.dataset.cover);
      else if (a === 'rename-chapter') await renameChapter(id);
      else if (a === 'manage-pages') await openPageManager(id);
      else if (a === 'move-chapter') await moveChapter(id, Number(el.dataset.dir));
      else if (a === 'del-chapter') await delChapter(id);
      else if (a === 'merge-chapters') await mergeChaptersDialog();
      else if (a === 'undo-merge') await undoChapterMerge();
      else if (a === 'clean-empty') await cleanEmptyChapters();
      else if (a === 'export-chapter') await exportCbz([id]);
      else if (a === 'export-comic') openExportDialog();
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
      else if (a === 'edit-comic') openComicEditor(state.comicData || {});
      else if (a === 'pick-comic-cover') {
        let pick = [];
        try { pick = await Host.pickFiles(); } catch { /* 忽略 */ }
        if (pick && pick.length) {
          state.comicCoverPick = pick[0];
          const hint = $('#ceCoverHint');
          if (hint) hint.textContent = `已选择 ${nameOf(pick[0])}，点「保存」后生效`;
          toast('封面已选择，点保存生效');
        }
      }
      else if (a === 'save-comic') {
        const body = {
          title: String($('#ceTitle')?.value || '').trim() || '未命名漫画',
          author: String($('#ceAuthor')?.value || '').trim(),
          description: String($('#ceDesc')?.value || '').trim(),
        };
        busy(true, '保存中…');
        try {
          await api('POST', `/api/comics/${state.comic}`, { body });
          const f = state.comicCoverPick;
          if (f) {
            await api('POST', `/api/comics/${state.comic}/cover`, {
              files: [typeof f === 'string' ? { path: f, name: base(f), field: 'file' } : { id: f.id, name: nameOf(f), field: 'file' }],
            });
            state.comicCoverPick = null;
          }
          closeModal();
          await renderComic();
          toast('漫画信息已保存');
        } catch (err) { toast(err.message, true); } finally { busy(false); }
      }
      else if (a === 'edit-profile') openProfileEditor();
      else if (a === 'profile-save') await saveProfile();
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
      else if (a === 'open-download-url') {
        const u = state.update;
        const url = u?.installerUrl || u?.downloadUrl || u?.apkUrl;
        if (!url) { toast('没有可用的下载地址', true); return; }
        if (typeof Host.openExternal === 'function') { await Host.openExternal(url); toast('已打开下载页面'); }
        else window.open(url, '_blank');
      }
      else if (a === 'theme') {
        const THEMES = ['dark', 'light', 'sea', 'forest', 'sunset', 'sakura'];
        state.theme = THEMES.includes(id) ? id : 'dark';
        document.documentElement.dataset.theme = state.theme;
        try { localStorage.setItem('cv-theme', state.theme); } catch { /* 忽略 */ }
        try { await Host.setTheme(state.theme); } catch { /* 旧宿主不支持时靠 localStorage 兜底 */ }
        renderSettings();
      }
      else if (a === 'tr-save') {
        const body = {
          provider: state.trCfg?.provider || 'gemini',
          apiKey: $('#trKey')?.value.trim() || '',
          baseUrl: $('#trBase')?.value.trim() || '',
          model: $('#trModel')?.value.trim() || '',
          targetLang: $('#trLang')?.value.trim() || '简体中文',
          fontSizeOffset: Number($('#trSize')?.value) || 0,
          inkColor: $('#trInk')?.value || '#ffffff',
          autoStyle: $('#trAutoStyle') ? $('#trAutoStyle').checked : true,
        };
        try {
          await api('POST', '/api/translate/config', { body });
          state.trCfg = await api('GET', '/api/translate/config');
          toast('翻译设置已保存');
          renderSettings();
        } catch (err) { toast(err.message || String(err), true); }
      }
      else if (a === 'tr-test') {
        const msg = $('#trTestMsg'); if (msg) msg.textContent = '测试中…';
        try {
          const r = await api('POST', '/api/translate/test', { body: {} });
          if (msg) msg.textContent = `✓ 连接正常（${r.provider} / ${r.model}，识别到 ${r.regions} 处文字）`;
        } catch (err) {
          if (msg) msg.textContent = '✗ ' + ((err && err.message) || '测试失败');
        }
      }
      else if (a === 'check-update') await checkUpdate();
      else if (a === 'open-site') await Host.openExternal(await Host.siteUrl());
      /* 兼容旧版按钮：一律留在软件内下载，不再打开浏览器 */
      else if (a === 'open-download') await installUpdate();
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
      if (paths.length) startImportFrom(paths);
    });
  }
  if (Host.onMenu) Host.onMenu(async (action) => {
    if (action === 'new-comic') { state.view = 'library'; render(); document.querySelector('[data-action="new-comic"]')?.click(); }
    else if (action === 'pick-import') startImportFrom(await (Host.pickImport ? Host.pickImport() : Host.pickFiles()));
    else if (action === 'pick-files') Host.pickFiles().then(startImportFrom);
    else if (action === 'pick-folder') Host.pickFolder().then(startImportFrom);
    else if (action === 'settings') { state.view = 'settings'; render(); }
    else if (action === 'check-update') { state.view = 'settings'; render(); checkUpdate(); }
    else if (action === 'refresh') render();
    else if (action === 'back') { state.view = 'library'; state.comic = null; render(); }
  });

  boot();
})();
