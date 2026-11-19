/**
 * 在线来源 · 书架与在线阅读（/api/online）。
 *
 * - 书架：把在线来源的漫画/小说收藏到个人书架（轻量收藏，不占书库空间），
 *   记录阅读进度，可随时「加入书库」转成可编辑的本地漫画/小说。
 * - 图片代理：源站图片带防盗链头经服务端转发，阅读器与封面直接可显示。
 * - 小说整本导入：源脚本给出 EPUB 下载信息 → 下载后走书库 EPUB 分章流程。
 */
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadDb, saveDbSoon, TMP_DIR } from './store.js';
import { requireUser } from './social.js';
import { getJsSource, jsComicDetail, jsChapterImages, jsImageHeaders, jsNovelDownload } from './js-sources.js';

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function now() { return Date.now(); }

/**
 * @param {object} helpers { epubChaptersFromDir, createNovelComic, extractWith7z, ensureDir }
 */
export function registerOnline(app, helpers) {
  const router = express.Router();

  /* ------------------------------ 书架 ------------------------------ */

  function shelfOf(db, userId) {
    if (!db.onlineShelf) db.onlineShelf = {};
    if (!db.onlineShelf[userId]) db.onlineShelf[userId] = [];
    return db.onlineShelf[userId];
  }

  // 我的书架
  router.get('/shelf', requireUser, (req, res) => {
    const db = loadDb();
    const items = shelfOf(db, req.user.id).map((it) => ({
      ...it,
      coverProxy: it.cover ? `/api/online/img?sid=${encodeURIComponent(it.sourceKey)}&u=${encodeURIComponent(it.cover)}` : '',
    }));
    res.json({ items });
  });

  // 收藏到书架
  router.post('/shelf', requireUser, (req, res) => {
    const b = req.body || {};
    const source = getJsSource(b.sourceId);
    if (!source) return res.status(404).json({ error: '来源不存在' });
    if (!b.bookId || !b.title) return res.status(400).json({ error: '缺少书籍信息' });
    const db = loadDb();
    const shelf = shelfOf(db, req.user.id);
    const key = `${source.key}:${b.bookId}`;
    let item = shelf.find((x) => x.key === key);
    if (!item) {
      item = {
        id: `o_${now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        key,
        sourceKey: source.key,
        sourceName: source.name,
        bookId: String(b.bookId),
        title: String(b.title).slice(0, 120),
        cover: String(b.cover || ''),
        author: String(b.author || '').slice(0, 60),
        kind: b.kind === 'novel' || source.mediaType === 'novel' ? 'novel' : 'comic',
        chaptersTotal: Number(b.chaptersTotal) || 0,
        progress: null,
        addedAt: now(),
      };
      shelf.unshift(item);
      saveDbSoon();
    } else {
      item.title = item.title || b.title;
      item.cover = item.cover || b.cover || '';
      item.author = item.author || b.author || '';
      if (b.chaptersTotal) item.chaptersTotal = Number(b.chaptersTotal) || item.chaptersTotal;
      saveDbSoon();
    }
    res.json({ ok: true, item });
  });

  // 移出书架
  router.delete('/shelf/:id', requireUser, (req, res) => {
    const db = loadDb();
    const shelf = shelfOf(db, req.user.id);
    const i = shelf.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '书架里没有这条收藏' });
    shelf.splice(i, 1);
    saveDbSoon();
    res.json({ ok: true });
  });

  // 阅读进度（书架「上次读到」）
  router.put('/shelf/:id/progress', requireUser, (req, res) => {
    const db = loadDb();
    const item = shelfOf(db, req.user.id).find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: '书架里没有这条收藏' });
    const b = req.body || {};
    item.progress = {
      chapterUrl: String(b.chapterUrl || ''),
      chapterTitle: String(b.chapterTitle || ''),
      pageIndex: Math.max(0, Number(b.pageIndex) || 0),
      updatedAt: now(),
    };
    saveDbSoon();
    res.json({ ok: true });
  });

  /* ------------------------------ 在线阅读 ------------------------------ */

  // 某一话的图片（已换成服务端代理地址）
  router.post('/:sourceKey/chapter', requireUser, async (req, res) => {
    const source = getJsSource(req.params.sourceKey);
    if (!source) return res.status(404).json({ error: '来源不存在' });
    const bookId = String(req.body?.bookId || '');
    const chapterPath = String(req.body?.chapterUrl || '');
    if (!bookId || !chapterPath) return res.status(400).json({ error: '缺少书籍或章节标识' });
    try {
      const { images } = await jsChapterImages(source, bookId, chapterPath);
      res.json({
        images: images.map((u) => `/api/online/img?sid=${encodeURIComponent(source.key)}&u=${encodeURIComponent(u)}`),
        count: images.length,
      });
    } catch (err) {
      res.status(502).json({ error: err?.message || '章节读取失败' });
    }
  });

  // 图片代理：带源站防盗链头转发，阅读器/封面直接用
  router.get('/img', async (req, res) => {
    const source = getJsSource(String(req.query.sid || ''));
    const url = String(req.query.u || '');
    if (!source || !/^https?:\/\//i.test(url)) return res.status(400).end('bad request');
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      const r = await fetch(url, {
        headers: { 'User-Agent': UA_DEFAULT, ...(jsImageHeaders(source, url) || {}) },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end('upstream error');
      const ct = r.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).end('proxy error');
    }
  });

  /* ------------------------------ 加入书库 ------------------------------ */

  // 漫画整本 / 多话导入由前端逐话调 /api/sources/import 完成。
  // 小说整本：下载 EPUB → 自动分章入库（v3.4.0.14.0 的 EPUB 秒级流程）。
  router.post('/:sourceKey/import-book', requireUser, async (req, res) => {
    const source = getJsSource(req.params.sourceKey);
    if (!source) return res.status(404).json({ error: '来源不存在' });
    const bookId = String(req.body?.bookId || '');
    if (!bookId) return res.status(400).json({ error: '缺少书籍标识' });
    try {
      const dl = await jsNovelDownload(source, bookId);
      if (!dl) return res.status(400).json({ error: '这个来源暂不支持整本导入，请逐话导入' });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 300000);
      const r = await fetch(dl.url, {
        headers: { 'User-Agent': UA_DEFAULT, ...(dl.headers || {}) },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('下载内容为空');
      const tmp = path.join(TMP_DIR, `online-${source.key}-${bookId}-${Date.now()}.epub`);
      await fsp.mkdir(TMP_DIR, { recursive: true });
      await fsp.writeFile(tmp, buf);
      try {
        const tmpDir = path.join(TMP_DIR, `novel_${bookId}_${Date.now()}`);
        await helpers.ensureDir(tmpDir);
        const outDir = path.join(tmpDir, 'out');
        await helpers.extractWith7z(tmp, outDir);
        const parsed = await helpers.epubChaptersFromDir(outDir);
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        if (parsed.kind !== 'novel') throw new Error('这本 EPUB 没有解析出正文');
        const detail = await jsComicDetail(source, bookId).catch(() => ({}));
        if (parsed.title && !parsed.author) parsed.author = detail.author || '';
        if (!parsed.title) parsed.title = detail.title || `在线小说 ${bookId}`;
        const comic = await helpers.createNovelComic(req, parsed);
        return res.json({ kind: 'novel', comic });
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    } catch (err) {
      res.status(502).json({ error: err?.message || '整本导入失败' });
    }
  });

  app.use('/api/online', router);
}
