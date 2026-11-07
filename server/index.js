import './env.js';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  loadDb,
  saveDb,
  saveDbSoon,
  newId,
  getComic,
  getComicByShareToken,
  getChapter,
  coverOf,
  chapterDir,
  comicDir,
  STORE_DIR,
  TMP_DIR,
  DATA_DIR,
  ROOT,
  removeComicFiles,
  removeChapterFiles,
  dirStats,
} from './store.js';
import { exportArchive, exportPdf, exportEpub, safeName, extOf } from './exporters.js';
import { metadata, thumbnail, hasSharp, transformImage, splitSpread, mergeSpread, isSpread } from './media.js';
import { extractWith7z, warmup, engineStatus, SEVENZ_RE } from './archive.js';
const EPUB_OK = /\.epub$/i;
const PDF_OK = /\.pdf$/i;
import { parseComicInfo, comicFieldsFromInfo } from './comicinfo.js';
import { attachUser, requireUser, comicGuard, assetGuard, registerSocial } from './social.js';
import { registerSources } from './sources.js';
import { registerUpdates } from './updates.js';
import { storePage } from './page-store.js';
import { recordActivity, recordUpload } from './activity.js';
import { registerDiscovery, ensureSamples, APP_VERSION } from './discovery.js';

const app = express();
// 识别反向代理（Cloudflare Tunnel 等）转发的 https 协议，让会话 cookie 正确置 secure
app.set('trust proxy', true);
const PORT = Number(process.env.PORT || 8787);
const ALLOW_FS_IMPORT = process.env.CV_ALLOW_FS_IMPORT !== '0';

app.use(express.json({ limit: '20mb' }));
/**
 * CORS（域名直达）：网站前端可以部署在任意域名（GitHub Pages / 自有域名），
 * 通过「设置 → 服务器地址」或自动探测指向本服务，跨域请求必须放行；
 * 同时响应 Chrome 的 Private Network Access 预检（公网页面 → 本机服务）。
 */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type,Authorization,X-Share-Password');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(attachUser);

/**
 * 托管环境（如 *.app.workbuddy.host）要求每个请求都带 ?sharecode= 凭据，
 * 而浏览器加载 <img src="/api/files/..."> 时不会自动带上地址栏里的凭据。
 * 这里统一把凭据注入到响应体里所有 /api/ 开头的资源地址上，
 * 使图片、缩略图、导出链接等在托管环境下也始终携带凭据。
 * 本地运行（无 sharecode）时完全不生效。
 */
function injectShareCode(value, code, depth = 0) {
  if (depth > 12 || value == null) return value;
  if (typeof value === 'string') {
    if (!value.startsWith('/api/') || value.includes('sharecode=')) return value;
    return `${value}${value.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(code)}`;
  }
  if (Array.isArray(value)) return value.map((v) => injectShareCode(v, code, depth + 1));
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = injectShareCode(value[k], code, depth + 1);
    return value;
  }
  return value;
}

app.use((req, res, next) => {
  const code = req.query?.sharecode;
  if (typeof code !== 'string' || !code) return next();
  const origin = res.json.bind(res);
  res.json = (body) => origin(injectShareCode(body, code));
  next();
});

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024, files: 300 },
});

/** 广场附件 / 表情包：单文件 60MB，单条动态最多 12 个文件 */
const plazaUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 60 * 1024 * 1024, files: 12 },
});

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
};

/* ------------------------------ 工具 ------------------------------ */

const now = () => Date.now();

/** 新建漫画的归属与社区字段（导入 / 创建共用） */
function ownershipFields(req, body = {}) {
  return {
    ownerId: req.user?.id || null,
    createdBy: req.user?.id || null,
    scope: body.scope === 'community' ? 'community' : 'personal',
    visibility: body.visibility === 'public' ? 'public' : 'private',
    allowDownload: body.allowDownload !== false,
    aliases: [],
    tagEntries: [],
    covers: [],
    activeCoverId: null,
    activeAliasId: null,
  };
}

function isSafeSegment(s) {
  return typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 当前显示名：优先用户选中的别名，否则原始标题 */
function displayName(comic) {
  const a = (comic.aliases || []).find((x) => x.id === comic.activeAliasId);
  return a ? a.value : comic.title;
}

function summarize(comic) {
  const cover = coverOf(comic);
  const pageCount = (comic.chapters || []).reduce((n, c) => n + (c.pages?.length || 0), 0);
  const db = loadDb();
  return {
    id: comic.id,
    title: displayName(comic),
    baseTitle: comic.title,
    author: comic.author || '',
    artist: comic.artist || '',
    description: comic.description || '',
    tags: comic.tags || [],
    status: comic.status || 'ongoing',
    direction: comic.direction || 'ltr',
    language: comic.language || 'zh',
    favorite: !!comic.favorite,
    chapterCount: (comic.chapters || []).length,
    pageCount,
    coverUrl: cover?.url || null,
    coverChapterId: cover?.chapter?.id || null,
    coverPageId: cover?.page?.id || null,
    publisher: comic.publisher || '',
    year: comic.year || null,
    rating: comic.rating || null,
    ageRating: comic.ageRating || '',
    comicInfo: comic.comicInfo || null,
    progress: comic.progress || null,
    scope: comic.scope || 'personal',
    visibility: comic.visibility || 'private',
    allowDownload: comic.allowDownload !== false,
    ownerId: comic.ownerId || null,
    ownerName: db.users.find((u) => u.id === comic.ownerId)?.name || '',
    createdBy: comic.createdBy || null,
    aliases: comic.aliases || [],
    tagEntries: comic.tagEntries || [],
    covers: comic.covers || [],
    activeCoverId: comic.activeCoverId || null,
    activeAliasId: comic.activeAliasId || null,
    share: comic.share
      ? {
          enabled: !!comic.share.enabled,
          token: comic.share.token,
          allowDownload: !!comic.share.allowDownload,
          expiresAt: comic.share.expiresAt || null,
          hasPassword: !!comic.share.passwordHash,
          views: comic.share.views || 0,
          chapterIds: comic.share.chapterIds || [],
          logCount: (comic.share.logs || []).length,
        }
      : {
          enabled: false,
          token: null,
          allowDownload: true,
          expiresAt: null,
          hasPassword: false,
          views: 0,
          chapterIds: [],
          logCount: 0,
        },
    createdAt: comic.createdAt,
    updatedAt: comic.updatedAt,
  };
}

/** 分享范围内可见的章节（按话分享时只返回被选中的话） */
function sharedChapters(comic) {
  const ids = comic.share?.chapterIds;
  if (!ids || !ids.length) return comic.chapters || [];
  const set = new Set(ids);
  return (comic.chapters || []).filter((c) => set.has(c.id));
}

/** 记录一次分享访问（阅读或下载），最多保留 200 条 */
function logVisit(comic, req, event = 'view') {
  const share = comic.share;
  if (!share) return;
  share.logs = share.logs || [];
  const ip = String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim();
  share.logs.unshift({
    ts: now(),
    event,
    ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 180),
  });
  if (share.logs.length > 200) share.logs.length = 200;
}

function publicComic(comic) {
  const cover = coverOf(comic);
  const chapters = sharedChapters(comic);
  const token = comic.share?.token;
  const withShare = (u) => (token ? `${u}${u.includes('?') ? '&' : '?'}share=${encodeURIComponent(token)}` : u);
  return {
    id: comic.id,
    title: displayName(comic),
    author: comic.author || '',
    artist: comic.artist || '',
    description: comic.description || '',
    tags: [...(comic.tags || []), ...(comic.tagEntries || []).map((t) => t.value)],
    status: comic.status,
    direction: comic.direction || 'ltr',
    language: comic.language || 'zh',
    coverUrl: cover?.url ? withShare(cover.url) : null,
    pageCount: chapters.reduce((n, c) => n + (c.pages?.length || 0), 0),
    chapters: chapters.map((c) => ({
      id: c.id,
      title: c.title,
      number: c.number ?? null,
      pageCount: c.pages?.length || 0,
      uploadedByName: c.uploadedBy
        ? loadDb().users.find((u) => u.id === c.uploadedBy)?.name || ''
        : '',
      pages: (c.pages || []).map((p) => ({
        id: p.id,
        file: p.file,
        width: p.width,
        height: p.height,
        url: withShare(`/api/files/${comic.id}/${c.id}/${p.file}`),
        thumbUrl: p.hasThumb ? withShare(`/api/thumbs/${comic.id}/${c.id}/${p.id}.webp`) : null,
      })),
    })),
    share: {
      allowDownload: !!comic.share?.allowDownload && comic.allowDownload !== false,
      expiresAt: comic.share?.expiresAt || null,
      hasPassword: !!comic.share?.passwordHash,
      chapterIds: comic.share?.chapterIds || [],
      partial: (comic.share?.chapterIds || []).length > 0,
    },
  };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/* 页面落盘统一复用 server/page-store.js：上传与合规批量导入共用一套命名 / 缩略图逻辑 */

/**
 * 用新图像数据替换页面文件。文件名变化以便浏览器缓存自动失效，
 * 同时刷新尺寸、缩略图与跨页标记。
 */
async function rewritePage(comic, chapter, page, buffer, ext) {
  const dir = chapterDir(comic.id, chapter.id);
  const oldFile = path.join(dir, page.file);
  const newName = `${page.id}_${Date.now().toString(36)}.${ext || extOf(page.file)}`;
  const newPath = path.join(dir, newName);
  await ensureDir(dir);
  await fsp.writeFile(newPath, buffer);

  const meta = await metadata(buffer);
  if (meta) {
    page.width = meta.width;
    page.height = meta.height;
  }
  page.wide = isSpread(page.width, page.height);
  const st = await fsp.stat(newPath).catch(() => null);
  page.size = st?.size || 0;
  page.file = newName;

  const thumb = await thumbnail(buffer);
  if (thumb) {
    const tdir = path.join(comicDir(comic.id), '_thumbs', chapter.id);
    await ensureDir(tdir);
    await fsp.writeFile(path.join(tdir, `${page.id}.webp`), thumb);
    page.hasThumb = true;
  }
  if (oldFile !== newPath) await fsp.rm(oldFile, { force: true });
  return page;
}

/** 收集页面编辑的作用范围 */
function editTargets(comic, chapter, page, scope) {
  if (scope === 'chapter') return chapter.pages.map((p) => ({ chapter, page: p }));
  if (scope === 'comic') {
    return comic.chapters.flatMap((c) => c.pages.map((p) => ({ chapter: c, page: p })));
  }
  return [{ chapter, page }];
}

function withPageUrls(comic, chapter) {
  return {
    ...chapter,
    pages: chapter.pages.map((p) => ({
      ...p,
      url: `/api/files/${comic.id}/${chapter.id}/${p.file}`,
      thumbUrl: p.hasThumb ? `/api/thumbs/${comic.id}/${chapter.id}/${p.id}.webp` : null,
    })),
  };
}

/** 归档导入会话目录 */
function sessionDir(sessionId) {
  return path.join(TMP_DIR, sessionId);
}

/**
 * EPUB 按阅读顺序重排：
 * 解析 META-INF/container.xml → OPF（manifest+spine），把 spine 引用的页面
 * 里出现的图片按顺序整理到 out/epub_pages/ 下并命名 0001.jpg、0002.jpg…，
 * 这样随后的自然排序 / 按目录分话逻辑无需感知 EPUB。
 * 解析失败时保持原样（兜底仍按文件名排序导入）。
 */
async function reorderEpubBySpine(outDir) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return m ? m[1] : '';
  };
  const resolveHref = (baseDir, href) => {
    let h = href.split('#')[0];
    try { h = decodeURIComponent(h); } catch { /* 保留原样 */ }
    const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
    for (const seg of h.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  };
  const readText = async (rel) => {
    try { return await fsp.readFile(path.join(outDir, rel), 'utf8'); } catch { return ''; }
  };
  try {
    const containerXml = await readText('META-INF/container.xml');
    let opfRel = (containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!opfRel) {
      const findOpf = async (d, depth = 0) => {
        if (depth > 4) return '';
        for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            const r = await findOpf(p, depth + 1);
            if (r) return r;
          } else if (/\.opf$/i.test(e.name)) return p;
        }
        return '';
      };
      const found = await findOpf(outDir);
      if (found) opfRel = path.relative(outDir, found).split(path.sep).join('/');
    }
    if (!opfRel) return;
    const opf = await readText(opfRel);
    if (!opf) return;
    const opfDir = opfRel.includes('/') ? opfRel.slice(0, opfRel.lastIndexOf('/')) : '';

    const manifest = new Map();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = attr(m[0], 'id');
      const href = attr(m[0], 'href');
      if (id && href) manifest.set(id, { href, type: attr(m[0], 'media-type').toLowerCase() });
    }

    // spine 顺序 → 图片相对路径列表（xhtml 页内 <img src> / <image xlink:href>）
    const ordered = [];
    const seen = new Set();
    const pushImg = async (zipPath) => {
      const baseName = zipPath.split('/').pop() || zipPath;
      if (!IMAGE_RE.test(baseName) || /\.svg$/i.test(baseName) || seen.has(zipPath)) return;
      try {
        await fsp.access(path.join(outDir, zipPath));
      } catch { return; }
      seen.add(zipPath);
      ordered.push(zipPath);
    };
    for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
      const id = attr(m[0], 'idref');
      const it = id ? manifest.get(id) : undefined;
      if (!it) continue;
      const docPath = resolveHref(opfDir, it.href);
      if (/image\//i.test(it.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(docPath)) {
        await pushImg(docPath);
        continue;
      }
      const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
      const html = /\.(x?html?)$/i.test(docPath) ? await readText(docPath) : '';
      if (!html) continue;
      for (const im of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) await pushImg(resolveHref(docDir, im[1]));
      for (const im of html.matchAll(/<image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi)) {
        if (!/^data:/i.test(im[1])) await pushImg(resolveHref(docDir, im[1]));
      }
    }
    if (!ordered.length) return;

    const destDir = path.join(outDir, 'epub_pages');
    await ensureDir(destDir);
    let i = 0;
    for (const rel of ordered) {
      i += 1;
      const src = path.join(outDir, rel);
      const extName = path.extname(rel).slice(1).toLowerCase() || 'jpg';
      await fsp.copyFile(src, path.join(destDir, `${String(i).padStart(4, '0')}.${extName}`)).catch(() => {});
    }
    // 只保留排好序的页面，其余散落文件清掉，避免混进导入清单
    const rawDir = `${outDir}_raw`;
    await fsp.rename(destDir, path.join(rawDir, 'epub_pages')).catch(async () => {
      await fsp.mkdir(rawDir, { recursive: true });
      await fsp.rename(destDir, path.join(rawDir, 'epub_pages')).catch(() => {});
    });
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.rename(path.join(rawDir, 'epub_pages'), path.join(outDir, 'epub_pages')).catch(() => {});
    await fsp.rm(rawDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    console.warn('[import] EPUB 顺序解析失败，按文件名排序导入:', err?.message);
  }
}

/** 读 EPUB 包内 OPF 的 Dublin Core 元数据 → ComicInfo 风格字段 */
async function epubMetaFrom(srcPath) {
  const AdmZip = await (async () => {
    try { return (await import('7z-wasm')).default; } catch { return null; }
  })();
  // 不引入新依赖：直接用 7z 把 OPF 解到内存目录再读
  const tmp = path.join(TMP_DIR, `epubmeta_${Date.now()}`);
  await ensureDir(tmp);
  try {
    await extractWith7z(srcPath, tmp);
    const find = async (d, name, depth = 0) => {
      if (depth > 4) return null;
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          const r = await find(p, name, depth + 1);
          if (r) return r;
        } else if (name.test(e.name)) return p;
      }
      return null;
    };
    const opfPath = await find(tmp, /\.opf$/i);
    if (!opfPath) return null;
    const opf = await fsp.readFile(opfPath, 'utf8');
    const dc = (tag) => {
      const m = opf.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const yearM = dc('dc:date').match(/\d{4}/);
    const info = {
      Title: dc('dc:title'),
      Writer: dc('dc:creator'),
      Publisher: dc('dc:publisher'),
      Summary: dc('dc:description'),
      Year: yearM ? yearM[0] : '',
    };
    Object.keys(info).forEach((k) => { if (!info[k]) delete info[k]; });
    return Object.keys(info).length ? info : null;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * PDF 导入：服务端用 pdf.js + canvas 把每一页渲染成 PNG，落到 outDir。
 * 与网站端浏览器里 pdf.js 渲染的效果一致，桌面端因此也能导入 PDF。
 * 文件名为 0001.png / 0002.png…，保证 scanImages 自然排序 = 页序。
 */
let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}
async function renderPdfToImages(srcPath, outDir, targetWidth = 1440) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await fsp.readFile(srcPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  await ensureDir(outDir);
  const pad = Math.max(4, String(doc.numPages).length);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(0.5, targetWidth / base.width));
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const name = `${String(i).padStart(pad, '0')}.png`;
    await fsp.writeFile(path.join(outDir, name), canvas.toBuffer('image/png'));
    page.cleanup();
  }
  await doc.destroy();
}

async function scanImages(dir) {
  const out = [];
  async function walk(d, rel) {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '__MACOSX') continue;
        await walk(p, r);
      } else if (IMAGE_RE.test(e.name)) {
        const st = await fsp.stat(p).catch(() => null);
        out.push({ path: r, name: e.name, size: st?.size || 0 });
      }
    }
  }
  await walk(dir, '');
  out.sort((a, b) => a.path.localeCompare(b.path, 'zh', { numeric: true }));
  return out;
}

/** 清理超过 6 小时未提交的解压会话 */
async function cleanupSessions() {
  const entries = await fsp.readdir(TMP_DIR).catch(() => []);
  const cutoff = now() - 6 * 3600 * 1000;
  for (const name of entries) {
    if (!name.startsWith('s_')) continue;
    const dir = path.join(TMP_DIR, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || st.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function cleanupTmp(file) {
  if (file?.path) await fsp.rm(file.path, { force: true });
}

/* ------------------------------ 漫画 CRUD ------------------------------ */

// 统一鉴权与逐条归属校验（对所有 /api/comics/:id* 生效）
app.use('/api/comics/:id', comicGuard);

app.get('/api/comics', (req, res) => {
  const db = loadDb();
  const comics = req.user
    ? db.comics.filter((c) => c.ownerId === req.user.id).map(summarize)
    : [];
  res.json({ comics, settings: db.settings, needLogin: !req.user });
});

app.post('/api/comics', requireUser, (req, res) => {
  const db = loadDb();
  const body = req.body || {};
  const t = now();
  const comic = {
    id: newId('c'),
    title: (body.title || '未命名漫画').trim(),
    author: body.author || '',
    artist: body.artist || '',
    description: body.description || '',
    tags: Array.isArray(body.tags) ? body.tags : [],
    status: body.status || 'ongoing',
    direction: body.direction || db.settings.defaultDirection || 'ltr',
    language: body.language || 'zh',
    favorite: false,
    cover: null,
    chapters: [],
    progress: null,
    share: null,
    publisher: body.publisher || '',
    year: body.year || null,
    rating: body.rating || null,
    ageRating: body.ageRating || '',
    comicInfo: body.comicInfo || null,
    ownerId: req.user.id,
    createdBy: req.user.id,
    scope: body.scope === 'community' ? 'community' : 'personal',
    visibility: body.visibility === 'public' ? 'public' : 'private',
    allowDownload: body.allowDownload !== false,
    aliases: [],
    tagEntries: [],
    covers: [],
    activeCoverId: null,
    activeAliasId: null,
    createdAt: t,
    updatedAt: t,
  };
  comic.category = 'other';
  comic.views = 0;
  comic.downloads = 0;
  comic.likes = [];
  comic.lastActivityAt = t;
  db.comics.unshift(comic);
  if (comic.scope === 'community') {
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title, kind: 'comic', count: 0,
      userId: req.user.id, userName: req.user.name,
    });
  }
  saveDbSoon();
  res.json({ ...summarize(comic), chapters: [] });
});

app.get('/api/comics/:id', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  res.json({
    ...summarize(comic),
    chapters: comic.chapters.map((c) => ({
      ...c,
      uploadedBy: c.uploadedBy || comic.createdBy || null,
      uploadedByName: c.uploadedBy
        ? loadDb().users.find((u) => u.id === c.uploadedBy)?.name || ''
        : '',
      pages: c.pages.map((p) => ({
        ...p,
        url: `/api/files/${comic.id}/${c.id}/${p.file}`,
        thumbUrl: p.hasThumb ? `/api/thumbs/${comic.id}/${c.id}/${p.id}.webp` : null,
      })),
    })),
  });
});

app.patch('/api/comics/:id', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const body = req.body || {};
  const wasCommunity = comic.scope === 'community';
  const fields = ['title', 'author', 'artist', 'description', 'tags', 'status', 'direction', 'language', 'favorite', 'cover', 'publisher', 'year', 'rating', 'ageRating', 'comicInfo', 'visibility', 'allowDownload', 'scope'];
  for (const f of fields) {
    if (body[f] !== undefined) comic[f] = body[f];
  }
  comic.updatedAt = now();
  comic.lastActivityAt = now();
  if (!wasCommunity && comic.scope === 'community') {
    const db = loadDb();
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title, kind: 'comic',
      count: (comic.chapters || []).length,
      userId: req.user?.id || comic.createdBy,
      userName: req.user?.name || '书库贡献者',
    });
  }
  saveDbSoon();
  res.json(summarize(comic));
});

app.delete('/api/comics/:id', async (req, res) => {
  const db = loadDb();
  const idx = db.comics.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '漫画不存在' });
  const [comic] = db.comics.splice(idx, 1);
  await removeComicFiles(comic.id);
  saveDbSoon();
  res.json({ ok: true });
});

app.post('/api/comics/:id/duplicate', async (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const db = loadDb();
  const t = now();
  const copy = {
    ...structuredClone(comic),
    id: newId('c'),
    title: `${comic.title}（副本）`,
    share: null,
    progress: null,
    ownerId: req.user.id,
    createdBy: req.user.id,
    scope: 'personal',
    visibility: 'private',
    activeCoverId: null,
    activeAliasId: null,
    createdAt: t,
    updatedAt: t,
    chapters: [],
  };
  for (const ch of comic.chapters) {
    const newChapterId = newId('ch');
    await ensureDir(chapterDir(copy.id, newChapterId));
    const pages = [];
    for (const p of ch.pages) {
      const src = path.join(chapterDir(comic.id, ch.id), p.file);
      const dst = path.join(chapterDir(copy.id, newChapterId), p.file);
      await fsp.copyFile(src, dst).catch(() => {});
      pages.push({ ...p });
    }
    copy.chapters.push({ ...ch, id: newChapterId, uploadedBy: req.user.id, pages });
  }
  db.comics.unshift(copy);
  saveDbSoon();
  res.json(summarize(copy));
});

/* ------------------------------ 章节 ------------------------------ */

app.post('/api/comics/:id/chapters', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const body = req.body || {};
  const chapter = {
    id: newId('ch'),
    title: (body.title || `第 ${comic.chapters.length + 1} 话`).trim(),
    number: body.number ?? comic.chapters.length + 1,
    pages: [],
    uploadedBy: req.user?.id || comic.createdBy || null,
    createdAt: now(),
  };
  if (body.index != null && body.index >= 0 && body.index < comic.chapters.length) {
    comic.chapters.splice(body.index, 0, chapter);
  } else {
    comic.chapters.push(chapter);
  }
  comic.updatedAt = now();
  comic.lastActivityAt = now();
  if (comic.scope === 'community') {
    const db = loadDb();
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title,
      chapterId: chapter.id, chapterTitle: chapter.title, kind: 'chapter', count: 0,
      userId: req.user?.id || comic.createdBy,
      userName: req.user?.name || '书库贡献者',
    });
  }
  saveDbSoon();
  res.json(comic.chapters);
});

app.patch('/api/comics/:id/chapters/:chapterId', (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const body = req.body || {};
  if (body.title !== undefined) chapter.title = body.title;
  if (body.number !== undefined) chapter.number = body.number;
  comic.updatedAt = now();
  saveDbSoon();
  res.json(comic.chapters);
});

app.delete('/api/comics/:id/chapters/:chapterId', async (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const idx = comic.chapters.findIndex((c) => c.id === req.params.chapterId);
  if (idx < 0) return res.status(404).json({ error: '章节不存在' });
  comic.chapters.splice(idx, 1);
  await removeChapterFiles(comic.id, req.params.chapterId);
  comic.updatedAt = now();
  saveDbSoon();
  res.json(comic.chapters);
});

app.put('/api/comics/:id/chapters/reorder', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: '缺少 order' });
  comic.chapters.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  comic.updatedAt = now();
  saveDbSoon();
  res.json(comic.chapters);
});

/* ------------------------------ 页面 ------------------------------ */

app.post('/api/comics/:id/chapters/:chapterId/pages', upload.array('files', 300), async (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) {
    for (const f of req.files || []) await cleanupTmp(f);
    return res.status(404).json({ error: '章节不存在' });
  }
  const insertAt = Number.isInteger(req.body?.index) ? Number(req.body.index) : chapter.pages.length;
  const added = [];
  for (const file of req.files || []) {
    if (!file.mimetype?.startsWith('image/') && !IMAGE_RE.test(file.originalname || '')) {
      await cleanupTmp(file);
      continue;
    }
    try {
      const page = await storePage(file.path, file.originalname, file.mimetype, comic.id, chapter.id);
      added.push(page);
    } catch (err) {
      console.error('[upload] 失败:', err.message);
      await cleanupTmp(file);
    }
  }
  chapter.pages.splice(insertAt, 0, ...added);
  comic.updatedAt = now();
  comic.lastActivityAt = now();
  if (comic.scope === 'community' && added.length) {
    const db = loadDb();
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title,
      chapterId: chapter.id, chapterTitle: chapter.title, kind: 'pages', count: added.length,
      userId: req.user?.id || comic.createdBy,
      userName: req.user?.name || '书库贡献者',
    });
  }
  saveDbSoon();
  res.json({
    chapter: {
      ...chapter,
      pages: chapter.pages.map((p) => ({
        ...p,
        url: `/api/files/${comic.id}/${chapter.id}/${p.file}`,
        thumbUrl: p.hasThumb ? `/api/thumbs/${comic.id}/${chapter.id}/${p.id}.webp` : null,
      })),
    },
    added: added.length,
  });
});

app.delete('/api/comics/:id/chapters/:chapterId/pages/:pageId', async (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const idx = chapter.pages.findIndex((p) => p.id === req.params.pageId);
  if (idx < 0) return res.status(404).json({ error: '页面不存在' });
  const [page] = chapter.pages.splice(idx, 1);
  await fsp.rm(path.join(chapterDir(comic.id, chapter.id), page.file), { force: true });
  await fsp.rm(path.join(comicDir(comic.id), '_thumbs', chapter.id, `${page.id}.webp`), { force: true });
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, pageCount: chapter.pages.length });
});

app.put('/api/comics/:id/chapters/:chapterId/pages/reorder', (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: '缺少 order' });
  chapter.pages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, pageCount: chapter.pages.length });
});

app.post('/api/comics/:id/chapters/:chapterId/pages/move', async (req, res) => {
  const comic = getComic(req.params.id);
  const from = getChapter(comic, req.params.chapterId);
  const to = getChapter(comic, req.body?.targetChapterId);
  if (!from || !to) return res.status(404).json({ error: '章节不存在' });
  const ids = new Set(req.body?.pageIds || []);
  const moving = from.pages.filter((p) => ids.has(p.id));
  from.pages = from.pages.filter((p) => !ids.has(p.id));
  await ensureDir(chapterDir(comic.id, to.id));
  for (const p of moving) {
    const src = path.join(chapterDir(comic.id, from.id), p.file);
    const dst = path.join(chapterDir(comic.id, to.id), p.file);
    await fsp.rename(src, dst).catch(async () => {
      await fsp.copyFile(src, dst).catch(() => {});
    });
    const ts = path.join(comicDir(comic.id), '_thumbs', from.id, `${p.id}.webp`);
    const td = path.join(comicDir(comic.id), '_thumbs', to.id, `${p.id}.webp`);
    await ensureDir(path.dirname(td));
    await fsp.rename(ts, td).catch(() => {});
    to.pages.push(p);
  }
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, moved: moving.length });
});

/* ------------------------------ 页面编辑：旋转 / 裁剪 / 拆分 / 合并 ------------------------------ */

app.post('/api/comics/:id/chapters/:chapterId/pages/:pageId/edit', async (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const page = chapter.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ error: '页面不存在' });
  const { rotate = 0, crop = null, scope = 'page' } = req.body || {};
  if (!hasSharp) return res.status(400).json({ error: '服务端未启用 sharp，无法编辑页面' });

  const targets = editTargets(comic, chapter, page, scope);
  let updated = 0;
  try {
    for (const t of targets) {
      const src = path.join(chapterDir(comic.id, t.chapter.id), t.page.file);
      const buf = await fsp.readFile(src);
      const out = await transformImage(buf, { rotate: Number(rotate) || 0, crop });
      await rewritePage(comic, t.chapter, t.page, out, extOf(t.page.file));
      updated += 1;
    }
  } catch (err) {
    console.error('[edit-page] 失败:', err);
    return res.status(500).json({ error: '处理失败: ' + err.message });
  }
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, updated, chapter: withPageUrls(comic, chapter) });
});

app.post('/api/comics/:id/chapters/:chapterId/pages/split', async (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!hasSharp) return res.status(400).json({ error: '服务端未启用 sharp，无法拆分跨页' });
  const { pageIds = null, rtl = false, minRatio = 1.15 } = req.body || {};

  const wanted = pageIds && pageIds.length ? new Set(pageIds) : null;
  const targets = chapter.pages.filter((p) => {
    if (wanted) return wanted.has(p.id);
    return p.wide || isSpread(p.width, p.height, Number(minRatio));
  });
  if (!targets.length) return res.status(400).json({ error: '没有检测到跨页（宽 > 高）的页面' });

  let split = 0;
  try {
    for (const page of targets) {
      const src = path.join(chapterDir(comic.id, chapter.id), page.file);
      const buf = await fsp.readFile(src);
      const [firstBuf, secondBuf] = await splitSpread(buf, !!rtl);
      const idx = chapter.pages.findIndex((p) => p.id === page.id);
      const secondId = newId('p');

      // 第一半沿用原页（保留 id 与位置），第二半插入其后
      await rewritePage(comic, chapter, page, firstBuf, 'jpg');
      const secondPage = {
        id: secondId,
        file: `${secondId}.jpg`,
        width: 0,
        height: 0,
        size: 0,
        hasThumb: false,
        wide: false,
        splitFrom: page.id,
      };
      const sMeta = await metadata(secondBuf);
      secondPage.width = sMeta?.width || 0;
      secondPage.height = sMeta?.height || 0;
      secondPage.wide = isSpread(secondPage.width, secondPage.height);
      await fsp.writeFile(path.join(chapterDir(comic.id, chapter.id), secondPage.file), secondBuf);
      const st = await fsp.stat(path.join(chapterDir(comic.id, chapter.id), secondPage.file)).catch(() => null);
      secondPage.size = st?.size || 0;
      const thumb = await thumbnail(secondBuf);
      if (thumb) {
        const tdir = path.join(comicDir(comic.id), '_thumbs', chapter.id);
        await ensureDir(tdir);
        await fsp.writeFile(path.join(tdir, `${secondId}.webp`), thumb);
        secondPage.hasThumb = true;
      }
      chapter.pages.splice(idx + 1, 0, secondPage);
      split += 1;
    }
  } catch (err) {
    console.error('[split] 失败:', err);
    return res.status(500).json({ error: '拆分失败: ' + err.message });
  }
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, split, chapter: withPageUrls(comic, chapter) });
});

app.post('/api/comics/:id/chapters/:chapterId/pages/merge', async (req, res) => {
  const comic = getComic(req.params.id);
  const chapter = getChapter(comic, req.params.chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!hasSharp) return res.status(400).json({ error: '服务端未启用 sharp，无法合并页面' });
  const { pageIds = [], rtl = false } = req.body || {};
  const wanted = new Set(pageIds);
  const picked = chapter.pages.filter((p) => wanted.has(p.id));
  if (picked.length < 2) return res.status(400).json({ error: '请至少选择 2 页进行合并' });

  let merged = 0;
  try {
    for (let i = 0; i + 1 < picked.length; i += 2) {
      const a = picked[i];
      const b = picked[i + 1];
      const bufA = await fsp.readFile(path.join(chapterDir(comic.id, chapter.id), a.file));
      const bufB = await fsp.readFile(path.join(chapterDir(comic.id, chapter.id), b.file));
      const out = await mergeSpread(bufA, bufB, !!rtl);
      await rewritePage(comic, chapter, a, out, 'jpg');
      // 删除被吸收的第二页
      const bi = chapter.pages.findIndex((p) => p.id === b.id);
      if (bi >= 0) chapter.pages.splice(bi, 1);
      await fsp.rm(path.join(chapterDir(comic.id, chapter.id), b.file), { force: true });
      await fsp.rm(path.join(comicDir(comic.id), '_thumbs', chapter.id, `${b.id}.webp`), { force: true });
      merged += 1;
    }
  } catch (err) {
    console.error('[merge] 失败:', err);
    return res.status(500).json({ error: '合并失败: ' + err.message });
  }
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, merged, chapter: withPageUrls(comic, chapter) });
});

/* ------------------------------ 封面 ------------------------------ */

app.post('/api/comics/:id/cover', upload.single('file'), async (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) {
    await cleanupTmp(req.file);
    return res.status(404).json({ error: '漫画不存在' });
  }
  const ext = extOf(req.file?.originalname) || 'jpg';
  const name = `cover_${nanoid(6)}.${ext}`;
  const dir = path.join(comicDir(comic.id), '_cover');
  await ensureDir(dir);
  await fsp.rename(req.file.path, path.join(dir, name)).catch(async () => {
    await fsp.copyFile(req.file.path, path.join(dir, name));
    await fsp.rm(req.file.path, { force: true });
  });
  comic.cover = { type: 'file', file: name };
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true, coverUrl: `/api/files/${comic.id}/_cover/${name}` });
});

app.post('/api/comics/:id/cover/page', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const { chapterId, pageId } = req.body || {};
  comic.cover = { type: 'page', chapterId, pageId };
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true });
});

/* ------------------------------ 用户头像 ------------------------------ */

app.post('/api/me/avatar', requireUser, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择一张图片' });
  if (!/^image\//.test(req.file.mimetype)) {
    await cleanupTmp(req.file);
    return res.status(400).json({ error: '头像只能是图片' });
  }
  const ext = extOf(req.file.originalname) || MIME_EXT[req.file.mimetype] || 'jpg';
  const dir = path.join(STORE_DIR, '_users', req.user.id);
  await ensureDir(dir);
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (f.startsWith('avatar.')) await fsp.rm(path.join(dir, f), { force: true });
  }
  const name = `avatar.${ext}`;
  await fsp.rename(req.file.path, path.join(dir, name)).catch(async () => {
    await fsp.copyFile(req.file.path, path.join(dir, name));
    await fsp.rm(req.file.path, { force: true });
  });
  // 关键修复：把头像地址写回用户记录并落库，否则前端（尤其桌面端刷新后）
  // 读到的 user.avatar 仍为旧值，表现为「头像改不了 / 显示错误」。
  const url = `/api/u/${req.user.id}/avatar`;
  req.user.avatar = url;
  saveDbSoon();
  res.json({ ok: true, url });
});

/* 头像公开访问，无需凭据（个人资料图本就该可见） */
app.get('/api/u/:uid/avatar', (req, res) => {
  const { uid } = req.params;
  if (!isSafeSegment(uid)) return res.status(400).json({ error: '非法路径' });
  const dir = path.join(STORE_DIR, '_users', uid);
  if (!fs.existsSync(dir)) return res.status(404).end();
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('avatar.'));
  if (!files.length) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(dir, files[0]));
});

/* ------------------------------ 阅读进度 ------------------------------ */

app.put('/api/comics/:id/progress', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const { chapterId, pageIndex } = req.body || {};
  comic.progress = { chapterId, pageIndex: Number(pageIndex) || 0, updatedAt: now() };
  comic.updatedAt = now();
  saveDbSoon();
  res.json({ ok: true });
});

/* ------------------------------ 分享 ------------------------------ */

app.post('/api/comics/:id/share', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const body = req.body || {};
  const share = comic.share || { token: nanoid(14), views: 0, logs: [] };
  share.enabled = body.enabled !== undefined ? !!body.enabled : true;
  share.allowDownload = body.allowDownload !== undefined ? !!body.allowDownload : true;
  share.token = share.token || nanoid(14);
  if (body.password !== undefined) {
    share.passwordHash = body.password ? hashPassword(body.password) : '';
  }
  if (body.expiresInDays !== undefined) {
    const days = Number(body.expiresInDays);
    share.expiresAt = days > 0 ? now() + days * 86400000 : null;
  }
  // 按话分享：null / 空数组 = 整本，否则只分享指定章节
  if (body.chapterIds !== undefined) {
    const ids = Array.isArray(body.chapterIds) ? body.chapterIds.filter(Boolean) : [];
    const valid = new Set(comic.chapters.map((c) => c.id));
    share.chapterIds = ids.filter((id) => valid.has(id));
  }
  share.updatedAt = now();
  comic.share = share;
  comic.updatedAt = now();
  saveDbSoon();
  res.json(summarize(comic).share);
});

/** 吊销：重新生成 token，旧链接立即失效 */
app.post('/api/comics/:id/share/rotate', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic || !comic.share) return res.status(404).json({ error: '还没有分享链接' });
  comic.share.token = nanoid(14);
  comic.share.updatedAt = now();
  if (req.body?.disable) comic.share.enabled = false;
  saveDbSoon();
  res.json(summarize(comic).share);
});

app.get('/api/comics/:id/share/logs', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  res.json({ logs: comic.share?.logs || [] });
});

app.delete('/api/comics/:id/share/logs', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (comic.share) comic.share.logs = [];
  saveDbSoon();
  res.json({ ok: true });
});

function shareAccess(req, res, next) {
  const comic = getComicByShareToken(req.params.token);
  if (!comic || !comic.share?.enabled) return res.status(404).json({ error: '分享不存在或已关闭' });
  if (comic.share.expiresAt && comic.share.expiresAt < now()) {
    return res.status(410).json({ error: '分享链接已过期' });
  }
  if (comic.share.passwordHash) {
    const provided = req.headers['x-share-password'] || req.query?.password || '';
    if (!provided || !safeEqual(hashPassword(provided), comic.share.passwordHash)) {
      return res.status(401).json({ error: '需要访问密码', needPassword: true });
    }
  }
  req.sharedComic = comic;
  next();
}

app.get('/api/share/:token', shareAccess, (req, res) => {
  const comic = req.sharedComic;
  comic.share.views = (comic.share.views || 0) + 1;
  logVisit(comic, req, 'view');
  saveDbSoon();
  res.json(publicComic(comic));
});

app.post('/api/share/:token/unlock', (req, res) => {
  const comic = getComicByShareToken(req.params.token);
  if (!comic?.share?.enabled) return res.status(404).json({ error: '分享不存在' });
  if (comic.share.expiresAt && comic.share.expiresAt < now()) {
    return res.status(410).json({ error: '分享链接已过期' });
  }
  const pwd = req.body?.password || '';
  if (!comic.share.passwordHash) return res.json({ ok: true });
  if (!safeEqual(hashPassword(pwd), comic.share.passwordHash)) {
    return res.status(401).json({ error: '密码不正确' });
  }
  res.json({ ok: true });
});

/* ------------------------------ 导出 ------------------------------ */

function pickChapters(comic, ids) {
  if (!ids) return comic.chapters;
  const set = new Set(String(ids).split(',').filter(Boolean));
  return comic.chapters.filter((c) => set.has(c.id));
}

function exportFilename(comic, chapters, all) {
  if (chapters.length === 1 && !all) {
    return `${comic.title} - ${chapters[0].title}`;
  }
  return comic.title;
}

app.get('/api/export/:comicId', assetGuard, async (req, res) => {
  const comic = getComic(req.params.comicId);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (comic.allowDownload === false && !req.isOwner) {
    return res.status(403).json({ error: '作者已关闭这本漫画的下载' });
  }
  const format = (req.query.format || 'cbz').toLowerCase();
  const chaptersRaw = req.query.chapters ? String(req.query.chapters) : null;
  const chapters = pickChapters(comic, chaptersRaw);
  if (!chapters.length) return res.status(400).json({ error: '没有可导出的章节' });
  comic.downloads = (Number(comic.downloads) || 0) + 1;
  comic.lastActivityAt = now();
  saveDbSoon();
  const filename = exportFilename(comic, chapters, !chaptersRaw);
  try {
    if (format === 'pdf') return await exportPdf(res, { comic, chapters, filename });
    if (format === 'epub') return await exportEpub(res, { comic, chapters, filename });
    return await exportArchive(res, { comic, chapters, format: format === 'zip' ? 'zip' : 'cbz', filename });
  } catch (err) {
    console.error('[export] 失败:', err);
    if (!res.headersSent) res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

app.get('/api/share/:token/export', shareAccess, async (req, res) => {
  const comic = req.sharedComic;
  if (!comic.share.allowDownload) return res.status(403).json({ error: '该分享未开启下载' });
  const format = (req.query.format || 'cbz').toLowerCase();
  const chaptersRaw = req.query.chapters ? String(req.query.chapters) : null;
  const chapters = pickChapters({ ...comic, chapters: sharedChapters(comic) }, chaptersRaw);
  logVisit(comic, req, `download:${format}`);
  saveDbSoon();
  if (!chapters.length) return res.status(400).json({ error: '没有可导出的章节' });
  comic.downloads = (Number(comic.downloads) || 0) + 1;
  comic.lastActivityAt = now();
  saveDbSoon();
  const filename = exportFilename(comic, chapters, !chaptersRaw);
  try {
    if (format === 'pdf') return await exportPdf(res, { comic, chapters, filename });
    if (format === 'epub') return await exportEpub(res, { comic, chapters, filename });
    return await exportArchive(res, { comic, chapters, format: format === 'zip' ? 'zip' : 'cbz', filename });
  } catch (err) {
    console.error('[export-share] 失败:', err);
    if (!res.headersSent) res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

/* ------------------------------ RAR / 7z 等压缩包导入（服务端解压） ------------------------------ */

async function findFileRecursive(dir, re) {
  async function walk(d) {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = await walk(p);
        if (hit) return hit;
      } else if (re.test(e.name)) {
        return p;
      }
    }
    return null;
  }
  return walk(dir);
}

/** 把磁盘上的一张图片复制进章节并生成缩略图 */
async function addImageToChapter(comic, chapter, src, originalName) {
  const ext = extOf(src);
  const pageId = newId('p');
  const dir = chapterDir(comic.id, chapter.id);
  await ensureDir(dir);
  const dst = path.join(dir, `${pageId}.${ext}`);
  await fsp.copyFile(src, dst);
  let width = 0;
  let height = 0;
  let hasThumb = false;
  try {
    const buf = await fsp.readFile(dst);
    const m = await metadata(buf);
    if (m) {
      width = m.width;
      height = m.height;
    }
    const thumb = await thumbnail(buf);
    if (thumb) {
      const tdir = path.join(comicDir(comic.id), '_thumbs', chapter.id);
      await ensureDir(tdir);
      await fsp.writeFile(path.join(tdir, `${pageId}.webp`), thumb);
      hasThumb = true;
    }
  } catch {
    /* ignore */
  }
  const st = await fsp.stat(dst).catch(() => null);
  chapter.pages.push({
    id: pageId,
    file: `${pageId}.${ext}`,
    width,
    height,
    size: st?.size || 0,
    hasThumb,
    wide: isSpread(width, height),
    name: originalName || path.basename(src),
  });
}

/** 第一步：上传压缩包 → 服务端解压 → 返回文件清单与元数据，供前端预览分话 */
app.post('/api/import/archive', requireUser, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '没有收到文件' });
  const original = file.originalname || 'archive.bin';
  const ext = extOf(original) || '7z';
  if (!SEVENZ_RE.test(original) && !EPUB_OK.test(original) && !PDF_OK.test(original)) {
    await cleanupTmp(file);
    return res.status(400).json({ error: `暂不支持的格式：.${ext}` });
  }

  const sessionId = newId('s');
  const dir = sessionDir(sessionId);
  const srcPath = path.join(dir, `_src.${ext}`);
  const outDir = path.join(dir, 'out');
  await ensureDir(dir);
  await fsp.rename(file.path, srcPath).catch(async () => {
    await fsp.copyFile(file.path, srcPath);
    await fsp.rm(file.path, { force: true });
  });

  try {
    if (/^pdf$/i.test(ext)) {
      // PDF 不是压缩包，逐页渲染成图片（与网站端 pdf.js 渲染一致）
      await renderPdfToImages(srcPath, outDir);
    } else {
      await extractWith7z(srcPath, outDir);
      // EPUB 是 zip 但内部有阅读顺序（OPF spine），7z 直接解出来是乱序文件。
      // 这里按 spine 把图片重命名成 0001- 前缀，让后续自然排序 = 书内阅读顺序。
      if (/^epub$/i.test(ext)) await reorderEpubBySpine(outDir);
    }
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    return res.status(400).json({ error: `解压失败：${err.message || err}` });
  }

  const files = await scanImages(outDir);
  if (!files.length) {
    await fsp.rm(dir, { recursive: true, force: true });
    return res.status(400).json({ error: '压缩包里没有找到图片' });
  }

  const xmlPath = await findFileRecursive(outDir, /comicinfo\.xml$/i);
  let info = null;
  if (xmlPath) {
    try {
      info = parseComicInfo(await fsp.readFile(xmlPath, 'utf8'));
    } catch {
      info = null;
    }
  }
  // EPUB：解包后 OPF 已被清理，直接从源文件读元数据
  if (!info && /^epub$/i.test(ext)) {
    info = await epubMetaFrom(srcPath).catch(() => null);
  }
  await fsp.rm(srcPath, { force: true });
  await cleanupSessions();

  res.json({
    sessionId,
    files,
    meta: info,
    fields: comicFieldsFromInfo(info) || {},
  });
});

/** 第二步：按前端确认好的分组落盘成章节 */
app.post('/api/import/archive/:sessionId/commit', requireUser, async (req, res) => {
  const dir = sessionDir(req.params.sessionId);
  if (!isSafeSegment(req.params.sessionId) || !fs.existsSync(dir)) {
    return res.status(404).json({ error: '导入会话已失效，请重新选择文件' });
  }
  const body = req.body || {};
  const groups = Array.isArray(body.groups) ? body.groups : [];
  if (!groups.length) return res.status(400).json({ error: '没有要导入的分组' });

  const db = loadDb();
  const t = now();
  let comic = body.comicId ? getComic(body.comicId) : null;
  if (!comic) {
    comic = {
      id: newId('c'),
      title: (body.title || '未命名漫画').trim(),
      author: body.author || '',
      artist: body.artist || '',
      description: body.description || '',
      tags: Array.isArray(body.tags) ? body.tags : [],
      status: 'ongoing',
      direction: body.direction || db.settings.defaultDirection || 'ltr',
      language: body.language || 'zh',
      favorite: false,
      cover: null,
      chapters: [],
      progress: null,
      share: null,
      publisher: body.publisher || '',
      year: body.year || null,
      rating: body.rating || null,
      ageRating: body.ageRating || '',
      comicInfo: body.comicInfo || null,
      ...ownershipFields(req, body),
      createdAt: t,
      updatedAt: t,
    };
    db.comics.unshift(comic);
  }

  const created = [];
  let index = comic.chapters.length;
  for (const g of groups) {
    const chapter = {
      id: newId('ch'),
      title: (g.title || `第 ${index + 1} 话`).trim(),
      number: index + 1,
      pages: [],
      uploadedBy: req.user?.id || comic.createdBy || null,
      createdAt: now(),
    };
    await ensureDir(chapterDir(comic.id, chapter.id));
    for (const rel of g.paths || []) {
      const src = path.join(dir, 'out', rel);
      if (!src.startsWith(path.join(dir, 'out'))) continue;
      if (!fs.existsSync(src)) continue;
      await addImageToChapter(comic, chapter, src, path.basename(rel));
    }
    // 按文件名自然排序，保证页序正确
    chapter.pages.sort((a, b) =>
      String(a.name || a.file).localeCompare(String(b.name || b.file), 'zh', { numeric: true }),
    );
    comic.chapters.push(chapter);
    created.push({ id: chapter.id, title: chapter.title, pageCount: chapter.pages.length });
    index += 1;
  }

  comic.updatedAt = now();
  comic.lastActivityAt = now();
  if (comic.scope === 'community') {
    recordUpload(db, {
      comicId: comic.id, comicTitle: comic.title,
      chapterId: created[0]?.id || null, chapterTitle: created[0]?.title || '', kind: 'pages',
      count: created.reduce((n, c) => n + c.pageCount, 0),
      userId: req.user.id, userName: req.user.name,
    });
  }
  saveDbSoon();
  await fsp.rm(dir, { recursive: true, force: true });
  res.json({ comic: summarize(comic), chapters: created });
});

/* ------------------------------ 从本地目录导入 ------------------------------ */

app.post('/api/import/folder', requireUser, async (req, res) => {
  if (!ALLOW_FS_IMPORT) return res.status(403).json({ error: '服务端目录导入已禁用' });
  const { dir, mode = 'folder', pagesPerChapter = 30, comicId, title } = req.body || {};
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: '缺少目录路径' });
  if (!fs.existsSync(dir)) return res.status(400).json({ error: '目录不存在' });

  const db = loadDb();
  const t = now();
  let comic = comicId ? getComic(comicId) : null;
  if (!comic) {
    comic = {
      id: newId('c'),
      title: (title || path.basename(dir) || '导入的漫画').trim(),
      author: '',
      artist: '',
      description: '',
      tags: [],
      status: 'ongoing',
      direction: db.settings.defaultDirection || 'ltr',
      language: 'zh',
      favorite: false,
      cover: null,
      chapters: [],
      progress: null,
      share: null,
      ...ownershipFields(req, req.body || {}),
      createdAt: t,
      updatedAt: t,
    };
    db.comics.unshift(comic);
  }

  const groups = [];
  if (mode === 'folder') {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && IMAGE_RE.test(e.name));
    if (files.length) groups.push({ title: null, files: files.map((f) => path.join(dir, f.name)) });
    for (const e of entries.filter((e) => e.isDirectory())) {
      const sub = path.join(dir, e.name);
      const subEntries = await fsp.readdir(sub, { withFileTypes: true }).catch(() => []);
      const subFiles = subEntries.filter((x) => x.isFile() && IMAGE_RE.test(x.name)).map((x) => path.join(sub, x.name));
      if (subFiles.length) groups.push({ title: e.name, files: subFiles });
    }
  } else {
    const walk = async (d) => {
      const out = [];
      const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (IMAGE_RE.test(e.name)) out.push(p);
      }
      return out;
    };
    const all = (await walk(dir)).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
    const per = Math.max(1, Number(pagesPerChapter) || 30);
    for (let i = 0; i < all.length; i += per) {
      groups.push({ title: null, files: all.slice(i, i + per) });
    }
  }

  if (!groups.length) return res.status(400).json({ error: '目录中没有找到图片' });

  const created = [];
  let index = comic.chapters.length;
  for (const g of groups) {
    const chapter = {
      id: newId('ch'),
      title: g.title || `第 ${index + 1} 话`,
      number: index + 1,
      pages: [],
      uploadedBy: req.user?.id || comic.createdBy || null,
      createdAt: now(),
    };
    await ensureDir(chapterDir(comic.id, chapter.id));
    for (const src of g.files) {
      const ext = extOf(src);
      const pageId = newId('p');
      const dst = path.join(chapterDir(comic.id, chapter.id), `${pageId}.${ext}`);
      await fsp.copyFile(src, dst).catch(() => {});
      let width = 0;
      let height = 0;
      let hasThumb = false;
      try {
        const buf = await fsp.readFile(dst);
        const m = await metadata(buf);
        if (m) {
          width = m.width;
          height = m.height;
        }
        const thumb = await thumbnail(buf);
        if (thumb) {
          const tdir = path.join(comicDir(comic.id), '_thumbs', chapter.id);
          await ensureDir(tdir);
          await fsp.writeFile(path.join(tdir, `${pageId}.webp`), thumb);
          hasThumb = true;
        }
      } catch {
        /* ignore */
      }
      const st = await fsp.stat(dst).catch(() => null);
      chapter.pages.push({
        id: pageId,
        file: `${pageId}.${ext}`,
        width,
        height,
        size: st?.size || 0,
        hasThumb,
        wide: isSpread(width, height),
        name: path.basename(src),
      });
    }
    comic.chapters.push(chapter);
    created.push({ id: chapter.id, title: chapter.title, pageCount: chapter.pages.length });
    index += 1;
  }

  comic.updatedAt = now();
  saveDbSoon();
  res.json({ comic: summarize(comic), chapters: created });
});

/* ------------------------------ 文件服务 ------------------------------ */

app.get('/api/files/:comicId/:chapterId/:file', assetGuard, (req, res) => {
  const { comicId, chapterId, file } = req.params;
  if (!isSafeSegment(comicId) || !isSafeSegment(chapterId) || !isSafeSegment(file)) {
    return res.status(400).json({ error: '非法路径' });
  }
  const full = path.join(STORE_DIR, comicId, chapterId, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

app.get('/api/thumbs/:comicId/:chapterId/:file', assetGuard, (req, res) => {
  const { comicId, chapterId, file } = req.params;
  if (!isSafeSegment(comicId) || !isSafeSegment(chapterId) || !isSafeSegment(file)) {
    return res.status(400).json({ error: '非法路径' });
  }
  const full = path.join(STORE_DIR, comicId, '_thumbs', chapterId, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '缩略图不存在' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

/* ------------------------------ 设置与统计 ------------------------------ */

app.get('/api/stats', async (req, res) => {
  const db = loadDb();
  const pageCount = db.comics.reduce(
    (n, c) => n + (c.chapters || []).reduce((m, ch) => m + (ch.pages?.length || 0), 0),
    0,
  );
  const stats = await dirStats(STORE_DIR);
  res.json({
    comicCount: db.comics.length,
    chapterCount: db.comics.reduce((n, c) => n + (c.chapters?.length || 0), 0),
    pageCount,
    storageBytes: stats.size,
    storageFiles: stats.files,
    hasSharp,
    archiveEngine: await engineStatus(),
  });
});

app.put('/api/settings', (req, res) => {
  const db = loadDb();
  db.settings = { ...db.settings, ...(req.body || {}) };
  saveDbSoon();
  res.json(db.settings);
});

/* ------------------------------ 账号 / 社区 / 广场 ------------------------------ */

registerSocial(app, {
  summarize,
  uploadSingle: upload.single('file'),
  uploadPlaza: plazaUpload.array('files', 12),
  extOf,
  nanoid,
});

/* 分类 / 排行 / 动态 / 上传记录 / 公告 / 软件下载 / 自动更新 / 合规导入 */
registerDiscovery(app);

/* 在线书源（通用规则化抓取，导入到个人书库） */
registerSources(app);
registerUpdates(app);

/* ------------------------ 可安装应用清单 & 客户端运行时 ------------------------ */

/**
 * 动态生成 PWA 清单。托管环境要求所有请求都带 sharecode，
 * 启动地址、图标与快捷方式必须按当前凭据拼接，
 * 否则「安装为应用 / 桌面软件」启动后会因 403 白屏。
 */
function sendManifest(res, code) {
  const q = code ? `?sharecode=${encodeURIComponent(code)}` : '';
  const icon = (name) => `/icons/${name}${q}`;
  const page = (p) => `${p}${q}`;
  const small = [{ src: icon('icon-192.png'), sizes: '192x192', type: 'image/png' }];
  res
    .type('application/manifest+json')
    .set('Cache-Control', 'no-cache')
    .json({
      id: '/',
      name: '漫画库 ComicVault',
      short_name: '漫画库',
      description: '漫画存储、分话管理、在线阅读、导出与分享',
      lang: 'zh-CN',
      start_url: page('/'),
      scope: '/',
      display: 'standalone',
      background_color: '#0f1115',
      theme_color: '#0f1115',
      orientation: 'any',
      categories: ['entertainment', 'books', 'productivity'],
      icons: [
        { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: icon('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: '我的书架', short_name: '书架', url: page('/'), icons: small },
        { name: '公共书库', short_name: '书库', url: page('/community'), icons: small },
        { name: '广场', short_name: '广场', url: page('/plaza'), icons: small },
      ],
    });
}

/**
 * 托管网关会消费掉 ?sharecode=，服务端读不到查询参数。
 * 前端因此把凭据同时放进路径（/pwa/<code>/manifest.webmanifest），
 * 保证安装后的启动地址、图标与快捷方式都带码，避免启动白屏。
 */
app.get(/^\/pwa\/([^/]+)\/manifest\.webmanifest$/, (req, res) => {
  let code = '';
  try {
    code = decodeURIComponent(String(req.params[0] || ''));
  } catch {
    /* 非法编码按无凭据处理 */
  }
  sendManifest(res, code);
});

app.get('/manifest.webmanifest', (req, res) => {
  sendManifest(res, typeof req.query.sharecode === 'string' ? req.query.sharecode : '');
});

/** 客户端（网页 / 安装应用 / 桌面软件）读取当前连接的服务端信息 */
app.get('/api/runtime', (_req, res) => {
  // 不回显服务器内部域名与磁盘路径；客户端以自身地址栏为准
  res.json({
    app: 'ComicVault',
    version: APP_VERSION,
    features: {
      pwa: true, desktop: true, community: true, share: true,
      discovery: true, ranking: true, activity: true, announcements: true, software: true,
      webtoon: true, chapterNav: true, shareLanding: true, multiImport: true,
    },
  });
});

/* ------------------------------ 静态资源 & SPA ------------------------------ */

/**
 * 发版脚本把最新安装包复制到 data/installers/，这里挂到 /files/ 供网站直接下载。
 * 放在 dist 之前：同名文件优先取最新成品；不存在的路径回落到 dist/files（旧 APK）。
 * data/ 不进 Git，所以仓库体积不会被几百 MB 安装包撑大。
 */
const installersDir = path.join(DATA_DIR, 'installers');
app.use('/files', express.static(installersDir, {
  index: false, maxAge: '1h', fallthrough: true,
  setHeaders: (res) => res.setHeader('Accept-Ranges', 'bytes'),
}));

const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error('[error]', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || '服务器错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[comic-vault] 服务已启动: http://localhost:${PORT}`);
  console.log(`[comic-vault] 数据目录: ${DATA_DIR}`);
  if (!hasSharp) console.warn('[comic-vault] 未启用 sharp，缩略图与 PDF 转码将降级');
  cleanupSessions().catch(() => {});
  warmup().then((ok) => {
    console.log(ok ? '[comic-vault] RAR/7z 解压引擎已就绪' : '[comic-vault] RAR/7z 解压引擎不可用');
  });
  // 后台填充公共书库示例漫画，不阻塞服务启动（只执行一次）
  setImmediate(() => {
    ensureSamples().catch((err) => console.error('[discovery] 示例生成失败:', err.message));
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      saveDb();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
