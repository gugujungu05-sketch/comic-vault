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
  jsDiscoverTabs, jsDiscoverLoad, jsLotteryGenreEntries, jsLotteryLoad,
  jsCollectTags, normalizeTag, isTagBlocked, jsTagsIndexApply,
  jsSetSourceCookies, jsAccountLogin, jsRegisterWebsite,
  jsSourceLoginStatus, jsClearSourceLogin,
} from './js-sources.js';

const now = () => Date.now();

/** 发现页缓存：切源/重复点击秒开。key=源:tab:页，5 分钟有效，失败结果不缓存。 */
const discoverCache = new Map();
const DISCOVER_TTL = 5 * 60 * 1000;

/** 源健康自愈：后台定期探测每个源的发现页，记录 ok/fail/耗时/lastCheck。
 *  探测与请求自愈（瞬时错误重试 + 过期缓存降级）配合：抖动源自动回血，持续失效源在前端标红提示。 */
const HEALTH_FILE = path.join(DATA_DIR, 'source-health.json');
const HEALTH_INTERVAL = 20 * 60 * 1000; // 20 分钟复检一次
let sourceHealth = {};
try { sourceHealth = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { /* 首次无文件 */ }
let healthTimer = null;
function saveHealth() { try { fs.writeFileSync(HEALTH_FILE, JSON.stringify(sourceHealth, null, 2)); } catch { /* 忽略 */ } }

/** 导入实时进度：key = userId:taskId，值 = { chapterIndex, chapterTotal, imageDone, imageTotal, title, ts }。
 *  按 taskId 隔离：多个导入任务同时进行时各自进度互不覆盖。
 *  前端轮询 /api/sources/import/progress?taskId=xxx 显示，避免「卡住不动」的体感。 */
const importProgress = new Map();
const progressKey = (userId, taskId) => String(userId) + ':' + String(taskId || '_default');
export function getImportProgress(userId, taskId) { return importProgress.get(progressKey(userId, taskId)) || null; }
function setImportProgress(userId, taskId, v) { importProgress.set(progressKey(userId, taskId), { ...v, ts: now() }); }
function clearImportProgress(userId, taskId) { importProgress.delete(progressKey(userId, taskId)); }

/* ------------------------------------------------------------------ *
 *  抽奖机：跨所有来源按「类型 / 题材标签」抽取书籍推荐。
 *  - 题材词典把用户可见的题材名映射到各源 category 名称的别名。
 *  - 书池缓存：同一题材组合 30 分钟内复用候选集，抽奖只做本地洗牌，秒开。
 *  - 跨源去重：按归一化书名去重，同一本书只保留一个来源，避免同书重复出现。
 * ------------------------------------------------------------------ */
const LOTTERY_GENRES = [
  { id: 'all', label: '随便来点', aliases: [] },
  { id: 'hot', label: '热门', aliases: ['热门', '排行', '榜', 'hot', 'popular', '推荐', '今日', '本周', '本月'] },
  { id: 'action', label: '热血战斗', aliases: ['热血', '熱血', '战斗', '戰鬥', '动作', '動作', 'action', 'shounen', '少年', '冒險', '冒险'] },
  { id: 'romance', label: '恋爱爱情', aliases: ['恋爱', '戀愛', '爱情', '愛情', 'romance', 'love', '纯爱', '純愛', '耽美', '百合'] },
  { id: 'fantasy', label: '奇幻魔幻', aliases: ['奇幻', '魔幻', 'fantasy', '魔法', '异世界', '異世界', 'fantasyadventure', '奇异', '奇異'] },
  { id: 'adventure', label: '冒险', aliases: ['冒险', '冒險', 'adventure'] },
  { id: 'mystery', label: '悬疑推理', aliases: ['悬疑', '懸疑', '推理', 'mystery', '惊悚', '驚悚', '犯罪', '侦探', '偵探', 'suspense'] },
  { id: 'scifi', label: '科幻未来', aliases: ['科幻', 'sci-fi', 'scifi', 'sf', '未来', '未來'] },
  { id: 'school', label: '校园青春', aliases: ['校园', '校園', 'school', '青春', '学生'] },
  { id: 'city', label: '都市生活', aliases: ['都市', '职场', '職場', 'workplace', '生活', '日常', 'slice of life'] },
  { id: 'comedy', label: '搞笑日常', aliases: ['搞笑', '喜劇', '喜剧', 'comedy', '轻松'] },
  { id: 'history', label: '历史武侠', aliases: ['历史', '歷史', '武侠', '武俠', '古风', '古風', 'historical'] },
  { id: 'completed', label: '完结', aliases: ['完结', '完結', '已完结', 'finish', 'completed'] },
];
const LOTTERY_POOL_TTL = 30 * 60 * 1000;
const lotteryPoolCache = new Map(); // key = `${media}|${genreIds.sort().join(',')}` → { at, items }

/* 标签整合缓存：抓取某源/所有源的标签要访问大量分类页，结果稳定，缓存较久。
   key = 源 id 或 '__all__'；值 = { at, tags:[{tag,count,sources?}] } */
const TAG_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
const tagCache = new Map();
const TAG_FETCH_TIMEOUT = 25000; // 单源标签整合最长等待，慢源不拖垮全局

/** 解析 blocked 查询参数（逗号分隔的标签）→ 归一化后的 Set */
function blockedSetOf(query) {
  const set = new Set();
  for (const t of String(query?.blocked || '').split(',')) {
    const n = normalizeTag(t);
    if (n) set.add(n);
  }
  return set;
}

/** 整合所有源所有书的标签题材（抽奖机屏蔽设置用）。
 *  先复用各源缓存，缺失的源并发抓取；任一源失败/超时不影响其它源。 */
async function collectAllTags(force = false) {
  const key = '__all__';
  const hit = tagCache.get(key);
  if (!force && hit && now() - hit.at < TAG_CACHE_TTL) return { ...hit, cached: true };
  const sources = allJsSources();
  const perSource = await Promise.all(sources.map(async (meta) => {
    let tags = [];
    const sHit = tagCache.get(meta.id);
    if (!force && sHit && now() - sHit.at < TAG_CACHE_TTL) {
      tags = sHit.tags;
    } else {
      const js = getJsSource(meta.id);
      if (!js) return [];
      try {
        tags = await Promise.race([
          jsCollectTags(js),
          new Promise((r) => setTimeout(() => r([]), TAG_FETCH_TIMEOUT)),
        ]);
        if (tags.length) tagCache.set(meta.id, { at: now(), tags });
      } catch { return []; }
    }
    return tags.map((t) => ({ ...t, source: meta.id, sourceName: meta.name }));
  }));
  // 合并同名词条：词频累加，记录来源
  const merged = new Map();
  for (const group of perSource) {
    for (const t of group) {
      const k = normalizeTag(t.tag);
      if (!k) continue;
      const prev = merged.get(k);
      if (prev) {
        prev.count += t.count;
        if (t.sourceName && !prev.sources.includes(t.sourceName)) prev.sources.push(t.sourceName);
      } else {
        merged.set(k, { tag: t.tag, count: t.count, sources: t.sourceName ? [t.sourceName] : [] });
      }
    }
  }
  const tags = [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const data = { at: now(), tags };
  // 空结果不缓存：首次整合可能因部分源超时而颗粒无收，缓存空会让 6 小时内都拿不到标签
  if (tags.length) tagCache.set(key, data);
  return { ...data, cached: false };
}

/** 中文书名归一化：简繁常见字折叠 + 去标点空格，用于跨源去重 */
const T2S_MAP = {
  '熱':'热','戰':'战','鬥':'斗','戀':'恋','愛':'爱','無':'无','龍':'龙','東':'东','萬':'万','與':'与',
  '風':'风','雲':'云','電':'电','書':'书','畫':'画','國':'国','學':'学','實':'实','體':'体','動':'动',
  '靜':'静','類':'类','島':'岛','馬':'马','鳥':'鸟','魚':'鱼','貝':'贝','車':'车','軌':'轨','軍':'军',
  '農':'农','醫':'医','長':'长','門':'门','問':'问','間':'间','關':'关','會':'会','說':'说','話':'话',
  '記':'记','論':'论','讀':'读','變':'变','還':'还','過':'过','進':'进','達':'达','遠':'远','適':'适',
  '選':'选','開':'开','閉':'闭','橫':'横','歡':'欢','樂':'乐','驚':'惊','懸':'悬','疑':'疑','麗':'丽',
  '優':'优','復':'复','殺':'杀','靈':'灵','異':'异','夢':'梦','亞':'亚','傳':'传','傷':'伤','倫':'伦',
};
function normalizeBookTitle(t) {
  return String(t || '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .split('').map((c) => T2S_MAP[c] || c).join('')
    .toLowerCase();
}

/** 判断某个源的分类入口是否命中题材；未选题材(all)时返回 null 表示走发现页 */
function matchGenreEntry(entries, aliases) {
  if (!aliases.length) return null;
  const hit = entries.find((e) => aliases.some((a) => e.name.toLowerCase().includes(a.toLowerCase())));
  return hit || null;
}

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

/**
 * 后台预热发现页缓存：服务启动后异步并发预取每个 JS 源的 tab0/page1，
 * 写入 discoverCache。用户首次打开「在线来源」聚合视图即可秒开，不再被
 * 慢源冷启动（首次网络握手/模块加载，个别源可达 8s+）拖累。
 * 仅预热发现页（最常用入口），不预热搜索/详情，避免启动即打爆站点。
 */
export function warmupDiscover() {
  const metas = allJsSources();
  let started = 0;
  for (const meta of metas) {
    try {
      // allJsSources() 只给精简元数据；发现页需要完整实例（含 explore）。
      const js = getJsSource(meta.id);
      if (!js) continue;
      const tabs = jsDiscoverTabs(js);
      if (!tabs.length) continue;
      const ck = `${js.key}:0:1`;
      started++;
      const t0 = Date.now();
      // 单源 18s 超时，避免某个卡死的源长期占用连接
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('探测超时')), 18000));
      Promise.race([jsDiscoverLoad(js, 0, 1), timeout])
        .then((r) => {
          const ms = Date.now() - t0;
          const good = !!(r?.items?.length);
          sourceHealth[js.key] = { ok: good, ms, items: r?.items?.length || 0, at: Date.now() };
          if (good && !discoverCache.has(ck)) discoverCache.set(ck, { at: now(), data: { items: r.items, maxPage: r.maxPage } });
          saveHealth();
        })
        .catch((err) => {
          // 探测失败不立刻判死：若此前成功过且有缓存，标记为 stale（仍可用旧缓存）
          const wasOk = sourceHealth[js.key]?.ok;
          sourceHealth[js.key] = { ok: false, stale: !!wasOk, ms: Date.now() - t0, err: String(err?.message || err).slice(0, 80), at: Date.now() };
          saveHealth();
        });
    } catch { /* 单个源异常不影响其他 */ }
  }
  console.log(`[warmup] 在线源发现页预热 + 健康探测已启动（${metas.length} 个源，${started} 个有发现页）`);
  // 定时复检：让失效源在恢复后自动回血、健康状态保持最新
  if (!healthTimer) {
    healthTimer = setInterval(() => { warmupDiscover(); }, HEALTH_INTERVAL);
    healthTimer.unref?.();
  }
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
      health: sourceHealth[String(s.id).replace(/^js:/, '')] || null,
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

  // 源健康状态（后台每 20 分钟自动复检；前端据此显示正常/异常徽标）
  router.get('/health/all', (_req, res) => res.json({ health: sourceHealth }));
  // 手动触发重新探测所有源（前端「重新检测」按钮；即时回血）
  router.post('/health/recheck', (_req, res) => {
    warmupDiscover();
    res.json({ ok: true, started: true });
  });

  // 抽奖机：题材 / 类型清单（前端渲染选择题材用）
  router.get('/lottery/genres', (_req, res) => {
    res.json({ genres: LOTTERY_GENRES.map((g) => ({ id: g.id, label: g.label })) });
  });

  // 标签整合：所有源所有书的标签题材（抽奖机屏蔽设置用）
  // query: refresh=1 强制重新抓取
  router.get('/tags/all', async (req, res) => {
    try {
      const r = await collectAllTags(String(req.query.refresh || '') === '1');
      res.json({ tags: r.tags, cached: r.cached, sourceCount: allJsSources().length });
    } catch (err) { sourceError(res, err); }
  });

  // 标签整合：某个源所有书的标签（每个源的屏蔽设置用）
  // query: refresh=1 强制重新抓取
  router.get('/:id/tags', async (req, res) => {
    const js = jsOf(req.params.id);
    if (!js) return res.status(404).json({ error: '书源不存在' });
    const force = String(req.query.refresh || '') === '1';
    const hit = tagCache.get(req.params.id);
    if (!force && hit && now() - hit.at < TAG_CACHE_TTL) {
      return res.json({ tags: hit.tags, source: req.params.id, cached: true });
    }
    try {
      const tags = await Promise.race([
        jsCollectTags(js),
        new Promise((r) => setTimeout(() => r(null), TAG_FETCH_TIMEOUT)),
      ]);
      if (!tags || !tags.length) {
        // 抓取失败/超时：若有旧缓存则降级返回，否则给空清单
        if (hit) return res.json({ tags: hit.tags, source: req.params.id, cached: true, stale: true });
        return res.json({ tags: [], source: req.params.id, cached: false });
      }
      tagCache.set(req.params.id, { at: now(), tags });
      res.json({ tags, source: req.params.id, cached: false });
    } catch (err) { sourceError(res, err); }
  });

  // 抽奖机：从所有来源按题材抽取书籍，跨源按书名去重，返回多本推荐。
  // query: media=comic|novel|all, genres=hot,action(逗号分隔), count=12, refresh=1
  router.get('/lottery', async (req, res) => {
    const media = ['comic', 'novel', 'all'].includes(req.query.media) ? req.query.media : 'all';
    const count = Math.min(30, Math.max(1, parseInt(req.query.count, 10) || 12));
    const wanted = String(req.query.genres || '')
      .split(',').map((x) => x.trim()).filter(Boolean)
      .filter((id) => LOTTERY_GENRES.some((g) => g.id === id));
    // 「随便来点」或不选题材 → 不按题材过滤，走各源发现/热门
    const genreIds = wanted.filter((id) => id !== 'all');
    const aliases = genreIds.flatMap((id) => LOTTERY_GENRES.find((g) => g.id === id).aliases);
    const refresh = String(req.query.refresh || '') === '1';

    const poolKey = `${media}|${[...genreIds].sort().join(',')}`;
    let pool = lotteryPoolCache.get(poolKey);
    const poolWasCached = !refresh && !!pool && now() - pool.at <= LOTTERY_POOL_TTL;
    if (!poolWasCached) {
      const sources = allJsSources().filter((s) => media === 'all' || s.mediaType === media);
      const picked = await Promise.all(sources.map(async (meta) => {
        try {
          const js = getJsSource(meta.id);
          if (!js) return [];
          const entries = await jsLotteryGenreEntries(js);
          const eligible = entries.filter((e) => e.name !== '全部' && e.param);
          let items = [];
          if (aliases.length) {
            // 有题材：命中该题材的分类入口 → 拉取候选；同一题材该源的多个命中入口都取，凑够候选
            const hits = eligible.filter((e) => aliases.some((a) => e.name.toLowerCase().includes(a.toLowerCase())));
            for (const e of hits.slice(0, 3)) {
              try { items.push(...await jsLotteryLoad(js, e, 1)); } catch {}
            }
          }
          if (!items.length) {
            // 未选题材 / 题材在该源无分类入口 → 用发现页热门兜底
            const tabs = jsDiscoverTabs(js);
            const tabIdx = tabs.findIndex((t) => /热门|推荐|排行|最新|榜/.test(t.title));
            const r = await jsDiscoverLoad(js, Math.max(0, tabIdx), 1);
            items = r.items;
          }
          return items.map((it) => ({
            ...it,
            sourceId: meta.id,
            sourceName: meta.name,
            media: meta.mediaType,
          })).filter((it) => it.title && it.link);
        } catch { return []; }
      }));

      // 跨源去重：同一本书（归一化书名相同）只保留一条，优先保留有封面的
      const seen = new Map();
      for (const group of picked) {
        for (const it of group) {
          const k = normalizeBookTitle(it.title);
          if (!k) continue;
          const prev = seen.get(k);
          if (!prev || (!prev.cover && it.cover)) seen.set(k, it);
        }
      }
      pool = { at: now(), items: [...seen.values()] };
      if (pool.items.length) lotteryPoolCache.set(poolKey, pool);
    }

    // 屏蔽标签：命中任一带屏蔽标签的书直接剔除（对整池过滤，保证抽到的都不含屏蔽标签）
    const blocked = blockedSetOf(req.query);
    let candidates = blocked.size ? pool.items.filter((it) => !isTagBlocked(it.tags, blocked)) : pool.items.slice();

    // 每次抽奖做一次 Fisher-Yates 洗牌，从书池里取 count 本；请求数大于池子则允许重复源但书不重复
    const shuffled = candidates;
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const items = shuffled.slice(0, count).map((it) => ({
      ...it,
      coverProxy: it.cover
        ? `/api/online/img?sid=${encodeURIComponent(String(it.sourceId).replace(/^js:/, ''))}&u=${encodeURIComponent(it.cover)}`
        : '',
    }));
    res.json({ items, poolSize: candidates.length, media, genres: genreIds, cached: poolWasCached });
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
    const blocked = blockedSetOf(req.query);
    try {
      const tabs = jsDiscoverTabs(js);
      if (!tabs.length) return res.json({ tabs: [], items: [], maxPage: 1 });
      const tabIndex = Math.min(Math.max(0, parseInt(req.query.tab, 10) || 0), tabs.length - 1);
      const ck = `${js.key}:${tabIndex}:${page}`;
      const hit = discoverCache.get(ck);
      // 发现页部分源不给 tags：用标签整合时记录的书名→标签索引回填，屏蔽才能生效
      const enrich = (items) => jsTagsIndexApply(js.key, items || []);
      const applyBlock = (data) => ({
        ...data,
        items: (() => {
          const full = enrich(data.items);
          return blocked.size ? full.filter((it) => !isTagBlocked(it.tags, blocked)) : full;
        })(),
      });
      if (hit && now() - hit.at < DISCOVER_TTL) {
        return res.json({ ...applyBlock(hit.data), tabs, tab: tabIndex, cached: true });
      }
      const r = await jsDiscoverLoad(js, tabIndex, page);
      const data = { items: r.items, maxPage: r.maxPage };
      if (r.items && r.items.length) discoverCache.set(ck, { at: now(), data });
      return res.json({ ...applyBlock(data), tabs, tab: tabIndex });
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
    const blocked = blockedSetOf(req.query);
    if (!kw) return res.status(400).json({ error: '请输入搜索关键词' });
    const sck = `${req.params.id}:${kw}:${page}`;
    const sh = searchCache.get(sck);
    const jsInst = jsOf(req.params.id);
    const enrich = (items) => jsInst ? jsTagsIndexApply(jsInst.key, items || []) : (items || []);
    const applyBlock = (data) => ({
      ...data,
      items: (() => {
        const full = enrich(data.items);
        return blocked.size ? full.filter((it) => !isTagBlocked(it.tags, blocked)) : full;
      })(),
    });
    if (sh && now() - sh.t < SEARCH_TTL) return res.json({ ...applyBlock(sh.data), cached: true });
    try {
      const js = jsInst;
      if (js) {
        const items = await jsSearch(js, kw, page);
        const data = { items };
        if (items.length) { searchCache.set(sck, { t: now(), data }); if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value); }
        return res.json(applyBlock(data));
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
        // pstatic.net 图片在服务器端部署网络被封锁，代理必失败；改让浏览器直连原图
        return res.json({
          images: images.map((u) => /^https?:\/\/[a-z0-9.-]*pstatic\.net\//i.test(u)
            ? u
            : `/api/online/img?sid=${encodeURIComponent(js.key)}&u=${encodeURIComponent(u)}`),
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
    const taskId = String(req.query.taskId || '');
    res.json(getImportProgress(req.user.id, taskId) || { idle: true });
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
      const taskId = String(b.taskId || '');
      setImportProgress(req.user.id, taskId, {
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
        }, (pg) => setImportProgress(req.user.id, taskId, {
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
