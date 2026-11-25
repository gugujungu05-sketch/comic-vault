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
import { normalizeSourceImage } from './media.js';
import { requireUser } from './social.js';
import {
  loadJsSources, allJsSources, getJsSource,
  jsSearch, jsComicDetail, jsChapterImages, jsImageHeaders, jsImageDecode,
  jsDiscoverTabs, jsDiscoverLoad, jsSetSourceCookies, jsAccountLogin, jsRegisterWebsite,
  jsSourceLoginStatus, jsClearSourceLogin,
} from './js-sources.js';

const now = () => Date.now();

/** 发现页缓存：切源/重复点击秒开。key=源:tab:页，5 分钟有效，失败结果不缓存。 */
const discoverCache = new Map();
const DISCOVER_TTL = 5 * 60 * 1000;

/** 导入实时进度：key = userId，值 = { chapterIndex, chapterTotal, imageDone, imageTotal, title, ts }。
 *  前端轮询 /api/sources/import/progress 显示，避免「卡住不动」的体感。 */
const importProgress = new Map();
export function getImportProgress(userId) { return importProgress.get(String(userId)) || null; }
function setImportProgress(userId, v) { importProgress.set(String(userId), { ...v, ts: now() }); }
function clearImportProgress(userId) { importProgress.delete(String(userId)); }

/** 启动时加载内置 JS 书源（Ciallo-Reader 移植脚本） */
loadJsSources();

/** 判断是否 JS 脚本书源，并返回其实例 */
function jsOf(id) {
  return String(id || '').startsWith('js:') ? getJsSource(id) : null;
}

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

/** 从书源导入一话到书库（路由 /api/sources/import 与定时追更共用）。
 *  JS 脚本源与规则源共用同一套入库流程；images/headers 由调用方预取或在此抓取。 */
async function createSourceComic(db, p) {
  const t = now();
  const comic = {
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
    category: p.category || 'other',
    views: 0,
    downloads: 0,
    likes: [],
    lastActivityAt: t,
    source: { id: p.source?.id || '', name: p.source?.name || p.source?.key || '', url: p.comicUrl || '' },
  };
  db.comics.unshift(comic);
  return comic;
}

/** 首次导入时下载站点封面存为漫画封面 */
async function attachSourceCover(p, comic, coverUrl, imgHeaders, decodeScheme = null) {
  if (comic.cover || !coverUrl || !String(coverUrl).startsWith('http')) return null;
  try {
    const tmpCover = await downloadSourceImage(coverUrl, imgHeaders, '', decodeScheme);
    const name = `cover_${nanoid(6)}${path.extname(tmpCover) || '.jpg'}`;
    const dir = path.join(comicDir(comic.id), '_cover');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(tmpCover, path.join(dir, name)).catch(async () => {
      await fsp.copyFile(tmpCover, path.join(dir, name));
      await fsp.rm(tmpCover, { force: true });
    });
    comic.cover = { type: 'file', file: name };
    return `/api/files/${comic.id}/_cover/${name}`;
  } catch {
    return null; /* 封面失败不影响导入 */
  }
}

/** 下载一张源站图片到临时文件（带防盗链头；失败自动补 Referer 重试一次） */
async function downloadSourceImage(imgUrl, headers = {}, fallbackReferer = '', decodeScheme = null) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  // 下载→还原混淆→（必要时）转 JPEG→落盘。返回临时文件路径与真实扩展名。
  const save = async (rawBuf) => {
    const norm = await normalizeSourceImage(rawBuf, decodeScheme);
    const tmp = path.join(TMP_DIR, `src-${nanoid(8)}.${norm.ext}`);
    await fsp.mkdir(TMP_DIR, { recursive: true });
    await fsp.writeFile(tmp, norm.buf);
    return tmp;
  };
  try {
    const r = await fetch(imgUrl, {
      headers: { 'User-Agent': UA_DEFAULT, ...headers },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`图片返回 ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/') && !ct.includes('octet-stream')) throw new Error(`非图片响应: ${ct}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 32) throw new Error('图片内容为空');
    return await save(buf);
  } catch (err) {
    // 兜底重试：① 源脚本没给 Referer 时补站点域名；② 任何失败（并发限流/抖动）延迟后
    // 再试一次。部分 CDN（如 mangafire）并发下载时限流返回非 200，串行重试即可成功。
    const needRef = fallbackReferer && !headers.Referer && !headers.referer;
    const retryCtrl = new AbortController();
    const retryTimer = setTimeout(() => retryCtrl.abort(), 40000);
    try {
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
      const headers2 = needRef ? { 'User-Agent': UA_DEFAULT, ...headers, Referer: fallbackReferer } : { 'User-Agent': UA_DEFAULT, ...headers };
      const r2 = await fetch(imgUrl, { headers: headers2, signal: retryCtrl.signal, redirect: 'follow' });
      if (r2.ok) {
        const ct2 = r2.headers.get('content-type') || '';
        if (ct2.startsWith('image/') || ct2.includes('octet-stream')) {
          const buf2 = Buffer.from(await r2.arrayBuffer());
          if (buf2.length >= 32) return await save(buf2);
        }
      }
    } catch { /* 兜底也失败则按原错误抛出 */ }
    finally { clearTimeout(retryTimer); }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** JS 脚本源导入一话：images 由源脚本 loadEp 给出，防盗链头由 onImageLoad 给出 */
export async function importJsChapter(p, onProgress) {
  const db = loadDb();
  let comic = p.comic || null;
  const { images, headers, decode } = await jsChapterImages(p.source, p.bookId, p.chapterPath);
  const decodeScheme = decode || jsImageDecode(p.source);

  // createSourceComic 是 async（内部可能下载封面资源），必须 await；
  // 缺少 await 时 comic 是 Promise，后续 storePage 收到 undefined 目录名，
  // 所有图片落盘失败 → 用户看到「所有图片都下载失败」/ 0 页空漫画。
  if (!comic) comic = await createSourceComic(db, p);

  const chapter = {
    id: newId('ch'),
    title: (p.chapterTitle || `第 ${comic.chapters.length + 1} 话`).trim(),
    sourceUrl: p.chapterPath || '',
    pages: [],
    uploadedBy: p.userId,
    uploadedAt: now(),
  };
  // 并发分批下载（每批 10 张）：几百页不再串行等待；单张失败自动补 Referer 重试
  const fallbackRef = `${p.source.baseUrl || 'https://' + (() => { try { return new URL(images[0]).host; } catch { return 'example.com'; } })()}/`;
  let stored = 0;
  const pages = new Array(images.length).fill(null);
  const BATCH = 10;
  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (imgUrl, j) => {
      let tmp = null;
      try {
        const ih = jsImageHeaders(p.source, imgUrl) || headers || {};
        tmp = await downloadSourceImage(imgUrl, ih, fallbackRef, decodeScheme);
        if (typeof onProgress === 'function') onProgress({ imageDone: i + j + 1, imageTotal: images.length });
        const page = await storePage(tmp, imgUrl, 'image/auto', comic.id, chapter.id, decodeScheme);
        return page;
      } catch (err) {
        if (tmp) await fsp.rm(tmp, { force: true });
        console.error('[js-sources] 图片下载失败:', err.message);
        if (typeof onProgress === 'function') onProgress({ imageDone: i + j + 1, imageTotal: images.length });
        return null;
      }
    }));
    for (let j = 0; j < results.length; j++) pages[i + j] = results[j];
  }
  for (const pg of pages) if (pg) { chapter.pages.push(pg); stored++; }
  if (!stored) {
    const e = new Error('所有图片都下载失败，可能被站点防盗链拦截');
    e.status = 422;
    throw e;
  }
  comic.chapters.push(chapter);
  comic.updatedAt = now();
  comic.lastActivityAt = now();

  const coverUrl = await attachSourceCover(p, comic, p.cover, jsImageHeaders(p.source, p.cover || images[0]), decodeScheme);
  saveDbSoon();
  return { comic, chapter, total: images.length, stored, coverUrl };
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

  // 书源列表（内置 JS 源 + 规则源 + 自定义）
  router.get('/', (req, res) => {
    const js = allJsSources().map((s) => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      builtin: true,
      kind: 'js',
      mediaType: s.mediaType,
      version: s.version,
      hasRules: true,
    }));
    const rules = allSources().map((s) => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      builtin: !!s.builtin,
      kind: 'rules',
      mediaType: 'comic',
      hasRules: !!(s.rules && s.rules.search && s.rules.chapter),
    }));
    res.json({ sources: [...js, ...rules] });
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

  // 书源站点账号登录：把登录后的 Cookie 存进该源的 cookie 罐，供后续请求自动携带
  // 读取站点登录入口（官网地址 / 是否支持密码登录）——只返回公开配置，不含 Cookie 值，
  // 因此不要求网站登录：未登录用户点「站点账号」也能看到官网登录入口，
  // 否则 401 会让弹窗变空、表现为「登不上」。真正保存 Cookie / 登录仍要求登录态。
  router.get('/:id/cookies', (req, res) => {
    const js = jsOf(req.params.id);
    if (!js) return res.status(404).json({ error: '书源不存在' });
    let website = '';
    let canPasswordLogin = false;
    try {
      website = jsRegisterWebsite(req.params.id) || '';
      const src = getJsSource(req.params.id);
      canPasswordLogin = !!(src && src.account && typeof src.account.login === 'function');
    } catch { /* 忽略 */ }
    // 当前登录态（只含布尔/计数，不含 Cookie/token 值），供前端显示是否已生效
    let login = { loggedIn: false, cookieCount: 0, credentialCount: 0 };
    try { login = jsSourceLoginStatus(req.params.id); } catch { /* 忽略 */ }
    res.json({ ok: true, source: js.name, accountHint: js.accountHint || '', website, canPasswordLogin, ...login });
  });

  // 源账号密码登录（可选）：直接调用源脚本的 account.login
  router.post('/:id/account-login', requireUser, async (req, res) => {
    try {
      const r = await jsAccountLogin(req.params.id, req.body?.account, req.body?.password);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) { res.status(400).json({ ok: false, error: e?.message || '登录失败' }); }
  });
  router.post('/:id/cookies', requireUser, (req, res) => {
    const js = jsOf(req.params.id);
    if (!js) return res.status(404).json({ error: '书源不存在' });
    try {
      const raw = String(req.body?.cookies || '').trim();
      if (!raw) {
        // 留空 = 一键清除：连 token 凭据一起清，避免账号密码登录态残留
        const r = jsClearSourceLogin(req.params.id);
        return res.json({ ok: true, cleared: true, ...r });
      }
      const r = jsSetSourceCookies(req.params.id, raw, req.body?.domain || '');
      res.json({ ...r, login: jsSourceLoginStatus(req.params.id) });
    } catch (e) { res.status(400).json({ error: e?.message || '保存 Cookie 失败' }); }
  });

  // 专门的一键退出：清空该源 Cookie + token 凭据（与保存空 Cookie 等价，语义更清晰）
  router.post('/:id/logout', requireUser, (req, res) => {
    const js = jsOf(req.params.id);
    if (!js) return res.status(404).json({ error: '书源不存在' });
    try {
      const r = jsClearSourceLogin(req.params.id);
      res.json({ ok: true, ...r, login: jsSourceLoginStatus(req.params.id) });
    } catch (e) { res.status(400).json({ error: e?.message || '清除登录态失败' }); }
  });

  // 发现 / 浏览：进入书源不搜索也能看到漫画 / 小说列表
  router.get('/:id/discover', async (req, res) => {
    const js = jsOf(req.params.id);
    if (!js) return res.status(404).json({ error: '书源不存在' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    try {
      const tabs = jsDiscoverTabs(js);
      if (!tabs.length) return res.json({ tabs: [], items: [], maxPage: 1 });
      const tabIndex = Math.min(Math.max(0, parseInt(req.query.tab, 10) || 0), tabs.length - 1);
      const ck = `${js.key}:${tabIndex}:${page}`;
      const hit = discoverCache.get(ck);
      if (hit && now() - hit.at < DISCOVER_TTL) {
        return res.json({ ...hit.data, tabs, tab: tabIndex, cached: true });
      }
      const r = await jsDiscoverLoad(js, tabIndex, page);
      const data = { items: r.items, maxPage: r.maxPage };
      if (r.items && r.items.length) discoverCache.set(ck, { at: now(), data });
      return res.json({ ...data, tabs, tab: tabIndex });
    } catch (err) {
      return sourceError(res, err);
    }
  });

  // 搜索（短时缓存：同一关键词重复搜索秒回，降低站点压力与等待）
  const searchCache = new Map();
  const SEARCH_TTL = 3 * 60 * 1000;
  router.get('/:id/search', async (req, res) => {
    const kw = String(req.query.kw || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!kw) return res.status(400).json({ error: '请输入搜索关键词' });
    const sck = `${req.params.id}:${kw}:${page}`;
    const sh = searchCache.get(sck);
    if (sh && now() - sh.t < SEARCH_TTL) return res.json({ ...sh.data, cached: true });
    try {
      const js = jsOf(req.params.id);
      if (js) {
        const items = await jsSearch(js, kw, page);
        const data = { items };
        if (items.length) { searchCache.set(sck, { t: now(), data }); if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value); }
        return res.json(data);
      }
      const source = allSources().find((s) => s.id === req.params.id);
      if (!source) return res.status(404).json({ error: '书源不存在' });
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

  // 漫画详情 + 章节列表（JS 源：url 即书籍 id）
  router.post('/:id/comic', async (req, res) => {
    const js = jsOf(req.params.id);
    if (js) {
      const bookId = String(req.body?.url || '').trim();
      if (!bookId) return res.status(400).json({ error: '缺少书籍标识' });
      try {
        const d = await jsComicDetail(js, bookId);
        return res.json({ ...d, url: d.url || bookId, bookId });
      } catch (err) {
        return sourceError(res, err);
      }
    }
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

  // 单章节图片列表（预览 / 在线阅读用）
  router.post('/:id/chapter', requireUser, async (req, res) => {
    const js = jsOf(req.params.id);
    if (js) {
      const bookId = String(req.body?.bookId || req.body?.url || '').trim();
      const chapterPath = String(req.body?.chapterUrl || '').trim();
      if (!bookId || !chapterPath) return res.status(400).json({ error: '缺少书籍或章节标识' });
      try {
        const { images } = await jsChapterImages(js, bookId, chapterPath);
        return res.json({
          images: images.map((u) => `/api/online/img?sid=${encodeURIComponent(js.key)}&u=${encodeURIComponent(u)}`),
          count: images.length,
        });
      } catch (err) {
        return sourceError(res, err);
      }
    }
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

  // 导入实时进度（前端轮询）
  router.get('/import/progress', requireUser, (req, res) => {
    res.json(getImportProgress(req.user.id) || { idle: true });
  });

  // 导入一话到书库：body { comicId?, sourceId, sourceName, title, cover, author?, chapterTitle, chapterUrl }
  // comicId 不传则新建漫画（之后重复调用传回 comicId 即可连续导入多话）。
  // JS 脚本源：bookId = 源站书籍 id，chapterUrl = 章节路径（如 /chapter/123）。
  router.post('/import', requireUser, async (req, res) => {
    const b = req.body || {};
    const js = jsOf(b.sourceId);
    if (js) {
      const bookId = String(b.bookId || b.comicUrl || '').trim();
      const chapterPath = String(b.chapterUrl || '').trim();
      if (!bookId || !chapterPath) return res.status(400).json({ error: '缺少书籍或章节标识' });
      const db = loadDb();
      let comic = b.comicId ? getComic(b.comicId) : null;
      if (b.comicId && (!comic || comic.createdBy !== req.user.id))
        return res.status(404).json({ error: '目标漫画不存在或不属于你' });
      // 中断续导：前端若没传 comicId（刷新/退出后丢失），按来源书籍标识找回已建的漫画，
      // 避免同一本书被拆成「一话一本」。只匹配当前用户创建、带同名来源的书。
      if (!comic && b.sourceId) {
        const key = String(b.bookId || b.comicUrl || '').trim();
        const srcName = String(b.sourceName || '').trim().toLowerCase();
        const comicUrl = String(b.comicUrl || '').trim();
        comic = (db.comics || []).find((c) => {
          if ((c.createdBy || c.ownerId) !== req.user.id || !c.source) return false;
          const sid = String(c.source.id || '');
          // source.id 老数据可能为空，此时不强制比对 id，靠 URL + 来源名判定
          if (sid && sid !== String(b.sourceId)) return false;
          const ckey = String(c.source.url || '').trim();
          // 精确匹配：详情页 URL 或 bookId 一致（不模糊 endsWith，避免误并不同漫画）
          if (comicUrl && ckey === comicUrl) return true;
          if (key && ckey === key) return true;
          if (srcName && String(c.source.name || '').toLowerCase() === srcName && c.title === String(b.title || '').trim()) return true;
          return false;
        }) || null;
      }
      setImportProgress(req.user.id, {
        chapterTitle: b.chapterTitle || '正在导入', imageDone: 0, imageTotal: 0, phase: 'fetch',
      });
      try {
        // 断点续导：若这本已有同名章节（上次导入中断前已完成），直接跳过不重复下载。
        // 章节可能存源 URL（sourceUrl）或标题，两者任一命中即视为已导入。
        const wantTitle = String(b.chapterTitle || '').trim();
        const wantUrl = String(chapterPath || '').trim();
        const dup = comic && (comic.chapters || []).find((ch) => {
          const t = String(ch.title || '').trim();
          const u = String(ch.sourceUrl || ch.url || '').trim();
          return (wantTitle && t === wantTitle) || (wantUrl && u === wantUrl);
        });
        if (dup) {
          return res.json({
            comicId: comic.id, chapterId: dup.id, chapterTitle: dup.title,
            stored: (dup.pages || []).length, failed: 0,
            chaptersDone: comic.chapters.length, skipped: true,
          });
        }
        const r = await importJsChapter({
          source: js, userId: req.user.id, comic,
          title: b.title, cover: b.cover, comicUrl: b.comicUrl,
          author: b.author, description: b.description,
          bookId, chapterPath, chapterTitle: b.chapterTitle,
        }, (pg) => setImportProgress(req.user.id, {
          chapterTitle: b.chapterTitle || '正在导入',
          imageDone: pg.imageDone, imageTotal: pg.imageTotal, phase: 'download',
        }));
        return res.json({
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
    }
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
