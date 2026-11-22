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
import { getJsSource, jsComicDetail, jsChapterImages, jsImageHeaders, jsImageDecode, jsNovelDownload } from './js-sources.js';
import { normalizeSourceImage } from './media.js';

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function now() { return Date.now(); }

const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 逐章正文源（lnovel/哔哩轻小说）：抓全部卷章节正文，实时生成标准 EPUB Buffer。
 *  lnovel API：详情 /api/bili/novel/{nid} → volumes[].vid → /api/bili/novel/{nid}/vol/{vid} → chapters[].cid → /api/bili/novel/{nid}/chapter/{cid} */
async function buildTextNovelEpub(source, bookId, helpers) {
  const API = String(source.baseUrl || 'https://lnovel.animes.garden').replace(/\/+$/, '');
  const getJson = async (p) => {
    const r = await fetch(API + p, { headers: { 'User-Agent': UA_DEFAULT, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('lnovel 请求失败 HTTP ' + r.status);
    const j = await r.json();
    if (j && j.ok === false) throw new Error(j.message || 'lnovel 接口错误');
    return j;
  };
  const info = (await getJson('/api/bili/novel/' + encodeURIComponent(bookId))).data || {};
  const title = String(info.name || '在线小说');
  const author = (info.authors || []).map((a) => a.name).filter(Boolean).join('、');
  const volumes = Array.isArray(info.volumes) ? info.volumes : [];
  if (!volumes.length) throw new Error('这本书没有可用的卷');

  const chapters = []; // {title, html}
  for (const vol of volumes) {
    const vid = vol.vid;
    if (!vid) continue;
    let vd;
    try { vd = ((await getJson(`/api/bili/novel/${bookId}/vol/${vid}`)).data) || {}; } catch { continue; }
    const list = Array.isArray(vd.chapters) ? vd.chapters : [];
    for (const c of list) {
      const cid = c.cid;
      if (!cid) continue;
      let body = '';
      try { body = String(((await getJson(`/api/bili/novel/${bookId}/chapter/${cid}`)).data || {}).content || ''); } catch { continue; }
      if (!body.trim()) continue;
      chapters.push({ title: String(c.title || '正文'), html: body });
    }
  }
  if (!chapters.length) throw new Error('这本书没有抓取到章节正文');

  // 用 archiver 生成标准 EPUB（mimetype 必须第一个且不压缩）
  const archiver = (await import('archiver')).default;
  const chunks = [];
  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { arc.on('end', resolve); arc.on('error', reject); });
  arc.append('application/epub+zip', { name: 'mimetype', store: true });

  const xhtml = chapters.map((c, i) => {
    const paras = String(c.html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xml(c.title)}</title><meta charset="utf-8"/></head><body><h2>${xml(c.title)}</h2>${paras}</body></html>`;
  });
  const names = xhtml.map((_, i) => `chapter_${String(i + 1).padStart(4, '0')}.xhtml`);
  const container = `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  arc.append(container, { name: 'META-INF/container.xml' });
  const manifest = names.map((n, i) => `<item id="c${i}" href="${n}" media-type="application/xhtml+xml"/>`).join('');
  const spine = names.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author)}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="bookid">novel-${bookId}</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;
  arc.append(opf, { name: 'OEBPS/content.opf' });
  const navPoints = chapters.map((c, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${xml(c.title)}</text></navLabel><content src="${names[i]}"/></navPoint>`).join('');
  const ncx = `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="novel-${bookId}"/></head><docTitle><text>${xml(title)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`;
  arc.append(ncx, { name: 'OEBPS/toc.ncx' });
  names.forEach((n, i) => arc.append(xhtml[i], { name: 'OEBPS/' + n }));
  await arc.finalize();
  await done;
  return Buffer.concat(chunks);
}

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
  // 未登录也可读：在线来源浏览 / 阅读属于公开只读内容，登录态丢失不再导致「不能看」
  router.post('/:sourceKey/chapter', async (req, res) => {
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
      const ih = jsImageHeaders(source, url) || {};
      if (!ih.Referer && !ih.referer) ih.Referer = `${source.baseUrl || 'https://' + new URL(url).host}/`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA_DEFAULT, ...ih },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end('upstream error');
      let ct = r.headers.get('content-type') || 'image/jpeg';
      // 部分源站返回 application/octet-stream，浏览器 <img> 不认：按 URL 扩展名纠正
      if (!ct.startsWith('image/')) {
        const m = /\.(jpe?g|png|webp|gif|avif|bmp)(?=\?|$)/i.exec(url);
        if (m) ct = `image/${m[1].toLowerCase().replace('jpeg', 'jpeg').replace('jpg', 'jpeg')}`;
        else ct = 'image/jpeg';
      }
      let buf = Buffer.from(await r.arrayBuffer());
      // 爱漫画等源站对图片字节做混淆（XOR+SHIFT），直接转发是破图；按书源声明还原，
      // 并把 avif/heif 统一转 JPEG，避免老浏览器与 octet-stream 兼容问题。
      try {
        const norm = await normalizeSourceImage(buf, jsImageDecode(source), { forceJpeg: true });
        buf = norm.buf;
        ct = norm.mime;
      } catch { /* 归一化失败时回退原始字节 */ }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
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
      let buf;
      if (dl.textNovel) {
        // 逐章正文源（如哔哩轻小说 lnovel）：抓取所有卷/章节正文，实时生成标准 EPUB
        buf = await buildTextNovelEpub(source, bookId, helpers);
      } else {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 300000);
        const r = await fetch(dl.url, {
          headers: { 'User-Agent': UA_DEFAULT, ...(dl.headers || {}) },
          signal: ac.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      }
      if (!buf || !buf.length) throw new Error('下载内容为空');
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
        // 在线小说封面：优先书源详情里的封面 URL（带回源站防盗链头），让入库后有真实封面
        const detailCover = detail?.cover || (source.mediaType === 'novel' ? '' : '');
        if (detailCover && /^https?:\/\//i.test(detailCover)) {
          try {
            const ih = jsImageHeaders(source, detailCover) || {};
            parsed.cover = detailCover;
            parsed.coverHeaders = { 'User-Agent': UA_DEFAULT, ...ih };
          } catch { /* 无防盗链头时直接抓 */ }
        }
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
