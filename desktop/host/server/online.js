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
  // 并发限流工具（通用）
  const mapLimit = async (items, limit, worker) => {
    const out = new Array(items.length);
    let idx = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try { out[i] = await worker(items[i], i); } catch { out[i] = null; }
      }
    });
    await Promise.all(runners);
    return out;
  };

  let title = '', author = '', info = {}, chapters = [];

  // 通用适配器：源脚本自带 textNovelCatalog / textNovelChapter（再漫画轻小说、拷贝轻小说等）
  if (source.comic && typeof source.comic.textNovelCatalog === 'function') {
    const cat = await source.comic.textNovelCatalog(bookId);
    title = String(cat.title || '在线小说');
    author = String(cat.author || '');
    info = { cover: cat.cover || '', name: title };
    const refs = [];
    for (const v of (cat.volumes || [])) for (const c of (v.chapters || [])) {
      refs.push({ id: c.id, title: c.title, volumeId: v.id });
    }
    if (!refs.length) throw new Error('这本书没有可用的章节');
    const bodies = await mapLimit(refs, 10, async (c) => {
      try { return await source.comic.textNovelChapter(bookId, c.id, c.volumeId); } catch { return ''; }
    });
    for (let i = 0; i < refs.length; i++) {
      if (!bodies[i] || !bodies[i].trim()) continue;
      chapters.push({ title: String(refs[i].title || '正文'), html: bodies[i] });
    }
    if (!chapters.length) throw new Error('这本书没有抓取到章节正文');
  } else {
    // 原有 lnovel / 哔哩轻小说适配器
    const API = String(source.baseUrl || 'https://lnovel.animes.garden').replace(/\/+$/, '');
    const getJson = async (p) => {
      const r = await fetch(API + p, { headers: { 'User-Agent': UA_DEFAULT, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('lnovel 请求失败 HTTP ' + r.status);
      const j = await r.json();
      if (j && j.ok === false) throw new Error(j.message || 'lnovel 接口错误');
      return j;
    };
    info = (await getJson('/api/bili/novel/' + encodeURIComponent(bookId))).data || {};
    title = String(info.name || '在线小说');
    author = (info.authors || []).map((a) => a.name).filter(Boolean).join('、');
    const volumes = Array.isArray(info.volumes) ? info.volumes : [];
    if (!volumes.length) throw new Error('这本书没有可用的卷');
    const volData = await mapLimit(volumes.filter((v) => v && v.vid), 6, async (vol) => {
      try { return ((await getJson(`/api/bili/novel/${bookId}/vol/${vol.vid}`)).data) || {}; } catch { return {}; }
    });
    const refs = [];
    for (const vd of volData) for (const c of (Array.isArray(vd?.chapters) ? vd.chapters : [])) {
      if (c && c.cid) refs.push(c);
    }
    const bodies = await mapLimit(refs, 10, async (c) => {
      try { return String(((await getJson(`/api/bili/novel/${bookId}/chapter/${c.cid}`)).data || {}).content || ''); } catch { return ''; }
    });
    for (let i = 0; i < refs.length; i++) {
      const body = bodies[i];
      if (!body || !body.trim()) continue;
      chapters.push({ title: String(refs[i].title || '正文'), html: body });
    }
    if (!chapters.length) throw new Error('这本书没有抓取到章节正文');
  }

  // 插图本地化：把正文里的远程 <img src> 下载进 EPUB 包内，重写为相对路径。
  // 这样 epubChaptersFromDir 走本地文件（不再二次联网），插图能稳定落盘显示。
  const remoteImgs = new Map(); // url -> 包内文件名
  for (const ch of chapters) {
    ch.html = String(ch.html).replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (full, src) => {
      if (!/^https?:\/\//i.test(src)) return full;
      if (!remoteImgs.has(src)) {
        const ext = (src.split('?')[0].match(/\.(jpe?g|png|webp|gif|bmp)(?=\?|$)/i) || [])[1] || 'jpg';
        remoteImgs.set(src, `illus_${remoteImgs.size + 1}.${ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase()}`);
      }
      return full.replace(src, remoteImgs.get(src));
    });
  }
  const imgBuffers = await mapLimit([...remoteImgs.entries()], 8, async ([url, name]) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { headers: { 'User-Agent': UA_DEFAULT, 'Referer': new URL(url).origin + '/' }, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > 32 ? { name, buf } : null;
    } catch { return null; }
  });

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
  // 插图写入 EPUB 包内，并在 manifest 登记（封面也一起嵌入，保证原书封面随书入库）
  const goodImgs = imgBuffers.filter(Boolean);
  goodImgs.forEach((im, k) => arc.append(im.buf, { name: `OEBPS/${im.name}` }));
  const imgManifest = goodImgs.map((im, k) => `<item id="im${k}" href="${im.name}" media-type="image/${im.name.split('.').pop() === 'jpg' ? 'jpeg' : im.name.split('.').pop()}"/>`).join('');
  // 原书封面：优先用详情里的封面 URL 下载嵌入
  let coverName = '';
  const infoCover = info.cover || (info.authors && info.image) || '';
  if (/^https?:\/\//i.test(String(infoCover))) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
      const cr = await fetch(String(infoCover), { headers: { 'User-Agent': UA_DEFAULT, 'Referer': new URL(infoCover).origin + '/' }, signal: ctl.signal });
      clearTimeout(timer);
      if (cr.ok) {
        const cbuf = Buffer.from(await cr.arrayBuffer());
        if (cbuf.length > 1024) {
          const ext = (String(infoCover).split('?')[0].match(/\.(jpe?g|png|webp|gif)(?=$)/i) || [])[1] || 'jpg';
          coverName = `cover.${ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase()}`;
          arc.append(cbuf, { name: `OEBPS/${coverName}` });
        }
      }
    } catch { /* 封面下载失败不影响正文 */ }
  }
  const coverMeta = coverName ? `<meta name="cover" content="coverimg"/>` : '';
  const coverManifest = coverName ? `<item id="coverimg" href="${coverName}" media-type="image/${coverName.split('.').pop() === 'jpg' ? 'jpeg' : coverName.split('.').pop()}"/>` : '';
  const manifest = names.map((n, i) => `<item id="c${i}" href="${n}" media-type="application/xhtml+xml"/>`).join('') + imgManifest + coverManifest;
  const spine = names.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author)}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="bookid">novel-${bookId}</dc:identifier>${coverMeta}</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;
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
      // 老数据没有 favorite 字段：默认视为收藏，平滑迁移（新逻辑会逐步写入真实值）
      favorite: it.favorite !== false,
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
        // 收藏标记：默认 true（主动收藏）；仅记录阅读历史而自动加入时前端传 false
        favorite: b.favorite !== false,
        addedAt: now(),
      };
      shelf.unshift(item);
      saveDbSoon();
    } else {
      item.title = item.title || b.title;
      item.cover = item.cover || b.cover || '';
      item.author = item.author || b.author || '';
      if (b.chaptersTotal) item.chaptersTotal = Number(b.chaptersTotal) || item.chaptersTotal;
      // 显式传入时更新收藏标记（例如从阅读历史再次收藏）
      if (typeof b.favorite === 'boolean') item.favorite = b.favorite;
      saveDbSoon();
    }
    res.json({ ok: true, item });
  });

  // 切换收藏标记（不删除条目，便于历史与收藏互相保留）
  router.put('/shelf/:id/favorite', requireUser, (req, res) => {
    const db = loadDb();
    const item = shelfOf(db, req.user.id).find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: '书架里没有这条' });
    item.favorite = !!(req.body && req.body.favorite);
    saveDbSoon();
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

  // 图片代理服务端缓存：封面墙/章节图重复请求极多，源站（woimh 等）单张可达数秒，
  // 命中缓存直接回字节，避免每次都回源站，是「在线来源加载慢」的主要优化点。
  // key 含 sid + url；上限 600 条、单条 24h，超出按插入顺序淘汰最旧。
  const IMG_CACHE = new Map();
  const IMG_CACHE_TTL = 24 * 60 * 60 * 1000;
  const IMG_CACHE_MAX = 600;
  // 拉取失败的 URL 短时间记忆，避免书架多张不可达封面（如被网络封锁的 pstatic 域名）反复重试拖慢页面
  const IMG_FAIL = new Map();
  const IMG_FAIL_TTL = 10 * 60 * 1000;
  // 这些 CDN 域名在部分部署网络下被封锁/污染，直连必然超时：缩短超时并跳过无谓重试
  const SLOW_CDN = /pstatic\.net/i;

  // 图片代理：带源站防盗链头转发，阅读器/封面直接用
  router.get('/img', async (req, res) => {
    const source = getJsSource(String(req.query.sid || ''));
    const url = String(req.query.u || '');
    if (!source || !/^https?:\/\//i.test(url)) return res.status(400).end('bad request');
    const ck = source.key + '|' + url;
    const hit = IMG_CACHE.get(ck);
    if (hit && Date.now() - hit.t < IMG_CACHE_TTL) {
      res.setHeader('Content-Type', hit.ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Img-Cache', 'HIT');
      return res.send(hit.buf);
    }
    const fail = IMG_FAIL.get(ck);
    if (fail && Date.now() - fail < IMG_FAIL_TTL) return res.status(502).end('recent upstream failure');
    try {
      const ac = new AbortController();
      const timeout = SLOW_CDN.test(url) ? 7000 : 30000;
      const timer = setTimeout(() => ac.abort(), timeout);
      const ih = jsImageHeaders(source, url) || {};
      if (!ih.Referer && !ih.referer) ih.Referer = `${source.baseUrl || 'https://' + new URL(url).host}/`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA_DEFAULT, ...ih },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!r.ok) {
        if (r.status !== 404) IMG_FAIL.set(ck, Date.now());
        return res.status(r.status === 404 ? 404 : 502).end('upstream error');
      }
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
      // 仅缓存正常大小的图片，避免异常大响应撑爆内存；超出上限淘汰最旧条目
      if (buf && buf.length > 32 && buf.length < 8 * 1024 * 1024) {
        if (IMG_CACHE.size >= IMG_CACHE_MAX) {
          const oldest = IMG_CACHE.keys().next().value;
          if (oldest !== undefined) IMG_CACHE.delete(oldest);
        }
        IMG_CACHE.set(ck, { t: Date.now(), buf, ct });
      }
      IMG_FAIL.delete(ck);
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch {
      IMG_FAIL.set(ck, Date.now());
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
