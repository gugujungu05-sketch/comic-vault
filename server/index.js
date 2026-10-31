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
import { metadata, thumbnail, hasSharp } from './media.js';

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
    progress: comic.progress || null,
    share: comic.share
      ? {
          enabled: !!comic.share.enabled,
          token: comic.share.token,
          allowDownload: !!comic.share.allowDownload,
          expiresAt: comic.share.expiresAt || null,
          hasPassword: !!comic.share.passwordHash,
          views: comic.share.views || 0,
        }
      : { enabled: false, token: null, allowDownload: true, expiresAt: null, hasPassword: false, views: 0 },
    createdAt: comic.createdAt,
    updatedAt: comic.updatedAt,
  };
}

function publicComic(comic) {
  const cover = coverOf(comic);
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
    pageCount: (comic.chapters || []).reduce((n, c) => n + (c.pages?.length || 0), 0),
    chapters: (comic.chapters || []).map((c) => ({
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
  return { id: pageId, file: `${pageId}.${ext}`, width, height, size: stat?.size || 0, hasThumb };
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
  const fields = ['title', 'author', 'artist', 'description', 'tags', 'status', 'direction', 'language', 'favorite', 'cover'];
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
  const share = comic.share || { token: nanoid(14), views: 0 };
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
  share.updatedAt = now();
  comic.share = share;
  comic.updatedAt = now();
  saveDbSoon();
  res.json(summarize(comic).share);
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
  const chapters = pickChapters(comic, chaptersRaw);
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
