/**
 * 公共书库分类 / 排行 / 搜索支撑、主页动态、上传记录、公告、
 * 软件下载清单与自动更新，以及「合规批量导入」。
 *
 * 版权边界：本模块不爬取任何第三方网站。批量导入只接受用户主动粘贴的清单，
 * 且必须显式确认拥有合法授权；示例漫画全部由本站代码绘制生成。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  loadDb, saveDb, saveDbSoon, newId, getComic, coverOf, TMP_DIR,
} from './store.js';
import { storePage, isImageName } from './page-store.js';
import { recordActivity, recordUpload, backfillActivities } from './activity.js';
import { requireUser } from './social.js';
import { hasSharp } from './media.js';

const now = () => Date.now();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 唯一版本源：改版本号只改根目录 version.json，再运行 npm run version:sync。
 * 服务端在启动时读取一次；四段式版本比较见下方 versionCompare。
 */
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

/** 网站版本：/api/runtime 使用；网页 / PWA 永远随服务器最新 */
export const APP_VERSION = V.web;

/** 客户端版本：与网站版本独立演进，/api/software/latest 按 channel 返回 */
export const CLIENT_VERSIONS = { desktop: V.desktop, android: V.android };

/** Electron 构建用的三段版本号（安装包文件名） */
export const BUILD_VERSION = V.buildVersion;

/** 版本规则与发布说明，供下载页与检查更新展示 */
export const VERSION_META = V;

/** 资料库中的安装包合集（Windows / Linux / Android 全在里面） */
export const DRIVE_ZIP_URL = V.driveZipUrl;

/** 人类可读体积 */
function humanSize(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '—';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

/**
 * 热读安装包清单：优先 data/release.json（本地发版产物），其次 docs/release.json（公开镜像）。
 * 每次请求比对 mtime，文件一变立即生效，无需重启服务 —— 这就是「网站自动更新安装包」。
 */
let releaseCache = { key: '', data: null };
function readRelease() {
  // 固定优先级：data/ 是真实发版产物（含本地直链），docs/ 只是 Pages 公开镜像。
  // 不按 mtime 取最新，否则镜像会把 local 直链覆盖掉。
  const candidates = [
    path.join(ROOT, 'data', 'release.json'),
    path.join(ROOT, 'docs', 'release.json'),
  ];
  let chosen = null;
  for (const p2 of candidates) {
    try {
      const st = fs.statSync(p2);
      chosen = { file: p2, mtime: st.mtimeMs, size: st.size };
      break; // 第一个存在的即胜出
    } catch { /* 文件不存在，继续下一个 */ }
  }
  if (!chosen) return null;
  // 仍用 mtime+size 做缓存键：文件一变立即重读，实现「不重启热更新」
  const key = chosen.file + ':' + chosen.mtime + ':' + chosen.size;
  if (releaseCache.key === key) return releaseCache.data;
  try {
    const data = JSON.parse(fs.readFileSync(chosen.file, 'utf8'));
    releaseCache = { key, data };
    return data;
  } catch { return releaseCache.data; }
}

/** 公共书库预设分类。all 只用于筛选，不写入漫画 */
export const CATEGORIES = [
  { id: 'all', name: '全部', icon: '✨' },
  { id: 'action', name: '热血动作', icon: '⚔️' },
  { id: 'scifi', name: '科幻奇幻', icon: '🚀' },
  { id: 'slice', name: '日常治愈', icon: '🍵' },
  { id: 'comedy', name: '搞笑轻松', icon: '😆' },
  { id: 'mystery', name: '悬疑推理', icon: '🔎' },
  { id: 'romance', name: '恋爱青春', icon: '💗' },
  { id: 'food', name: '美食生活', icon: '🍜' },
  { id: 'knowledge', name: '知识科普', icon: '📖' },
  { id: 'art', name: '艺术画集', icon: '🎨' },
  { id: 'other', name: '其他', icon: '📚' },
];
const CATEGORY_IDS = new Set(CATEGORIES.filter((c) => c.id !== 'all').map((c) => c.id));

/** 站内可提供的软件模板：真实文件名 / 体积 / 校验和由 release.json 覆盖 */
const SOFTWARE_TEMPLATE = [
  {
    id: 'windows-portable', platform: 'Windows', icon: '🪟',
    name: 'Windows 便携版', file: '漫画库-便携版.exe', size: '约 106 MB',
    desc: '免安装，双击即用；数据与在线网站、手机端互通。',
    url: DRIVE_ZIP_URL, primary: true,
  },
  {
    id: 'windows-green', platform: 'Windows', icon: '📦',
    name: 'Windows 绿色版', file: '漫画库-Windows绿色版.zip', size: '约 151 MB',
    desc: '解压到任意目录即可运行，方便放在 U 盘里。',
    url: DRIVE_ZIP_URL,
  },
  {
    id: 'linux-appimage', platform: 'Linux', icon: '🐧',
    name: 'Linux AppImage', file: '', size: '约 120 MB',
    desc: 'chmod +x 后直接运行，无需 root 安装。',
    url: DRIVE_ZIP_URL,
  },
  {
    id: 'android-apk', platform: 'Android', icon: '🤖',
    name: 'Android 安装包', file: 'ComicVault-android.apk', size: '约 70 KB',
    desc: '独立手机客户端界面，底部导航 + 原生设置，数据实时同步。',
    url: '/files/ComicVault-android.apk',
  },
  {
    id: 'zip-bundle', platform: '全部平台', icon: '🗂️',
    name: '安装包合集', file: '漫画库-安装包合集.zip', size: '约 376 MB',
    desc: '一次下载全部安装包与安装说明；含 Windows / Linux / Android 成品。',
    url: DRIVE_ZIP_URL,
  },
  {
    id: 'pwa', platform: '网页 / iOS', icon: '🌐',
    name: '网页版 / PWA', file: '无需下载', size: '0 MB',
    desc: '浏览器打开本站即可用；iOS 用 Safari「添加到主屏幕」，内容永远自动最新。',
    url: '/', primary: true,
  },
];

/**
 * 把发版清单合并进软件模板。
 * release.json 里 local=true 的包会被挂到 /files/ 直链，网站可直接下载最新成品。
 */
function softwareList(rel) {
  const pkgs = new Map((rel?.packages || []).map((x) => [x.id, x]));
  return SOFTWARE_TEMPLATE.map((t) => {
    const p = pkgs.get(t.id);
    const file = p?.file || t.file || `漫画库 ComicVault-${BUILD_VERSION}.AppImage`;
    const local = !!(p && p.local);
    const url = t.id === 'pwa' ? '/'
      : local ? `/files/${encodeURIComponent(file)}`
        : (p?.url || t.url);
    return {
      id: t.id, platform: t.platform, icon: t.icon, name: t.name,
      desc: t.desc, primary: t.primary,
      file,
      size: p?.sizeBytes ? humanSize(p.sizeBytes) : t.size,
      sizeBytes: p?.sizeBytes || null,
      sha256: p?.sha256 || null,
      local,
      updatedAt: p?.updatedAt || rel?.releasedAt || null,
      url,
    };
  });
}
/** 兼容旧引用：无清单时的静态默认值 */
const SOFTWARE = softwareList(null);

/** 更新说明同样来自 version.json，改文案不必碰服务端代码 */
const WEB_NOTES = V.notes.web;
const CLIENT_NOTES = {
  desktop: V.notes.desktop,
  android: V.notes.android,
  web: V.notes.webChannel || V.notes.web,
};
/** 兼容旧引用 */
const UPDATE_NOTES = WEB_NOTES;

/* ------------------------------ 工具 ------------------------------ */

function communityComics(db) {
  return db.comics.filter((c) => c.scope === 'community');
}

function pageCount(c) {
  return (c.chapters || []).reduce((n, ch) => n + (ch.pages?.length || 0), 0);
}

function userName(db, id) {
  return db.users.find((u) => u.id === id)?.name || '书库贡献者';
}

function comicCard(c) {
  return {
    id: c.id,
    title: c.title,
    coverUrl: coverOf(c)?.url || null,
    author: c.author || '',
    category: c.category || 'other',
    views: Number(c.views) || 0,
    likes: Array.isArray(c.likes) ? c.likes.length : 0,
    downloads: Number(c.downloads) || 0,
    chapterCount: (c.chapters || []).length,
    pageCount: pageCount(c),
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || 0,
    sample: !!c.sample,
  };
}

function hotScore(c) {
  const likes = Array.isArray(c.likes) ? c.likes.length : 0;
  const freshness = Math.max(0, 30 - (now() - (c.updatedAt || c.createdAt || now())) / 86400000);
  return (Number(c.views) || 0) * 1
    + likes * 8
    + (Number(c.downloads) || 0) * 5
    + (c.chapters || []).length * 3
    + pageCount(c) * 0.2
    + freshness * 2;
}

function versionCompare(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function requireAnnouncer(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录', needLogin: true });
  if (!req.user.canAnnounce) {
    return res.status(403).json({ error: '只有站点公告账号可以发布公告' });
  }
  next();
}

/** 初始化分类、软件清单，并回填历史动态（幂等） */
function ensureCatalog(db) {
  db.categories = Array.isArray(db.categories) ? db.categories : [];
  if (!db.categories.length) {
    db.categories = CATEGORIES.map((c) => ({ ...c }));
  }
  db.softwareReleases = Array.isArray(db.softwareReleases) ? db.softwareReleases : [];
  if (!db.softwareReleases.length) {
    db.softwareReleases = [{
      version: CLIENT_VERSIONS.desktop,
      releasedAt: now(),
      notes: CLIENT_NOTES.desktop,
      downloadUrl: DRIVE_ZIP_URL,
    }];
  }
  backfillActivities(db);
  saveDbSoon();
}

/* ------------------------------ 合规远程图片抓取 ------------------------------ */

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) {
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a === 169 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  return false;
}

/** 解析 URL 并拒绝私网 / 非标准端口 / 内嵌凭据，防 SSRF */
async function safeRemoteUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw new Error('图片地址格式不正确');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只支持 http/https 图片地址');
  if (u.username || u.password) throw new Error('图片地址不允许带账号密码');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('只允许 80 / 443 端口');
  if (isPrivateHost(u.hostname)) throw new Error('不允许导入内网地址');
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateHost(a.address))) {
      throw new Error('该域名解析到内网地址，已拒绝');
    }
  } catch (err) {
    if (/已拒绝/.test(err.message)) throw err;
    throw new Error(`域名解析失败：${err.message}`);
  }
  return u.toString();
}

function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;              // JPEG
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return true;                   // PNG
  if (buf.subarray(0, 3).toString() === 'GIF') return true;                              // GIF
  if (buf.subarray(0, 2).toString() === 'BM') return true;                               // BMP
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return true;
  return false;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

async function fetchImage(rawUrl) {
  const url = await safeRemoteUrl(rawUrl);
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'ComicVault-Importer/1.0', Accept: 'image/*' },
  });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error('图片超过 15MB，已跳过');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 15MB，已跳过');
  if (!looksLikeImage(buf)) throw new Error('返回的不是有效图片');
  const type = String(res.headers.get('content-type') || '').split(';')[0];
  return { buf, mime: type.startsWith('image/') ? type : 'image/jpeg', url };
}

/* ------------------------------ 示例漫画种子 ------------------------------ */

const SAMPLES = [
  { title: '像素小城的四季', category: 'slice', chapters: 4, pages: 4, tags: ['治愈', '日常'], from: '#8fd3f4', to: '#fbc2eb', desc: '一本关于小镇四季的自制短篇，本站示例代码绘制，可自由阅读与转载。' },
  { title: '机械师的备忘簿', category: 'scifi', chapters: 3, pages: 4, tags: ['科幻', '设定集'], from: '#0f2027', to: '#2c5364', desc: '齿轮、蒸汽与星图：机械师留下的图文档案，本站自制示例。' },
  { title: '山海食记', category: 'food', chapters: 3, pages: 4, tags: ['美食', '文化'], from: '#f6d365', to: '#fda085', desc: '跟着手绘图鉴认识各地风物与吃食，本站自制示例。' },
  { title: '夜行电车', category: 'mystery', chapters: 3, pages: 4, tags: ['悬疑', '短篇'], from: '#141e30', to: '#243b55', desc: '末班车之后的几个小故事，本站自制示例。' },
  { title: '纸上植物园', category: 'knowledge', chapters: 4, pages: 4, tags: ['科普', '植物'], from: '#a8e063', to: '#56ab2f', desc: '用几何图形描绘的植物观察笔记，本站自制示例。' },
  { title: '格子间的猫', category: 'comedy', chapters: 3, pages: 4, tags: ['搞笑', '日常'], from: '#ffd3a5', to: '#fd6585', desc: '办公室里那只谁也管不了的猫，本站自制示例。' },
];

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function sampleSvg(s, chapterNo, pageNo, total) {
  const label = `CHAPTER ${String(chapterNo).padStart(2, '0')}`;
  const num = `${String(pageNo).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const seed = (chapterNo * 7 + pageNo * 13) % 5;
  const shapes = [
    `<circle cx="${220 + seed * 60}" cy="330" r="120" fill="#ffffff" opacity=".16"/>`,
    `<rect x="${140 + seed * 40}" y="480" width="520" height="150" rx="28" fill="#ffffff" opacity=".13"/>`,
    `<path d="M120 760 L400 560 L680 760 Z" fill="#ffffff" opacity=".15"/>`,
    `<circle cx="400" cy="620" r="170" fill="none" stroke="#ffffff" stroke-width="8" opacity=".28"/>`,
    `<rect x="250" y="520" width="300" height="300" rx="40" fill="#ffffff" opacity=".12"/>`,
  ][seed];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1130" viewBox="0 0 800 1130">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${s.from}"/><stop offset="1" stop-color="${s.to}"/>
  </linearGradient></defs>
  <rect width="800" height="1130" fill="url(#bg)"/>
  ${shapes}
  <text x="60" y="110" font-family="sans-serif" font-size="26" letter-spacing="6" fill="#ffffff" opacity=".85">COMICVAULT · SELF-MADE SAMPLE</text>
  <text x="400" y="900" text-anchor="middle" font-family="sans-serif" font-size="76" font-weight="700" fill="#ffffff">${escapeXml(label)}</text>
  <text x="400" y="980" text-anchor="middle" font-family="sans-serif" font-size="34" letter-spacing="8" fill="#ffffff" opacity=".9">${escapeXml(num)}</text>
  <text x="400" y="1070" text-anchor="middle" font-family="sans-serif" font-size="22" letter-spacing="4" fill="#ffffff" opacity=".75">SAMPLE · FREE TO READ</text>
</svg>`;
}

let sharp = null;
if (hasSharp) {
  try {
    sharp = (await import('sharp')).default;
  } catch {
    sharp = null;
  }
}

/**
 * 生成几本站内自制的示例漫画，让分类 / 排行 / 搜索一上线就有内容可跑。
 * 只执行一次（db.meta.samplesSeeded），用户删掉示例也不会重新长出来。
 * 不联网、不抓取任何第三方内容。
 */
export async function ensureSamples() {
  if (String(process.env.CV_DISABLE_SAMPLES || '') === '1') return;
  const db = loadDb();
  if (db.meta.samplesSeeded) return;
  if (!sharp) {
    db.meta.samplesSeeded = true;
    saveDbSoon();
    return;
  }
  for (const s of SAMPLES) {
    if (db.comics.some((c) => c.sample && c.title === s.title)) continue;
    const t = now();
    const comic = {
      id: newId('c'),
      title: s.title,
      author: 'ComicVault 示例工坊',
      artist: '',
      description: s.desc,
      tags: s.tags,
      status: 'completed',
      direction: 'ltr',
      language: 'zh',
      favorite: false,
      cover: null,
      chapters: [],
      progress: null,
      share: null,
      publisher: 'ComicVault',
      year: new Date().getFullYear(),
      rating: null,
      ageRating: '',
      comicInfo: null,
      ownerId: db.users[0]?.id || null,
      createdBy: db.users[0]?.id || null,
      scope: 'community',
      visibility: 'public',
      allowDownload: true,
      aliases: [], tagEntries: [], covers: [],
      activeCoverId: null, activeAliasId: null,
      category: s.category,
      views: 0, downloads: 0, likes: [],
      lastActivityAt: t,
      createdAt: t, updatedAt: t,
      sample: true,
      license: '本站自制示例（可自由阅读）',
      sourceUrl: null,
    };
    // 先完整生成页面，最后才入库：避免用户在生成过程中看到「有书但没有页」的中间态
    for (let ci = 0; ci < s.chapters; ci += 1) {
      const ch = {
        id: newId('ch'), title: `第 ${ci + 1} 话`, number: ci + 1,
        pages: [], uploadedBy: comic.createdBy, createdAt: t + ci,
      };
      comic.chapters.push(ch);
      for (let pi = 0; pi < s.pages; pi += 1) {
        const svg = sampleSvg(s, ci + 1, pi + 1, s.pages);
        const buf = await sharp(Buffer.from(svg)).png().toBuffer().catch(() => null);
        if (!buf) continue;
        const tmp = path.join(TMP_DIR, `sample-${crypto.randomBytes(6).toString('hex')}.png`);
        await fsp.writeFile(tmp, buf);
        try {
          const page = await storePage(tmp, `page-${String(pi + 1).padStart(2, '0')}.png`, 'image/png', comic.id, ch.id);
          ch.pages.push(page);
        } catch (err) {
          console.error('[samples] 页面落盘失败:', err.message);
          await fsp.rm(tmp, { force: true });
        }
      }
    }
    comic.lastActivityAt = now();
    db.comics.unshift(comic);
    // recordUpload 内部已生成一条动态，这里不再重复写
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title,
      kind: 'comic', count: comic.chapters.length,
      userId: comic.createdBy, userName: userName(db, comic.createdBy),
    });
  }
  db.meta.samplesSeeded = true;
  saveDb();
  console.log('[discovery] 已生成公共书库示例漫画');
}

/* ------------------------------ 路由 ------------------------------ */

export function registerDiscovery(app) {
  const db = loadDb();
  ensureCatalog(db);

  /* ---- 公共书库：分类 / 排行 / 上传记录 ---- */

  app.get('/api/community/categories', (_req, res) => {
    const d = loadDb();
    const comics = communityComics(d);
    const categories = d.categories.map((c) => ({
      ...c,
      count: c.id === 'all' ? comics.length : comics.filter((x) => (x.category || 'other') === c.id).length,
    }));
    res.json({ categories });
  });

  app.get('/api/community/ranking', (req, res) => {
    const d = loadDb();
    const type = ['hot', 'views', 'likes', 'downloads', 'new'].includes(String(req.query.type))
      ? String(req.query.type) : 'hot';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const sorted = [...communityComics(d)].sort((a, b) => {
      if (type === 'views') return (b.views || 0) - (a.views || 0);
      if (type === 'likes') return (b.likes?.length || 0) - (a.likes?.length || 0);
      if (type === 'downloads') return (b.downloads || 0) - (a.downloads || 0);
      if (type === 'new') return (b.createdAt || 0) - (a.createdAt || 0);
      return hotScore(b) - hotScore(a);
    });
    const ranking = sorted.slice(0, limit).map((c, i) => ({
      ...comicCard(c), rank: i + 1, score: Math.round(hotScore(c)),
    }));
    res.json({ ranking, type, total: communityComics(d).length });
  });

  app.get('/api/community/uploads', (req, res) => {
    const d = loadDb();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const uploads = [...(d.uploads || [])]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((u) => ({ ...u, userName: u.userName || userName(d, u.userId) }));
    res.json({ uploads, total: (d.uploads || []).length });
  });

  /* ---- 主页动态流 ---- */

  app.get('/api/activity', (req, res) => {
    const d = loadDb();
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 40));
    const items = [];
    for (const a of [...(d.activities || [])].sort((x, y) => y.at - x.at)) {
      let text = '';
      let link = '/community';
      let icon = '📚';
      if (a.type === 'comic' || a.type === 'import' || a.type === 'publish') {
        text = a.type === 'import' && a.count > 1
          ? `批量导入了 ${a.count} 本漫画到公共书库`
          : `《${a.comicTitle || '新漫画'}》加入了公共书库`;
        link = a.comicId ? `/comic/${a.comicId}` : '/community';
        icon = '📚';
      } else if (a.type === 'upload' || a.type === 'chapter' || a.type === 'pages') {
        text = `给《${a.comicTitle || '漫画'}》上传了 ${a.chapterTitle || '新章节'}${a.count ? `（${a.count} 页）` : ''}`;
        link = a.comicId ? `/comic/${a.comicId}` : '/community';
        icon = '⬆️';
      } else if (a.type === 'post') {
        text = `在广场发了动态${a.excerpt ? `：${a.excerpt}` : ''}`;
        link = '/plaza';
        icon = '💬';
      } else {
        continue;
      }
      items.push({
        id: a.id, type: a.type, at: a.at, text, link, icon,
        userName: a.userName || '站内用户',
        count: a.count || 0,
      });
    }
    const announcements = [...(d.announcements || [])]
      .sort((x, y) => y.at - x.at)
      .map((n) => ({
        id: n.id, title: n.title, content: n.content,
        by: n.by, byName: n.byName, at: n.at, pinned: true,
      }));
    res.json({ activities: items.slice(0, limit), announcements, canAnnounce: !!req.user?.canAnnounce });
  });

  /* ---- 公告：只有指定账号可发，且只能删自己发的 ---- */

  app.get('/api/announcements', (req, res) => {
    const d = loadDb();
    res.json({
      announcements: [...(d.announcements || [])].sort((a, b) => b.at - a.at),
      canAnnounce: !!req.user?.canAnnounce,
    });
  });

  app.post('/api/announcements', requireAnnouncer, (req, res) => {
    const d = loadDb();
    const title = String(req.body?.title || '').trim().slice(0, 80);
    const content = String(req.body?.content || '').trim().slice(0, 1000);
    if (!title || !content) return res.status(400).json({ error: '请填写公告标题和内容' });
    const item = {
      id: newId('ann'),
      title, content,
      by: req.user.id, byName: req.user.name,
      at: now(), pinned: true,
    };
    d.announcements.push(item);
    if (d.announcements.length > 50) d.announcements.splice(0, d.announcements.length - 50);
    recordActivity(d, 'announcement', {
      userName: req.user.name, comicTitle: title, excerpt: content.slice(0, 60),
    });
    saveDbSoon();
    res.json({ announcement: item });
  });

  app.delete('/api/announcements/:id', requireAnnouncer, (req, res) => {
    const d = loadDb();
    const idx = d.announcements.findIndex((n) => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '公告不存在' });
    if (d.announcements[idx].by !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己发布的公告' });
    }
    d.announcements.splice(idx, 1);
    saveDbSoon();
    res.json({ ok: true });
  });

  /* ---- 软件下载清单与自动更新 ---- */

  app.get('/api/software', (_req, res) => {
    const rel = readRelease();
    res.json({
      /** 安装包版本（软件清单用） */
      version: CLIENT_VERSIONS.desktop,
      /** 网站版本 */
      webVersion: APP_VERSION,
      versions: { web: APP_VERSION, ...CLIENT_VERSIONS },
      buildVersion: BUILD_VERSION,
      build: rel?.build ?? V.build,
      releasedAt: rel?.releasedAt || V.releasedAt || null,
      /** 是否已接入发版脚本：true 时清单、体积、直链随文件热更新 */
      autoUpdated: !!rel,
      versionRule: V.versionRule || null,
      software: softwareList(rel),
      notes: CLIENT_NOTES.desktop,
      driveUrl: DRIVE_ZIP_URL,
      /** 客户端用自身地址栏拼出网站地址，服务端不回显内部域名 */
      sitePath: '/',
    });
  });

  app.get('/api/software/latest', (req, res) => {
    const channel = ['desktop', 'android', 'web'].includes(String(req.query.channel))
      ? String(req.query.channel) : 'desktop';
    const current = String(req.query.current || '').slice(0, 40);
    const latest = channel === 'web'
      ? APP_VERSION
      : (CLIENT_VERSIONS[channel] || CLIENT_VERSIONS.desktop);
    const rel = readRelease();
    const pkgs = rel?.packages || [];
    const localZip = pkgs.find((x) => x.id === 'zip-bundle' && x.local);
    const localApk = pkgs.find((x) => x.id === 'android-apk' && x.local);
    const localDesktop = pkgs.find((x) => x.id === 'windows-portable' && x.local);
    res.json({
      channel,
      current,
      latest,
      webVersion: APP_VERSION,
      build: rel?.build ?? V.build,
      hasUpdate: channel === 'web' ? false : (!current || versionCompare(current, latest) < 0),
      notes: CLIENT_NOTES[channel] || CLIENT_NOTES.desktop,
      downloadUrl: localZip || localDesktop
        ? `/files/${encodeURIComponent((localZip || localDesktop).file)}`
        : DRIVE_ZIP_URL,
      /** 软件内一键更新：优先 NSIS 安装器，其次便携版 */
      installerUrl: (() => {
        const nsis = pkgs.find((x) => x.id === 'windows-nsis' && x.local);
        if (nsis) return `/files/${encodeURIComponent(nsis.file)}`;
        if (localDesktop) return `/files/${encodeURIComponent(localDesktop.file)}`;
        return null;
      })(),
      apkUrl: localApk ? `/files/${encodeURIComponent(localApk.file)}` : '/files/ComicVault-android.apk',
      releasedAt: rel?.releasedAt || V.releasedAt || loadDb().softwareReleases?.[0]?.releasedAt || null,
      autoUpdated: !!rel,
      /** 网页 / PWA 内容随服务器实时更新，永不提示升级 */
      alwaysLatest: channel === 'web',
      hint: channel === 'web'
        ? '网页版始终为最新版本，刷新即可'
        : rel
          ? '网站已同步最新安装包，打开「软件下载」页即可直接下载；网页内容自动保持最新'
          : '请到资料库下载最新安装包；网站内容会自动保持最新',
    });
  });

  /* ---- 浏览量 / 点赞 / 分类设置（独立路径，避开 comicGuard） ---- */

  app.post('/api/discovery/view', (req, res) => {
    const d = loadDb();
    const c = getComic(String(req.body?.comicId || ''));
    if (!c) return res.status(404).json({ error: '漫画不存在' });
    if (c.scope !== 'community' && c.visibility !== 'public' && !c.share?.enabled) {
      return res.status(403).json({ error: '这本漫画不公开' });
    }
    c.views = (Number(c.views) || 0) + 1;
    c.lastActivityAt = now();
    saveDbSoon();
    res.json({ views: c.views });
  });

  app.post('/api/discovery/like', requireUser, (req, res) => {
    const d = loadDb();
    const c = getComic(String(req.body?.comicId || ''));
    if (!c) return res.status(404).json({ error: '漫画不存在' });
    if (c.scope !== 'community' && c.visibility !== 'public') {
      return res.status(403).json({ error: '只能为公共书库或公开漫画点赞' });
    }
    c.likes = Array.isArray(c.likes) ? c.likes : [];
    const i = c.likes.indexOf(req.user.id);
    if (i >= 0) c.likes.splice(i, 1);
    else c.likes.push(req.user.id);
    c.lastActivityAt = now();
    saveDbSoon();
    res.json({ likes: c.likes.length, liked: i < 0 });
  });

  app.patch('/api/discovery/category', requireUser, (req, res) => {
    const d = loadDb();
    const c = getComic(String(req.body?.comicId || ''));
    if (!c) return res.status(404).json({ error: '漫画不存在' });
    const category = String(req.body?.category || '');
    if (!CATEGORY_IDS.has(category)) return res.status(400).json({ error: '分类不存在' });
    const isMine = c.ownerId === req.user.id || c.createdBy === req.user.id;
    if (!isMine && c.scope !== 'community') {
      return res.status(403).json({ error: '只能给自己的漫画或公共书库漫画设置分类' });
    }
    c.category = category;
    c.updatedAt = now();
    c.lastActivityAt = now();
    saveDbSoon();
    res.json({ category });
  });

  /* ---- 合规批量导入：必须确认合法授权，不爬取第三方站点 ---- */

  app.post('/api/community/import', requireUser, async (req, res) => {
    if (req.body?.confirmRights !== true) {
      return res.status(400).json({
        error: '请先确认你对导入内容拥有合法授权（或内容属于公有领域 / 自制）',
        needRightsConfirm: true,
      });
    }
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
    if (!items.length) return res.status(400).json({ error: '导入清单为空' });

    const d = loadDb();
    const created = [];
    const errors = [];
    let imageCount = 0;

    for (const raw of items) {
      const title = String(raw?.title || '').trim().slice(0, 120);
      if (!title) { errors.push('有一项缺少书名，已跳过'); continue; }
      const category = CATEGORY_IDS.has(String(raw?.category)) ? String(raw.category) : 'other';
      const t = now();
      const comic = {
        id: newId('c'),
        title,
        author: String(raw?.author || '').slice(0, 80),
        artist: '', description: String(raw?.description || '').slice(0, 500),
        tags: (Array.isArray(raw?.tags) ? raw.tags : []).slice(0, 12).map((x) => String(x).slice(0, 30)),
        status: 'ongoing', direction: 'ltr', language: 'zh',
        favorite: false, cover: null, chapters: [], progress: null, share: null,
        publisher: '', year: null, rating: null, ageRating: '', comicInfo: null,
        ownerId: req.user.id, createdBy: req.user.id,
        scope: 'community', visibility: 'public', allowDownload: true,
        aliases: [], tagEntries: [], covers: [], activeCoverId: null, activeAliasId: null,
        category, views: 0, downloads: 0, likes: [], lastActivityAt: t,
        createdAt: t, updatedAt: t,
        sample: false,
        license: '导入者声明拥有合法授权',
        sourceUrl: String(raw?.sourceUrl || '').slice(0, 500) || null,
      };
      d.comics.unshift(comic);

      const chapters = Array.isArray(raw?.chapters) ? raw.chapters.slice(0, 8) : [];
      for (let ci = 0; ci < chapters.length; ci += 1) {
        const chRaw = chapters[ci];
        const ch = {
          id: newId('ch'),
          title: String(chRaw?.title || `第 ${ci + 1} 话`).slice(0, 120),
          number: ci + 1,
          pages: [], uploadedBy: req.user.id, createdAt: t + ci,
        };
        comic.chapters.push(ch);
        const urls = (Array.isArray(chRaw?.pages) ? chRaw.pages : []).slice(0, 30);
        for (let pi = 0; pi < urls.length; pi += 1) {
          if (imageCount >= 200) break;
          try {
            const { buf, mime, url } = await fetchImage(urls[pi]);
            const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
            const tmp = path.join(TMP_DIR, `import-${crypto.randomBytes(6).toString('hex')}.${ext}`);
            await fsp.writeFile(tmp, buf);
            const page = await storePage(tmp, `page-${String(pi + 1).padStart(2, '0')}.${ext}`, mime, comic.id, ch.id);
            page.name = url;
            ch.pages.push(page);
            imageCount += 1;
          } catch (err) {
            errors.push(`${title} / ${ch.title} 第 ${pi + 1} 页：${err.message}`);
          }
        }
      }
      recordUpload(d, {
        comicId: comic.id, comicTitle: comic.title,
        kind: 'comic', count: comic.chapters.length,
        userId: req.user.id, userName: req.user.name,
      });
      created.push({ id: comic.id, title: comic.title, chapters: comic.chapters.length, pages: pageCount(comic) });
    }

    if (created.length) {
      recordActivity(d, 'import', {
        userName: req.user.name, count: created.length,
        comicTitle: created[0].title,
      });
      saveDb();
    }
    res.json({ ok: true, created, importedImages: imageCount, errors });
  });

  /** 手动重新生成示例（公告账号可用；已生成过则提示） */
  app.post('/api/community/seed', requireAnnouncer, async (_req, res) => {
    const d = loadDb();
    if (d.meta.samplesSeeded) {
      return res.json({ ok: true, hint: '示例漫画已生成过，不会重复创建' });
    }
    await ensureSamples();
    res.json({ ok: true, hint: '示例漫画已生成' });
  });
}

export { SOFTWARE, SOFTWARE_TEMPLATE, softwareList, readRelease, versionCompare, isImageName };
