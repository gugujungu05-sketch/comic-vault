/**
 * 在线书源（通用规则化适配器）。
 *
 * 设计：不写死任何站点。每个「书源」是一条 JSON 规则，描述某个漫画站的
 * 搜索/详情/章节图片页怎么解析，存放在 data/sources.json（不进 git）。
 * 用户可在网页端「在线来源」页自行添加书源规则，也可直接用内置示例。
 *
 * 选择器语法（基于 cheerio）：
 *   ".list a"                普通 CSS 选择器，取文本
 *   ".thumb img@data-src"    选择器 + @属性名，取属性
 *   ".t@text|title"          属性可用 | 列多个做兜底（依次尝试）
 *   "@href"                  当前元素自身的属性（如章节列表项本身是 <a>）
 *
 * 所有抓取只做「用户手动挑选后的下载」，请求自带站点要求的 Referer/UA 防盗链头。
 */
import express from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { loadDb, saveDbSoon, newId, getComic, comicDir, DATA_DIR, TMP_DIR } from './store.js';
import { storePage } from './page-store.js';
import { requireUser } from './social.js';

const now = () => Date.now();

const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');
const UA_DEFAULT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

/** 内置示例：一个完全自托管的规则演示（指向公用演示站，仅演示语法可改） */
const BUILTIN_RULES = [
  {
    id: 'demo-godev',
    name: '示例源（演示规则语法，可在页面里编辑或删除）',
    baseUrl: 'https://www.mh123.app',
    rules: {
      search: { url: '/search?q={kw}&page={page}', item: '.card', title: 'h2@text', link: 'a@href', cover: 'img@src|data-src' },
      comic: { title: 'h1@text', cover: '.thumb img@src|data-src', chapterItem: '.chapter-list a', chapterTitle: '@text', chapterLink: '@href' },
      chapter: { image: '.comic-content img@src|data-src|data-original', nextPage: 'a:contains("下一页")@href' },
    },
    builtin: true,
  },
];

function loadSources() {
  try {
    const arr = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf-8'));
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

function saveSources(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(list, null, 2) + '\n');
}

export function allSources() {
  const custom = loadSources();
  const have = new Set(custom.map((s) => s.id));
  return [...custom, ...BUILTIN_RULES.filter((s) => !have.has(s.id))];
}

/** 规则取值：sel 可以是 ".a img@src|data-src" / "@href" / ".t@text" */
function selPart(sel) {
  return String(sel || '').split('@')[0];
}

function pickValue($, el, sel) {
  if (!sel) return '';
  const [selPart = '', attrPart = ''] = String(sel).split('@');
  let node = selPart ? $(el).find(selPart) : $(el);
  // 兜底：元素本身匹配选择器（如顶层迭代选中的就是 <img> 自身）
  if (!node.length && selPart) {
    try {
      if ($(el).is(selPart)) node = $(el);
    } catch {
      /* 非法选择器忽略 */
    }
  }
  const target = node.length ? node.first() : null;
  if (!target) return '';
  const attrs = (attrPart || 'text').split('|').map((s) => s.trim()).filter(Boolean);
  for (const a of attrs) {
    if (a === 'text') {
      const t = target.text().trim();
      if (t) return t;
    } else {
      const v = target.attr(a);
      if (v) return v.trim();
    }
  }
  return '';
}

function absUrl(base, u) {
  if (!u) return '';
  try {
    return new URL(u, base).href;
  } catch {
    return '';
  }
}

function fetchHeaders(source) {
  const h = { 'User-Agent': source.headers?.ua || UA_DEFAULT, Accept: 'text/html,image/*,*/*' };
  const referer = source.headers?.referer || source.baseUrl;
  if (referer) h.Referer = referer;
  return h;
}

async function fetchText(source, url, maxBytes = 4 * 1024 * 1024) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: fetchHeaders(source), signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`站点返回 ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('响应过大');
    return buf.toString('utf-8');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImage(source, url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { headers: fetchHeaders(source), signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`图片返回 ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/') && !ct.includes('octet-stream')) throw new Error(`非图片响应: ${ct}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 32) throw new Error('图片内容为空');
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
    const tmp = path.join(TMP_DIR, `src-${nanoid(8)}.${ext}`);
    await fsp.mkdir(TMP_DIR, { recursive: true });
    await fsp.writeFile(tmp, buf);
    return tmp;
  } finally {
    clearTimeout(timer);
  }
}

function sourceError(res, err) {
  const msg = err?.name === 'AbortError' ? '请求超时（站点无响应或被墙）' : err?.message || '抓取失败';
  return res.status(502).json({ error: msg });
}

/** 抓取漫画详情页：返回 { title, cover, chapters:[{title,url}] }（供路由与追更共用） */
export async function fetchComicDetail(source, url) {
  const html = await fetchText(source, url);
  const $ = cheerio.load(html);
  const rules = source.rules.comic;
  const title = pickValue($, $.root(), rules.title) || '';
  const cover = absUrl(source.baseUrl, pickValue($, $.root(), rules.cover));
  const chapters = [];
  $(rules.chapterItem).each((_, el) => {
    if (chapters.length >= 500) return;
    const t = pickValue($, el, rules.chapterTitle);
    const link = absUrl(source.baseUrl, pickValue($, el, rules.chapterLink));
    if (link) chapters.push({ title: t || `第 ${chapters.length + 1} 话`, url: link });
  });
  return { title, cover, chapters };
}

/**
 * 从书源导入一话到书库（路由 /api/sources/import 与定时追更共用）。
 * @param {object} p { source, userId, comic?, title, cover, comicUrl, chapterTitle, chapterUrl }
 * comic 不传则新建漫画。返回 { comic, chapter, total, stored }
 */
export async function importChapterFromSource(p) {
  const source = p.source;
  const db = loadDb();
  let comic = p.comic || null;

  // 抓取章节页并收集图片地址
  const images = [];
  let current = p.chapterUrl;
  const seen = new Set();
  for (let i = 0; i < 30 && current; i++) {
    const html = await fetchText(source, current);
    const $ = cheerio.load(html);
    $(selPart(source.rules.chapter.image)).each((_, el) => {
      const src = absUrl(source.baseUrl, pickValue($, el, source.rules.chapter.image));
      if (src && !seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });
    current = source.rules.chapter.nextPage
      ? absUrl(source.baseUrl, pickValue($, $.root(), source.rules.chapter.nextPage))
      : '';
    if (current && seen.has(current)) current = '';
    if (current) seen.add(current);
  }
  if (!images.length) {
    const e = new Error('这个章节没有抓到任何图片，请检查「章节图片选择器」规则');
    e.status = 422;
    throw e;
  }

  // 建漫画（首次导入）
  if (!comic) {
    const t = now();
    comic = {
      id: newId('c'),
      title: (p.title || '未命名漫画').trim(),
      author: p.author || '',
      artist: '',
      description: p.description || '',
      tags: [],
      status: 'ongoing',
      direction: db.settings.defaultDirection || 'ltr',
      language: 'zh',
      favorite: false,
      cover: null,
      chapters: [],
      progress: null,
      share: null,
      publisher: '',
      year: null,
      rating: null,
      ageRating: '',
      comicInfo: null,
      ownerId: p.userId,
      createdBy: p.userId,
      scope: 'personal',
      visibility: 'private',
      allowDownload: true,
      aliases: [],
      tagEntries: [],
      covers: [],
      activeCoverId: null,
      createdAt: t,
      updatedAt: t,
      category: 'other',
      views: 0,
      downloads: 0,
      likes: [],
      lastActivityAt: t,
      source: { id: source.id, name: source.name || source.id, url: p.comicUrl || '' },
    };
    db.comics.unshift(comic);
  }

  const chapter = {
    id: newId('ch'),
    title: (p.chapterTitle || `第 ${comic.chapters.length + 1} 话`).trim(),
    pages: [],
    uploadedBy: p.userId,
    uploadedAt: now(),
  };
  let stored = 0;
  for (const imgUrl of images) {
    let tmp = null;
    try {
      tmp = await fetchImage(source, imgUrl);
      const page = await storePage(tmp, imgUrl, 'image/auto', comic.id, chapter.id);
      chapter.pages.push(page);
      stored++;
    } catch (err) {
      if (tmp) await fsp.rm(tmp, { force: true });
      console.error('[sources] 图片下载失败:', err.message);
    }
  }
  if (!stored) {
    const e = new Error('所有图片都下载失败，可能被站点防盗链拦截，尝试在书源里配置 Referer');
    e.status = 422;
    throw e;
  }
  comic.chapters.push(chapter);
  comic.updatedAt = now();
  comic.lastActivityAt = now();

  // 首次导入时下载站点封面存为漫画封面
  let coverUrl = null;
  if (!comic.cover && p.cover && String(p.cover).startsWith('http')) {
    try {
      const tmpCover = await fetchImage(source, p.cover);
      const name = `cover_${nanoid(6)}${path.extname(tmpCover) || '.jpg'}`;
      const dir = path.join(comicDir(comic.id), '_cover');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rename(tmpCover, path.join(dir, name)).catch(async () => {
        await fsp.copyFile(tmpCover, path.join(dir, name));
        await fsp.rm(tmpCover, { force: true });
      });
      comic.cover = { type: 'file', file: name };
      coverUrl = `/api/files/${comic.id}/_cover/${name}`;
    } catch {
      /* 封面失败不影响导入 */
    }
  }

  saveDbSoon();
  return { comic, chapter, total: images.length, stored, coverUrl };
}

export function registerSources(app) {
  const router = express.Router();

  // 书源列表（内置 + 自定义）
  router.get('/', (req, res) => {
    res.json({
      sources: allSources().map((s) => ({
        id: s.id,
        name: s.name,
        baseUrl: s.baseUrl,
        builtin: !!s.builtin,
        hasRules: !!(s.rules && s.rules.search && s.rules.chapter),
      })),
    });
  });

  // 新增 / 更新自定义书源
  router.post('/', requireUser, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.baseUrl) return res.status(400).json({ error: '请填写书源名称和站点地址' });
    if (!b.rules?.comic?.chapterItem || !b.rules?.chapter?.image)
      return res.status(400).json({ error: '规则至少需要 详情页章节选择器 和 章节图片选择器' });
    const list = loadSources();
    const id = b.id || `s-${nanoid(6)}`;
    const src = {
      id,
      name: String(b.name).slice(0, 60),
      baseUrl: String(b.baseUrl).replace(/\/+$/, ''),
      headers: b.headers || {},
      rules: b.rules,
      createdAt: now(),
    };
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = src;
    else list.unshift(src);
    saveSources(list);
    res.json({ ok: true, id });
  });

  router.delete('/:id', requireUser, (req, res) => {
    const list = loadSources().filter((s) => s.id !== req.params.id);
    saveSources(list);
    res.json({ ok: true });
  });

  // 搜索
  router.get('/:id/search', requireUser, async (req, res) => {
    const source = allSources().find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: '书源不存在' });
    const kw = String(req.query.kw || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!kw) return res.status(400).json({ error: '请输入搜索关键词' });
    try {
      const url = absUrl(source.baseUrl, source.rules.search.url.replace('{kw}', encodeURIComponent(kw)).replace('{page}', String(page)));
      const html = await fetchText(source, url);
      const $ = cheerio.load(html);
      const items = [];
      $(source.rules.search.item).each((_, el) => {
        if (items.length >= 40) return;
        const title = pickValue($, el, source.rules.search.title);
        const link = absUrl(source.baseUrl, pickValue($, el, source.rules.search.link));
        const cover = absUrl(source.baseUrl, pickValue($, el, source.rules.search.cover));
        if (title && link) items.push({ title, link, cover });
      });
      res.json({ items, url });
    } catch (err) {
      sourceError(res, err);
    }
  });

  // 漫画详情 + 章节列表
  router.post('/:id/comic', requireUser, async (req, res) => {
    const source = allSources().find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: '书源不存在' });
    const url = String(req.body?.url || '');
    if (!url.startsWith('http')) return res.status(400).json({ error: '请提供漫画详情页链接' });
    try {
      const r = await fetchComicDetail(source, url);
      res.json({ ...r, url });
    } catch (err) {
      sourceError(res, err);
    }
  });

  // 单章节图片列表（预览用，可带下一页跟随）
  router.post('/:id/chapter', requireUser, async (req, res) => {
    const source = allSources().find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: '书源不存在' });
    const url = String(req.body?.url || '');
    if (!url.startsWith('http')) return res.status(400).json({ error: '请提供章节链接' });
    try {
      const images = [];
      let current = url;
      for (let i = 0; i < 30 && current; i++) {
        const html = await fetchText(source, current);
        const $ = cheerio.load(html);
        $(selPart(source.rules.chapter.image)).each((_, el) => {
          const src = absUrl(source.baseUrl, pickValue($, el, source.rules.chapter.image));
          if (src && !images.includes(src)) images.push(src);
        });
        current = source.rules.chapter.nextPage
          ? absUrl(source.baseUrl, pickValue($, $.root(), source.rules.chapter.nextPage))
          : '';
        if (current && (images.length === 0 || current === url)) current = '';
      }
      res.json({ images, count: images.length });
    } catch (err) {
      sourceError(res, err);
    }
  });

  // 导入一话到书库：body { comicId?, sourceId, sourceName, title, cover, author?, chapterTitle, chapterUrl }
  // comicId 不传则新建漫画（之后重复调用传回 comicId 即可连续导入多话）。
  router.post('/import', requireUser, async (req, res) => {
    const b = req.body || {};
    const source = allSources().find((s) => s.id === b.sourceId);
    if (!source) return res.status(404).json({ error: '书源不存在' });
    const chapterUrl = String(b.chapterUrl || '');
    if (!chapterUrl.startsWith('http')) return res.status(400).json({ error: '缺少章节链接' });

    let comic = b.comicId ? getComic(b.comicId) : null;
    if (b.comicId && (!comic || comic.createdBy !== req.user.id))
      return res.status(404).json({ error: '目标漫画不存在或不属于你' });

    try {
      const r = await importChapterFromSource({
        source, userId: req.user.id, comic,
        title: b.title, cover: b.cover, comicUrl: b.comicUrl,
        author: b.author, description: b.description,
        chapterTitle: b.chapterTitle, chapterUrl,
      });
      res.json({
        comicId: r.comic.id,
        chapterId: r.chapter.id,
        chapterTitle: r.chapter.title,
        coverUrl: r.coverUrl,
        total: r.total,
        stored: r.stored,
        failed: r.total - r.stored,
        chaptersDone: r.comic.chapters.length,
      });
    } catch (err) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      return sourceError(res, err);
    }
  });

  app.use('/api/sources', router);
}
