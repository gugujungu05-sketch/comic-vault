'use strict';
/**
 * 漫画库 ComicVault · 独立桌面客户端（v3.1）
 *
 * 与 v1/v2 的本质区别：主窗口加载的是打包在本地的 app/index.html，
 * 不是一个远程网站。界面、交互、阅读器全部是客户端自己的，
 * 只通过 /api 与同一台服务器交换数据，因此账号、漫画与网站/手机端实时互通。
 */
const {
  app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, clipboard, net, nativeImage, session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const VERSION = '3.4.0.50.0';
/** 只有旧版临时隧道地址才需要强制回退本机，固定云端地址不能被误清 */
const OLD_TUNNEL_RE = /trycloudflare\.com|ngrok|loca\.lt|cloudflare-tunnel/i;
/** 项目自己的公开入口：软件里所有「打开网站 / 分享链接」都用它，不再出现 workbuddy 网盘地址 */
const PUBLIC_SITE = 'https://gugujungu05-sketch.github.io/comic-vault/';
const RELEASES_URL = 'https://github.com/gugujungu05-sketch/comic-vault/releases/latest';
/** 默认云端后端：与网站同一份数据，登录态 / 导入 / 分享链接因此天然互通 */
const CLOUD_SERVER = 'https://a3375579f1d0038dc.app.workbuddy.host/?sharecode=HDZTNNHTBW';
const DRIVE_ZIP_URL = RELEASES_URL;
const APP_DIR = path.join(__dirname, 'app');
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
const ARCHIVE_RE = /\.(zip|cbz|rar|cbr|7z|cb7|tar|tgz|gz)$/i;
const NATURAL = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

let configPath = path.join(__dirname, 'config.json');
let mainWindow = null;
let tray = null;
let quitting = false;
const readerParams = new Map();

/* ------------------------------ 内置本地服务 ------------------------------ */
/** 打包后 host/ 被解压到 app.asar.unpacked；开发态直接在 desktop/host */
function hostDir() {
  const dir = path.join(__dirname, 'host');
  return fs.existsSync(dir) ? dir : path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'host');
}
let hostProc = null;
let hostPort = 0;
let hostReady = null;

function startLocalServer() {
  if (hostReady) return hostReady;
  hostReady = new Promise((resolve) => {
    const dir = hostDir();
    if (!fs.existsSync(path.join(dir, 'server', 'index.js'))) return resolve(false);
    hostPort = 38780 + Math.floor(Math.random() * 500);
    const dataDir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    hostProc = spawn(process.execPath, [path.join(dir, 'server', 'index.js')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(hostPort),
        CV_DATA_DIR: dataDir,
        CV_NO_DOTENV: '1',
        CV_EMBEDDED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProc.stdout.on('data', () => {});
    hostProc.stderr.on('data', (d) => console.warn('[host]', String(d).trim().slice(0, 300)));
    hostProc.on('exit', (code) => { hostProc = null; if (code) console.warn('[host] 内置服务退出:', code); });
    const t0 = Date.now();
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port: hostPort, path: '/api/runtime', timeout: 900 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() - t0 > 20000) resolve(false);
        else setTimeout(poll, 350);
      });
      req.on('timeout', () => { req.destroy(); });
    })();
  });
  return hostReady;
}
function stopLocalServer() {
  if (hostProc) { try { hostProc.kill(); } catch { /* 忽略 */ } hostProc = null; }
}

/* ------------------------------ 配置 ------------------------------ */
function readConfig() {
  const base = { mode: 'remote', server: CLOUD_SERVER, theme: 'dark', bounds: null, authToken: '' };
  let cfg;
  try { cfg = Object.assign(base, JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}); }
  catch { return base; }
  // 旧版本的「隧道地址」早已失效：一律回到内置本地服务，避免软件卡在连不上的服务器
  if (cfg.mode === undefined && OLD_TUNNEL_RE.test(String(cfg.server || ''))) {
    cfg.mode = 'local'; cfg.server = '';
  }
  return cfg;
}
function writeConfig(patch) {
  const next = Object.assign(readConfig(), patch);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) { console.warn('[comic-vault] 配置保存失败:', err.message); }
  return next;
}
/** 当前生效的服务地址：本地模式用内置服务，远程模式用用户填的站点 */
function serverUrl() {
  const cfg = readConfig();
  if (cfg.mode === 'remote' && cfg.server) return cfg.server;
  return `http://127.0.0.1:${hostPort || 0}`;
}
function normalizeServer(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? v : null; }
  catch { return null; }
}
function iconPath() {
  const f = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return fs.existsSync(f) ? f : undefined;
}

/** 拼出 API / 资源地址，并保留托管环境必需的 sharecode */
function endpoint(pathname, extra = {}) {
  const base = new URL(serverUrl());
  const code = base.searchParams.get('sharecode');
  const url = new URL(pathname, base);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
  if (code) url.searchParams.set('sharecode', code);
  return url.toString();
}

/* ------------------------------ HTTP ------------------------------ */
/** 直连会话：不走系统代理。VPN / 加速器开启时系统代理会把到云端后端的请求
 *  也代理出去，代理节点连不上国内托管服务就「开了 VPN 软件全挂」——
 *  代理请求失败时自动用本会话直连重试一次。 */
let directSessionRef = null;
function directSession() {
  if (!directSessionRef) {
    try {
      directSessionRef = session.fromPartition('cv-direct', { cache: false });
      directSessionRef.setProxy({ mode: 'direct' });
    } catch { directSessionRef = session.defaultSession; }
  }
  return directSessionRef;
}

/** 用 Electron 的 net.fetch：与窗口共用同一 session 的 Cookie，登录态与 <img> 一致 */
async function apiFetch(url, { method = 'GET', headers = {}, body } = {}) {
  // 超时保护：普通请求 30s，上传/大文件 180s，避免「一直加载」卡死界面
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), body ? 180000 : 30000);
  const doFetch = (useDirect, signal) => {
    const headers2 = { ...headers };
    const savedToken = readConfig().authToken;
    if (savedToken) headers2['x-cv-token'] = savedToken;
    const opts = { method, headers: headers2, body, credentials: 'include', signal };
    if (useDirect) opts.session = directSession();
    return net.fetch(url, opts);
  };
  try {
    let res;
    try {
      res = await doFetch(false, ctl.signal);
    } catch (err) {
      if (ctl.signal.aborted) {
        // 代理挂起拖到超时：换直连再给一次完整预算，直连通了软件就能用，不用用户去关 VPN
        const ctl2 = new AbortController();
        const timer2 = setTimeout(() => ctl2.abort(), body ? 180000 : 30000);
        try { res = await doFetch(true, ctl2.signal); } finally { clearTimeout(timer2); }
      } else {
        throw err;
      }
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
    if (res.ok && data && typeof data === 'object' && typeof data.token === 'string' && data.token) {
      writeConfig({ authToken: data.token });
    }
    if (res.ok && /\/api\/auth\/logout/.test(String(url))) writeConfig({ authToken: '' });
    return { status: res.status, data };
  } catch (err) {
    if (ctl.signal.aborted) return { status: 0, data: { error: '请求超时，服务器没有响应。若已开启 VPN / 加速器，请先关闭或把 *.app.workbuddy.host 设为直连' } };
    return { status: 0, data: { error: `网络连接失败：${err.message}。若已开启 VPN / 加速器，请先关闭或把 *.app.workbuddy.host 设为直连` } };
  } finally { clearTimeout(timer); }
}
function mimeOf(name) {
  const e = path.extname(name).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.avif': 'image/avif', '.zip': 'application/zip', '.cbz': 'application/zip',
    '.pdf': 'application/pdf', '.epub': 'application/epub+zip',
    '.txt': 'text/plain', '.md': 'text/markdown', '.text': 'text/plain' })[e] || 'application/octet-stream';
}
function multipart(files, fields = {}) {
  const boundary = '----cv' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files || []) {
    const name = String(f.name || path.basename(f.path || '') || 'file').replace(/["\r\n]/g, '_');
    // 中文文件名用 RFC 5987 filename* 兜底，避免某些环境下 multer 解析不到文件名
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field || 'files'}"; filename="${name}"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}\r\n` +
      `Content-Type: ${mimeOf(name)}\r\n\r\n`, 'utf8'));
    try { chunks.push(fs.readFileSync(f.path)); }
    catch { chunks.push(Buffer.alloc(0)); }
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

/* ------------------------------ 主窗口 ------------------------------ */
function createMainWindow() {
  const cfg = readConfig();
  const bounds = cfg.bounds && cfg.bounds.width ? cfg.bounds : { width: 1180, height: 780 };
  mainWindow = new BrowserWindow({
    ...bounds, minWidth: 860, minHeight: 560,
    title: '漫画库 ComicVault', icon: iconPath(),
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(APP_DIR, 'index.html'));
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); return; }
    try { writeConfig({ bounds: mainWindow.getBounds() }); } catch { /* 忽略 */ }
  });
  mainWindow.on('minimize', (e) => { e.preventDefault(); mainWindow.hide(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}
function send(action) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cv:menu', action); }
function showMain() {
  if (!mainWindow) createMainWindow();
  mainWindow.show(); mainWindow.focus();
}

/* ------------------------------ 阅读器窗口 ------------------------------ */
function createReaderWindow(comicId, chapterId) {
  const w = new BrowserWindow({
    width: 1100, height: 820, minWidth: 640, minHeight: 480,
    title: '阅读器 · 漫画库', icon: iconPath(), backgroundColor: '#07090c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  });
  const id = w.webContents.id;
  readerParams.set(id, { comicId, chapterId });
  w.loadFile(path.join(APP_DIR, 'reader.html'));
  w.on('closed', () => readerParams.delete(id));
  w.setMenuBarVisibility(false);
  // 阅读器默认最大化，画面不再挤在中间一小块；用户可自行还原
  try { w.maximize(); } catch { /* 忽略平台差异 */ }
  return w;
}

/* ------------------------------ 菜单 / 托盘 ------------------------------ */
function buildMenu() {
  const template = [
    { label: '文件', submenu: [
      { label: '新建漫画', accelerator: 'CmdOrCtrl+N', click: () => send('new-comic') },
      { label: '导入漫画（图片 / ZIP·CBZ·RAR·7Z）…', accelerator: 'CmdOrCtrl+O', click: () => send('pick-import') },
      { label: '导入文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('pick-folder') },
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ] },
    { label: '视图', submenu: [
      { label: '刷新', accelerator: 'F5', click: () => send('refresh') },
      { label: '返回书架', accelerator: 'Esc', click: () => send('back') },
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: '设置', submenu: [
      { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      { label: '检查更新…', click: () => send('check-update') },
    ] },
    { label: '帮助', submenu: [
      { label: '在浏览器打开网站', click: () => shell.openExternal(PUBLIC_SITE) },
      { label: '复制网站地址', click: () => clipboard.writeText(PUBLIC_SITE) },
      { type: 'separator' },
      { label: `关于 漫画库 v${VERSION}`, click: showAbout },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function showAbout() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info', title: '关于', buttons: ['好'],
    message: `漫画库 ComicVault 桌面客户端 v${VERSION}`,
    detail: '独立界面与原生能力的客户端，不是网站的浏览器壳。\n\n' +
      '· 拖拽 / 原生文件对话框批量导入\n· 独立阅读窗口（键盘翻页、双页、缩放）\n' +
      '· 系统菜单、托盘常驻、快捷键\n· 通过 API 与网站、手机端共用同一份数据\n\n' +
      `服务：${readConfig().mode === 'local' ? '本机模式（数据保存在这台设备）' : 'ComicVault 云端（与网站 / 手机实时互通）'}`,
  }).catch(() => {});
}
function buildTray() {
  if (!iconPath()) return;
  try { tray = new Tray(iconPath()); } catch { return; }
  tray.setToolTip('漫画库 ComicVault');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMain },
    { label: '检查更新…', click: () => { showMain(); send('check-update'); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

/**
 * 文件上传用 Node 原生 http/https 发送 multipart。
 * net.fetch 对 Buffer body + 自定义 boundary/Content-Type 的兼容在不同 Electron 版本上
 * 不稳定（表现为桌面端「导入没反应 / 请求失败」），原生请求完全可控；
 * 会话 cookie 从 Electron 的 session 里取，登录态与 net.fetch 完全一致。
 */
async function uploadViaHttp(url, method, contentType, body) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  let cookieHeader = '';
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${u.protocol}//${u.host}` });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { /* 忽略 */ }
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method,
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(readConfig().authToken ? { 'x-cv-token': readConfig().authToken } : {}),
      },
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try { data = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
        resolve({ status: res.statusCode || 0, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('上传超时，请重试')));
    req.on('error', reject);
    req.end(body);
  });
}

/* ------------------------------ IPC ------------------------------ */
ipcMain.handle('cv:api', async (_e, opts = {}) => {
  const { method = 'GET', path: p = '/', query = {}, body, files } = opts;
  const url = endpoint(p, query || {});
  if (files && files.length) {
    const m = multipart(files, body && typeof body === 'object' ? body : {});
    try { return await uploadViaHttp(url, method, m.type, m.body); }
    catch (err) {
      // 降级：极少数环境原生请求被代理拦截时，再试 net.fetch
      try { return await apiFetch(url, { method, headers: { 'Content-Type': m.type }, body: m.body }); }
      catch { return { status: 0, data: { error: err.message || '网络请求失败' } }; }
    }
  }
  const headers = {};
  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try { return await apiFetch(url, { method, headers, body: payload }); }
  catch (err) { return { status: 0, data: { error: err.message || '网络请求失败' } }; }
});
ipcMain.on('cv:asset', (e, p) => { e.returnValue = endpoint(String(p || '/')); });

/* 全端统一的导入格式：图片 + 各类压缩包 + PDF + EPUB（与 src/lib/importers.ts、server/archive.js 对齐） */
const IMPORT_EXT = [
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff',
  'zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'r00', 'r01',
  'tar', 'tgz', 'gz', 'bz2', 'xz', 'epub', 'pdf',
  'ace', 'arj', 'lzh', 'lha', 'cab', 'iso',
  'txt', 'text', 'md', 'markdown',
];
const IMPORT_FILTERS = [
  { name: '漫画 / 小说（图片 / ZIP / CBZ / RAR / 7Z / EPUB / PDF / TXT / TAR）', extensions: IMPORT_EXT },
  { name: '全部文件', extensions: ['*'] },
];
/* 任何导入入口都用同一套全格式选择器，避免「点导入却只能选图片」 */
ipcMain.handle('cv:pick-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择漫画文件（图片 / 压缩包 / PDF / EPUB）', properties: ['openFile', 'multiSelections'],
    filters: IMPORT_FILTERS,
  });
  return r.canceled ? [] : r.filePaths;
});
/* 与网站一致的导入：一次多选图片 / 压缩包，压缩包交给内置服务解压 */
ipcMain.handle('cv:pick-import', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '导入漫画（可一次多选）', properties: ['openFile', 'multiSelections'],
    filters: IMPORT_FILTERS,
  });
  return r.canceled ? [] : r.filePaths;
});
/* 头像裁剪：把所选图片读成 data URL 交给界面裁剪 */
ipcMain.handle('cv:read-image-data', (_e, p) => {
  try {
    const buf = fs.readFileSync(String(p || ''));
    const ext = path.extname(String(p)).toLowerCase();
    const mime = ({ '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' })[ext] || 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return ''; }
});
/* 裁剪结果 / PDF 渲染页落成临时 PNG，返回路径供上传。文件名带随机后缀避免多页同毫秒覆盖 */
ipcMain.handle('cv:save-temp-image', (_e, dataUrl, nameHint) => {
  try {
    const m = String(dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) throw new Error('不是图片数据');
    const dir = app.getPath('temp');
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safe = String(nameHint || '').replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_').slice(0, 60);
    const file = path.join(dir, `cv-${safe || 'tmp'}-${uniq}.${m[1] === 'png' ? 'png' : 'jpg'}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  } catch { return ''; }
});
/* 保存一张图片到用户选择的位置（分享二维码 / 阅读器单页通用）。
   接收 data:image/...;base64,... 直接落盘：Electron 里 <a download> 对 data URL
   不会触发下载，曾经表现为「点『保存二维码』没反应」。 */
ipcMain.handle('cv:save-image', async (e, dataUrl, nameHint) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,(.+)$/i);
  if (!m) return { ok: false, error: '图片数据无效' };
  const kind = m[1].toLowerCase();
  const ext = ({ png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' })[kind] || 'jpg';
  let picDir = app.getPath('pictures');
  if (!fs.existsSync(picDir)) picDir = app.getPath('downloads');
  const safe = String(nameHint || 'ComicVault-图片')
    .replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || 'ComicVault-图片';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(picDir, `${safe}.${ext}`),
    filters: [{ name: '图片', extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 把服务器上的一张图片读成 data URL：file:// 页面直连 http 图片会受 CORS 限制，
   交给主进程 net.fetch 取回，再交给 cv:save-image 落盘（阅读器「保存本页」用）。 */
ipcMain.handle('cv:image-to-data-url', async (_e, url) => {
  try {
    const res = await net.fetch(String(url || ''), { credentials: 'include' });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch { return ''; }
});

/* 渲染进程用 pdf.js 导入 PDF：把 PDF 读成 base64（webSecurity 下 file:// 无法直接 fetch） */
ipcMain.handle('cv:read-file-base64', (_e, p) => {
  try { return fs.readFileSync(String(p || '')).toString('base64'); } catch { return ''; }
});
/* pdf.js 的 lib/worker 源码文本，渲染进程用 Blob URL 动态 import（避免 file:// ES module 限制） */
ipcMain.handle('cv:pdfjs-source', () => {
  try {
    const vd = path.join(APP_DIR, 'vendor');
    return {
      lib: fs.readFileSync(path.join(vd, 'pdf.min.mjs'), 'utf8'),
      worker: fs.readFileSync(path.join(vd, 'pdf.worker.min.mjs'), 'utf8'),
    };
  } catch { return null; }
});
ipcMain.handle('cv:copy-text', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('cv:pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '选择漫画文件夹', properties: ['openDirectory'] });
  return r.canceled ? [] : r.filePaths;
});
function walk(dir, out, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (IMG_RE.test(e.name)) out.push(p);
  }
}
ipcMain.handle('cv:resolve-paths', (_e, paths) => {
  const out = [];
  for (const p of paths || []) {
    try {
      if (fs.statSync(p).isDirectory()) walk(p, out);
      else if (IMG_RE.test(p)) out.push(p);
    } catch { /* 忽略无效路径 */ }
  }
  return out.sort(NATURAL.compare);
});

/* 导入网格：把本地图片压成 180px 宽的 data URL，避免 file:// 被 CSP 拦截 */
ipcMain.handle('cv:thumb', (_e, p) => {
  try {
    const img = nativeImage.createFromPath(String(p || ''));
    if (img.isEmpty()) return '';
    const sz = img.getSize();
    if (!sz.width) return '';
    const w = 180;
    const h = Math.max(1, Math.min(320, Math.round(sz.height / sz.width * w)));
    return img.resize({ width: w, height: h, quality: 'good' }).toDataURL();
  } catch { return ''; }
});

ipcMain.handle('cv:get-config', () => {
  const c = readConfig();
  return { mode: c.mode, server: c.server, theme: c.theme, version: VERSION, platform: process.platform,
    publicSite: PUBLIC_SITE, local: `http://127.0.0.1:${hostPort}`,
    dataDir: path.join(app.getPath('userData'), 'data') };
});
/* mode=local 用内置服务；mode=remote 连接自建/托管站点 */
ipcMain.handle('cv:set-mode', (_e, mode) => {
  if (mode !== 'local' && mode !== 'remote') throw new Error('模式不合法');
  writeConfig({ mode });
  return { ok: true };
});
ipcMain.handle('cv:set-server', (_e, raw) => {
  const url = normalizeServer(raw);
  if (!url) throw new Error('请输入有效的 http(s) 地址');
  writeConfig({ server: url, mode: 'remote' });
  return { ok: true, server: url };
});
/** 软件内直接更新：下载对应平台安装包并运行安装（绿色版则保存到下载目录） */
ipcMain.handle('cv:update-install', async (e, downloadUrl) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  let url = String(downloadUrl || '');
  if (url.startsWith('/')) url = endpoint(url);
  if (!/^https?:/i.test(url)) return { ok: false, error: '下载地址不合法' };
  const dlWin = win;
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!res.ok) return { ok: false, error: `下载失败 (${res.status})` };
    const total = Number(res.headers.get('content-length')) || 0;
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'update.exe';
    const isInstaller = /\.exe$/i.test(name);
    const dest = isInstaller
      ? path.join(app.getPath('temp'), name)
      : path.join(app.getPath('downloads'), name);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0; let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      if (total) {
        const pct = Math.round((received / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          dlWin?.setProgressBar(pct / 100);
        }
      }
    }
    dlWin?.setProgressBar(-1);
    fs.writeFileSync(dest, Buffer.concat(chunks));
    if (isInstaller) {
      shell.openPath(dest); // NSIS 安装器：运行后由用户完成安装
      return { ok: true, path: dest, installed: true };
    }
    shell.showItemInFolder(dest); // 便携版 / AppImage / APK：展示在下载目录
    return { ok: true, path: dest, installed: false };
  } catch (err) {
    dlWin?.setProgressBar(-1);
    return { ok: false, error: err.message || '下载失败' };
  }
});
ipcMain.handle('cv:set-theme', (_e, theme) => { writeConfig({ theme: theme === 'light' ? 'light' : 'dark' }); return { ok: true }; });
ipcMain.handle('cv:site-url', () => PUBLIC_SITE);
/** 分享链接与二维码统一用项目自己的公开域名（200 直达的 ?s= 入口） */
ipcMain.handle('cv:share-base', () => PUBLIC_SITE);
/** 分享落地页配置：主链接走常驻服务器（200 + 可看可下载），备用走 GitHub Pages 静态入口 */
ipcMain.handle('cv:share-config', () => {
  let base = CLOUD_SERVER, cred = '';
  try {
    const u = new URL(CLOUD_SERVER);
    base = u.origin;
    cred = u.searchParams.get('sharecode') || '';
  } catch { /* 保持原值 */ }
  return {
    landing: `${base}/comic-vault/?s=`,
    backup: `${PUBLIC_SITE}?s=`,
    credential: cred,
    downloadBase: base,
  };
});
ipcMain.handle('cv:open-external', (_e, url) => { if (/^https?:/i.test(String(url))) shell.openExternal(String(url)); return { ok: true }; });
ipcMain.handle('cv:open-download', async () => {
  // 全流程留在软件内：只把安装包地址交给界面，由「一键下载并安装」完成。
  try {
    const info = await apiFetch(endpoint('/api/software/latest', { channel: 'desktop', current: VERSION }));
    const raw = info.data?.installerUrl || info.data?.downloadUrl;
    const url = raw ? (String(raw).startsWith('/') ? endpoint(String(raw)) : String(raw)) : '';
    return { ok: !!url, installerUrl: url };
  } catch { return { ok: false, installerUrl: '' }; }
});

ipcMain.handle('cv:check-update', async () => {
  try {
    const info = await apiFetch(endpoint('/api/software/latest', {
      channel: 'desktop', current: VERSION,
      platform: process.platform, arch: process.arch,
    }));
    let serverVersion = '';
    try { const rt = await apiFetch(endpoint('/api/runtime')); serverVersion = rt.data?.version || ''; } catch { /* 忽略 */ }
    const d = info.data || {};
    const abs = (u) => (typeof u === 'string' && u.startsWith('/') ? endpoint(u) : u);
    return { ok: info.status === 200, current: VERSION, ...d,
      installerUrl: abs(d.installerUrl), downloadUrl: abs(d.downloadUrl), apkUrl: abs(d.apkUrl),
      serverVersion,
      error: info.status !== 200 ? (d.error || '检查失败') : undefined };
  } catch (err) { return { ok: false, current: VERSION, error: err.message || '检查失败' }; }
});

ipcMain.handle('cv:open-reader', (_e, comicId, chapterId) => { createReaderWindow(comicId, chapterId); return { ok: true }; });

/** 从服务器下载一个文件（如 CBZ 导出）并让用户选择保存位置 */
ipcMain.handle('cv:save-api-file', async (e, apiPath, defaultName) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: String(defaultName || 'export.cbz'),
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const res = await net.fetch(endpoint(String(apiPath || '/')), { credentials: 'include' });
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* 忽略 */ }
    return { ok: false, error: msg };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return { ok: true, path: filePath };
});

ipcMain.handle('cv:reader-init', (e) => readerParams.get(e.sender.id) || {});
ipcMain.handle('cv:close-reader', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return { ok: true }; });
ipcMain.handle('cv:toggle-fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setFullScreen(!w.isFullScreen());
  return { ok: true };
});

/* ------------------------------ 生命周期 ------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(async () => {
    // 先把内置服务跑起来再开窗口：界面一进来就有可用的 API，不会白屏/卡按钮
    await startLocalServer();
    buildMenu();
    createMainWindow();
    buildTray();
    app.on('activate', showMain);
  });
}
app.on('before-quit', () => { quitting = true; stopLocalServer(); });
app.on('window-all-closed', (e) => { e.preventDefault(); });
