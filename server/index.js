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
  ROOT,
  removeComicFiles,
  removeChapterFiles,
  dirStats,
} from './store.js';
import { exportArchive, exportPdf, exportEpub, safeName, extOf } from './exporters.js';
import { metadata, thumbnail, hasSharp, transformImage, splitSpread, mergeSpread, isSpread } from './media.js';
import { extractWith7z, warmup, engineStatus, SEVENZ_RE } from './archive.js';
import { parseComicInfo, comicFieldsFromInfo } from './comicinfo.js';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ALLOW_FS_IMPORT = process.env.CV_ALLOW_FS_IMPORT !== '0';

app.use(express.json({ limit: '20mb' }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024, files: 300 },
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

function summarize(comic) {
  const cover = coverOf(comic);
  const pageCount = (comic.chapters || []).reduce((n, c) => n + (c.pages?.length || 0), 0);
  return {
    id: comic.id,
    title: comic.title,
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
  return {
    id: comic.id,
    title: comic.title,
    author: comic.author || '',
    artist: comic.artist || '',
    description: comic.description || '',
    tags: comic.tags || [],
    status: comic.status,
    direction: comic.direction || 'ltr',
    language: comic.language || 'zh',
    coverUrl: cover?.url || null,
    pageCount: chapters.reduce((n, c) => n + (c.pages?.length || 0), 0),
    chapters: chapters.map((c) => ({
      id: c.id,
      title: c.title,
      number: c.number ?? null,
      pageCount: c.pages?.length || 0,
      pages: (c.pages || []).map((p) => ({
        id: p.id,
        file: p.file,
        width: p.width,
        height: p.height,
        url: `/api/files/${comic.id}/${c.id}/${p.file}`,
        thumbUrl: p.hasThumb ? `/api/thumbs/${comic.id}/${c.id}/${p.id}.webp` : null,
      })),
    })),
    share: {
      allowDownload: !!comic.share?.allowDownload,
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

/** 把上传的临时文件落盘为正式页面，并生成缩略图 */
async function storePage(tmpPath, originalName, mimeType, comicId, chapterId) {
  let ext = extOf(originalName);
  if (!MIME_EXT[mimeType] && !/^[a-z0-9]{2,5}$/.test(ext)) ext = 'jpg';
  if (mimeType && MIME_EXT[mimeType] && !IMAGE_RE.test(originalName || '')) ext = MIME_EXT[mimeType];
  ext = (ext || 'jpg').toLowerCase();

  const pageId = newId('p');
  const dir = chapterDir(comicId, chapterId);
  await ensureDir(dir);
  const target = path.join(dir, `${pageId}.${ext}`);
  await fsp.rename(tmpPath, target).catch(async () => {
    await fsp.copyFile(tmpPath, target);
    await fsp.rm(tmpPath, { force: true });
  });

  let width = 0;
  let height = 0;
  let hasThumb = false;
  try {
    const buf = await fsp.readFile(target);
    const meta = await metadata(buf);
    if (meta) {
      width = meta.width;
      height = meta.height;
    }
    const thumb = await thumbnail(buf);
    if (thumb) {
      const tdir = path.join(comicDir(comicId), '_thumbs', chapterId);
      await ensureDir(tdir);
      await fsp.writeFile(path.join(tdir, `${pageId}.webp`), thumb);
      hasThumb = true;
    }
  } catch {
    /* 元数据失败不影响导入 */
  }

  const stat = await fsp.stat(target).catch(() => null);
  return {
    id: pageId,
    file: `${pageId}.${ext}`,
    width,
    height,
    size: stat?.size || 0,
    hasThumb,
    wide: isSpread(width, height),
  };
}

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

app.get('/api/comics', (req, res) => {
  const db = loadDb();
  res.json({ comics: db.comics.map(summarize), settings: db.settings });
});

app.post('/api/comics', (req, res) => {
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
    createdAt: t,
    updatedAt: t,
  };
  db.comics.unshift(comic);
  saveDbSoon();
  res.json(comic);
});

app.get('/api/comics/:id', (req, res) => {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  res.json({
    ...summarize(comic),
    chapters: comic.chapters.map((c) => ({
      ...c,
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
  const fields = ['title', 'author', 'artist', 'description', 'tags', 'status', 'direction', 'language', 'favorite', 'cover', 'publisher', 'year', 'rating', 'ageRating', 'comicInfo'];
  for (const f of fields) {
    if (body[f] !== undefined) comic[f] = body[f];
  }
  comic.updatedAt = now();
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
    copy.chapters.push({ ...ch, id: newChapterId, pages });
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
    createdAt: now(),
  };
  if (body.index != null && body.index >= 0 && body.index < comic.chapters.length) {
    comic.chapters.splice(body.index, 0, chapter);
  } else {
    comic.chapters.push(chapter);
  }
  comic.updatedAt = now();
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

app.get('/api/export/:comicId', async (req, res) => {
  const comic = getComic(req.params.comicId);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const format = (req.query.format || 'cbz').toLowerCase();
  const chaptersRaw = req.query.chapters ? String(req.query.chapters) : null;
  const chapters = pickChapters(comic, chaptersRaw);
  if (!chapters.length) return res.status(400).json({ error: '没有可导出的章节' });
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
app.post('/api/import/archive', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '没有收到文件' });
  const original = file.originalname || 'archive.bin';
  const ext = extOf(original) || '7z';
  if (!SEVENZ_RE.test(original)) {
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
    await extractWith7z(srcPath, outDir);
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
app.post('/api/import/archive/:sessionId/commit', async (req, res) => {
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
  saveDbSoon();
  await fsp.rm(dir, { recursive: true, force: true });
  res.json({ comic: summarize(comic), chapters: created });
});

/* ------------------------------ 从本地目录导入 ------------------------------ */

app.post('/api/import/folder', async (req, res) => {
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

app.get('/api/files/:comicId/:chapterId/:file', (req, res) => {
  const { comicId, chapterId, file } = req.params;
  if (!isSafeSegment(comicId) || !isSafeSegment(chapterId) || !isSafeSegment(file)) {
    return res.status(400).json({ error: '非法路径' });
  }
  const full = path.join(STORE_DIR, comicId, chapterId, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

app.get('/api/thumbs/:comicId/:chapterId/:file', (req, res) => {
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

/* ------------------------------ 静态资源 & SPA ------------------------------ */

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
  console.log(`[comic-vault] 数据目录: ${path.join(ROOT, 'data')}`);
  if (!hasSharp) console.warn('[comic-vault] 未启用 sharp，缩略图与 PDF 转码将降级');
  cleanupSessions().catch(() => {});
  warmup().then((ok) => {
    console.log(ok ? '[comic-vault] RAR/7z 解压引擎已就绪' : '[comic-vault] RAR/7z 解压引擎不可用');
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
