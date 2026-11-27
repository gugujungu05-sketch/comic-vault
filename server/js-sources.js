/**
 * 在线书源 · JS 脚本引擎（书源脚本从 Ciallo-Reader 项目直接搬移，MIT 许可）。
 *
 * Ciallo 的书源是面向 JS 宿主编写的脚本：脚本里 `class X extends ComicSource`，
 * 依赖宿主提供的全局 API：
 *   - Network.get(url, headers) / Network.post(url, headers, body) → { status, body }
 *   - Network.getCookies(url) / Network.setCookies(url, cookies)（按源隔离的 cookie 罐）
 *   - HtmlDocument(html)：querySelector / querySelectorAll / dispose，节点有 .text 与 .attributes
 *   - Comic / ComicDetails / ImageLoadingConfig：轻量数据构造器
 *   - 源实例上的 saveData(key, value) / loadData(key)：按源持久化的小键值存储
 *
 * 宿主实现原则：脚本在受限 VM 里运行，没有 require / process / fs，
 * 网络只经 Network shim（自动带源站 cookie、超时保护）。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { DATA_DIR } from './store.js';

/* MangaFire 源需要动态 VRF token（站点 VM 混淆算法 + Cloudflare），
   由独立桥接模块按需启动无头浏览器生成并磁盘缓存。此处仅在沙箱里暴露一个
   async 方法，源脚本不接触进程/文件系统。 */
const __require = createRequire(import.meta.url);
let _mangaFireVrf = null;
function mangaFireVrf() {
  if (!_mangaFireVrf) {
    try { _mangaFireVrf = __require('./mangafire-vrf.cjs'); }
    catch (e) { console.error('[mangafire] VRF 桥接加载失败:', e.message); _mangaFireVrf = { generate: async () => { throw new Error('VRF 服务不可用'); } }; }
  }
  return _mangaFireVrf;
}

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'js-sources');
const COOKIE_FILE = path.join(DATA_DIR, 'js-source-cookies.json');
const DATA_FILE = path.join(DATA_DIR, 'js-source-data.json');
/* 书名→标签索引：标签整合时顺带记录，发现/搜索结果缺 tags 时据此回填，
   让「带该标签的书不出现」对不返回 tags 的列表也生效。按源隔离，持久化。 */
const TAG_INDEX_FILE = path.join(DATA_DIR, 'js-source-tag-index.json');
const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 30000;

/* ------------------------------ 持久化：cookie 罐 + 源数据 ------------------------------ */

function readJsonMap(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function writeJsonMap(file, map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}
let cookieMap = readJsonMap(COOKIE_FILE);
let dataMap = readJsonMap(DATA_FILE);
let tagIndexMap = readJsonMap(TAG_INDEX_FILE); // { [sourceKey]: { [normalizedTitle]: tags[] } }
const saveSoon = (file, map) => writeJsonMap(file, map); // 写入量小，直接同步落盘

/** 简单书名归一化：去空白/标点、小写（与前端/后端屏蔽归一化一致） */
function normBookKey(t) {
  return String(t || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 给某个源记录「书名→标签」，供发现/搜索结果缺 tags 时回填 */
function recordTagIndex(sourceKey, items) {
  const bucket = tagIndexMap[sourceKey] || (tagIndexMap[sourceKey] = {});
  let changed = false;
  for (const it of items) {
    const k = normBookKey(it.title);
    if (!k) continue;
    const tags = flattenTagsSafe(it.tags);
    if (tags.length && JSON.stringify(bucket[k]) !== JSON.stringify(tags)) {
      bucket[k] = tags;
      changed = true;
    }
  }
  if (changed) saveSoon(TAG_INDEX_FILE, tagIndexMap);
}

/** flattenTags 的安全别名（此函数定义在前文 normalizeTag 区，但 hoist 用函数声明） */
function flattenTagsSafe(tags) {
  if (Array.isArray(tags)) return tags.map(String);
  if (tags && typeof tags === 'object') return Object.values(tags).flat().map(String);
  return [];
}

/** 用已记录的索引给列表项回填 tags（仅当该项自身没有 tags 时） */
export function jsTagsIndexApply(sourceKey, items) {
  const bucket = tagIndexMap[sourceKey];
  if (!bucket) return items;
  return items.map((it) => {
    if (it.tags && it.tags.length) return it;
    const indexed = bucket[normBookKey(it.title)];
    return indexed && indexed.length ? { ...it, tags: indexed } : it;
  });
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function cookiesFor(key, url) {
  const host = domainOf(url);
  const list = cookieMap[key] || [];
  return list.filter((c) => !c.domain || host.endsWith(String(c.domain).replace(/^\./, '')));
}

/* ------------------------------ HtmlDocument：cheerio 适配 ------------------------------ */

class HtmlElement {
  constructor($, el) {
    this.$ = $;
    this.raw = el;
    const node = el ? (el.type === 'root' ? null : el) : null;
    this.attributes = node && node.attribs ? { ...node.attribs } : {};
    this.text = el ? $(el).text() : '';
  }
  querySelector(sel) {
    const found = this.$(this.raw || ':root').find(sel).first();
    return found.length ? new HtmlElement(this.$, found.get(0)) : null;
  }
  querySelectorAll(sel) {
    return this.$(this.raw || ':root')
      .find(sel)
      .toArray()
      .map((e) => new HtmlElement(this.$, e));
  }
  dispose() { /* cheerio 无需释放 */ }
}

class HtmlDocument {
  constructor(html) {
    this.$ = cheerio.load(String(html || ''));
    this.rootEl = this.$.root().get(0);
  }
  querySelector(sel) {
    const found = this.$(sel).first();
    return found.length ? new HtmlElement(this.$, found.get(0)) : null;
  }
  querySelectorAll(sel) {
    return this.$(sel)
      .toArray()
      .map((e) => new HtmlElement(this.$, e));
  }
  dispose() { /* noop */ }
}

/* ------------------------------ Network shim ------------------------------ */

/* 书源 HTTP 响应缓存：发现页/详情/章节等 GET 请求重复率高，短时缓存可显著降低卡顿与站点压力。
   只对无请求体的 GET 生效；带 Cookie 的响应分开缓存，避免串号。 */
const HTTP_CACHE = new Map();
// 源站（尤其 woimh 首页可达 11s）重复抓取代价高，延长 GET 缓存到 5 分钟，
// 发现页/搜索/详情二次打开直接命中，显著改善「在线来源加载太慢」。
const HTTP_CACHE_TTL = 5 * 60 * 1000;
function httpCacheKey(url, headers, sourceKey) {
  const ck = Object.entries(headers || {})
    .filter(([k]) => /cookie/i.test(k))
    .map(([k, v]) => `${k}=${v}`).join(';');
  return `${sourceKey}|${url}|${ck}`;
}

async function httpRequest(method, url, headers = {}, body = undefined, sourceKey = '') {
  /* GET 命中缓存直接返回（复制对象，避免调用方改写污染缓存） */
  const cacheable = (!method || method.toUpperCase() === 'GET') && body == null;
  const ckey = cacheable ? httpCacheKey(url, headers, sourceKey) : '';
  if (cacheable) {
    const hit = HTTP_CACHE.get(ckey);
    if (hit && Date.now() - hit.t < HTTP_CACHE_TTL) return { ...hit.v };
  }
  // 请求头/正文提前准备一次，重试时复用。
  const cookie = cookiesFor(sourceKey, url)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const head = { 'User-Agent': UA_DEFAULT, ...headers };
  if (cookie && !Object.keys(head).some((k) => k.toLowerCase() === 'cookie')) head.Cookie = cookie;
  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') payload = body;
    else if (Buffer.isBuffer(body)) payload = body;
    else {
      const ct = Object.keys(head).find((k) => k.toLowerCase() === 'content-type') || '';
      payload = /json/i.test(ct) ? JSON.stringify(body) : new URLSearchParams(body).toString();
      if (!ct) head['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  /* 自愈：瞬时网络错误（连接重置/DNS抖动/连接中断）自动重试一次；
     请求超时不重试，避免等待翻倍。站点偶发抖动占失效场景的大头。 */
  const attempts = 2;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { method, headers: head, body: payload, redirect: 'follow', signal: ctrl.signal });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const dmatch = raw.match(/domain=([^;]+)/i);
        const list = cookieMap[sourceKey] || (cookieMap[sourceKey] = []);
        const item = { name, value, domain: dmatch ? dmatch[1].trim() : domainOf(url) };
        const i = list.findIndex((c) => c.name === name && (c.domain || domainOf(url)).replace(/^\./, '') === item.domain.replace(/^\./, ''));
        if (i >= 0) list[i] = item; else list.push(item);
      }
      if (setCookies.length) saveSoon(COOKIE_FILE, cookieMap);
      const buf = await res.arrayBuffer();
      const bytes = Buffer.from(buf);
      // bytes 供需要按指定编码解码的源使用（如拷贝轻小说 GBK 正文 txt）；
      // body 仍是 utf8 字符串，保持对所有现有源的行为不变。
      const out = { status: res.status, body: bytes.toString('utf8'), bytes: new Uint8Array(bytes), url: res.url || url };
      if (cacheable && res.status >= 200 && res.status < 400) {
        HTTP_CACHE.set(ckey, { t: Date.now(), v: { ...out } });
        if (HTTP_CACHE.size > 300) {
          const t = Date.now();
          for (const [k, x] of HTTP_CACHE) if (t - x.t > HTTP_CACHE_TTL) HTTP_CACHE.delete(k);
        }
      }
      return out;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      // 只对真正的网络层错误重试；超时（我们主动 abort）不重试。
      const transient = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang|terminated|network/i.test(msg);
      if (attempt + 1 < attempts && transient) {
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  /* 网络失败时若有过期缓存，降级返回旧内容，避免因单点抖动导致整页卡死 */
  if (cacheable) {
    const stale = HTTP_CACHE.get(ckey);
    if (stale) return { ...stale.v };
  }
  throw lastErr;
}

/* ------------------------------ Convert：Ciallo 宿主提供的同步编解码工具 ------------------------------ */
/** 把脚本传入的字节兼容形态统一成 Buffer */
function cvBytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (typeof v === 'string') return Buffer.from(v, 'binary');
  return Buffer.alloc(0);
}
const Convert = {
  encodeUtf8: (s) => new Uint8Array(Buffer.from(String(s ?? ''), 'utf8')),
  decodeUtf8: (v) => cvBytes(v).toString('utf8'),
  encodeGbk: (s) => new Uint8Array(iconv.encode(String(s ?? ''), 'gbk')),
  decodeGbk: (v) => iconv.decode(cvBytes(v), 'gbk'),
  encodeBase64: (v) => cvBytes(v).toString('base64'),
  decodeBase64: (v) => new Uint8Array(Buffer.from(String(v ?? ''), 'base64')),
  md5: (v) => crypto.createHash('md5').update(cvBytes(v)).digest('hex'),
  sha1: (v) => crypto.createHash('sha1').update(cvBytes(v)).digest('hex'),
  sha256: (v) => crypto.createHash('sha256').update(cvBytes(v)).digest('hex'),
  /* HMAC 摘要（拷贝/热辣等国内源的请求签名依赖；algo 默认 sha256）。
     key/message 都走 cvBytes，兼容 Uint8Array / Buffer / 字符串。 */
  hmacString: (key, msg, algo) => {
    try {
      const alg = String(algo || 'sha256').toLowerCase();
      return crypto.createHmac(alg, cvBytes(key)).update(cvBytes(msg)).digest('hex');
    } catch { return ''; }
  },
  decryptAesCbc: (value, key, iv) => {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', cvBytes(key), cvBytes(iv));
      const out = Buffer.concat([decipher.update(cvBytes(value)), decipher.final()]);
      return new Uint8Array(out);
    } catch {
      return new Uint8Array(0);
    }
  },
  decryptAesEcb: (value, key) => {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', cvBytes(key), null);
      return new Uint8Array(Buffer.concat([decipher.update(cvBytes(value)), decipher.final()]));
    } catch { return new Uint8Array(0); }
  },
};

/* ------------------------------ 源加载 ------------------------------ */

function buildSandbox(sourceKey) {
  const jarApi = {
    async get(url) { return cookiesFor(sourceKey, url); },
    setCookies(url, cookies) {
      const list = cookieMap[sourceKey] || (cookieMap[sourceKey] = []);
      for (const c of cookies || []) {
        const i = list.findIndex((x) => x.name === c.name);
        if (i >= 0) list[i] = { name: c.name, value: c.value, domain: c.domain || domainOf(url) };
        else list.push({ name: c.name, value: c.value, domain: c.domain || domainOf(url) });
      }
      saveSoon(COOKIE_FILE, cookieMap);
    },
  };
  const sandbox = {
    Network: {
      get: (url, headers) => httpRequest('GET', url, headers, undefined, sourceKey),
      post: (url, headers, body) => httpRequest('POST', url, headers, body, sourceKey),
      /* Venera 系源（漫蛙等）用的通用请求：method/url/headers/payload。 */
      sendRequest: (method, url, headers, payload) => {
        const m = String(method || 'GET').toUpperCase();
        const body = (payload === undefined || payload === null) ? undefined : payload;
        return httpRequest(m, String(url || ''), headers || {}, body, sourceKey);
      },
      getCookies: jarApi.get,
      setCookies: jarApi.setCookies,
    },
    HtmlDocument,
    Convert,
    /** Ciallo 宿主的通用同步消息桥：脚本用它发 HTTP（pufei 等源依赖）。
     *  仅支持这里用到的 http GET，返回宿主结构化结果 {status,body,url,ok}。 */
    sendMessage: async (msg) => {
      if (msg && msg.method === 'http') {
        const r = await httpRequest(String(msg.http_method || 'GET').toUpperCase(), String(msg.url || ''), msg.headers || {});
        return { status: r.status, body: r.body, url: r.url, ok: r.status >= 200 && r.status < 300 };
      }
      return { error: 'unsupported sendMessage method' };
    },
    Comic: function Comic(o) { return o || {}; },
    ComicDetails: function ComicDetails(o) { return o || {}; },
    ImageLoadingConfig: function ImageLoadingConfig(o) { return o || {}; },
    /** MangaFire 专用：生成带 vrf 的 API 路径。返回形如 /api/titles?...&vrf=... */
    MangaFireVrf: {
      generate: (action, value, page) => mangaFireVrf().generate(action, value, page),
    },
    setTimeout, clearTimeout, setInterval: undefined, clearInterval: undefined,
    /* Venera 系源用来生成设备指纹/盐值：randomInt(min,max) 闭区间整数。 */
    randomInt: (min, max) => {
      const lo = Math.ceil(Number(min) || 0), hi = Math.floor(Number(max) || 0);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Math, Date, URL, URLSearchParams, Number, String, Array, Object, Map, Set, RegExp,
    Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    Uint8Array, Promise, Symbol, Boolean,
  };
  return sandbox;
}

/** 每个脚本一个 VM 上下文（脚本间完全隔离），实例化其中 extends ComicSource 的类 */
const loaded = new Map(); // key -> { source, script, version }

export function loadJsSources() {
  if (!fs.existsSync(SRC_DIR)) return [];
  for (const name of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'))) {
    const file = path.join(SRC_DIR, name);
    const code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const classNameMatch = code.match(/class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource/);
    if (!classNameMatch) continue;
    const className = classNameMatch[1];
    const probe = new vm.Script('class ComicSource {}\n' + code + `\n;${className};`);
    let ctor;
    try {
      const sandbox = buildSandbox('__probe__');
      vm.createContext(sandbox);
      ctor = probe.runInContext(sandbox);
    } catch (err) {
      console.error('[js-sources] 脚本加载失败:', name, err.message);
      continue;
    }
    try {
      const sandbox = buildSandbox(`js:${ctor.key || name.replace(/\.js$/, '')}`);
      sandbox.ComicSource = class ComicSource {
        saveData(k, v) {
          const m = dataMap[ctor.key] || (dataMap[ctor.key] = {});
          m[k] = v;
          saveSoon(DATA_FILE, dataMap);
        }
        loadData(k) {
          const m = dataMap[ctor.key] || {};
          return m[k] === undefined ? null : m[k];
        }
        deleteData(k) {
          const m = dataMap[ctor.key] || (dataMap[ctor.key] = {});
          delete m[k];
          saveSoon(DATA_FILE, dataMap);
        }
        /* Venera 源的设置读取：本项目无逐源设置 UI，回退到 loadData，
           让源用默认值运行；若用户手工存过同名 data 也会生效。 */
        loadSetting(k) {
          const m = dataMap[ctor.key] || {};
          return m[k] === undefined ? null : m[k];
        }
      };
      vm.createContext(sandbox);
      const script = new vm.Script(code + `\n;new ${className}();`);
      const source = script.runInContext(sandbox);
      loaded.set(source.key, { source, sandbox, name });
    } catch (err) {
      console.error('[js-sources] 实例化失败:', name, err.message);
    }
  }
  return allJsSources();
}

export function allJsSources() {
  return [...loaded.values()].map(({ source }) => ({
    id: `js:${source.key}`,
    name: source.name,
    baseUrl: source.baseUrl,
    version: source.version || '',
    mediaType: source.mediaType === 'novel' ? 'novel' : 'comic',
    kind: 'js',
    builtin: true,
  }));
}

export function getJsSource(idOrKey) {
  const key = String(idOrKey || '').replace(/^js:/, '');
  return loaded.get(key)?.source || null;
}

/* ------------------------------ 面向路由的高层操作 ------------------------------ */

function headersOf(config) {
  // onImageLoad/onThumbnailLoad 返回 ImageLoadingConfig({url, headers}) 或 {headers}
  return (config && config.headers) || {};
}

/** 搜索：返回统一结构 { title, link, cover, author?, latestChapter? } */
export async function jsSearch(source, keyword, page = 1) {
  const out = await source.search.load(keyword, [], page);
  const comics = Array.isArray(out) ? out : out?.comics || [];
  return comics.map((c) => ({
    title: c.title || '',
    link: String(c.id || ''),
    cover: c.cover || '',
    author: c.author || '',
    latestChapter: c.latestChapter || null,
    tags: Array.isArray(c.tags) ? c.tags.map(String)
      : (c.tags && typeof c.tags === 'object' ? Object.values(c.tags).flat().map(String) : []),
  }));
}

/** 章节按标题话数升序排列。
 *  部分源详情页把第 1 话置顶、其余倒序（如 rawkuma 的 Odaroku：1,8,7,6…），
 *  框架层按 HTML 出现顺序输出就会乱序。
 *  为安全起见，仅当「所有标题都能解析出唯一数字」且「当前确实非升序」时才排序：
 *  分卷、番外、无数字标题等保持源站原顺序。 */
function sortChaptersByNumber(chapters) {
  if (!Array.isArray(chapters) || chapters.length < 2) return chapters;
  const keys = chapters.map((c) => {
    const m = String(c && c.title || "").match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  });
  if (keys.some((k) => k === null)) return chapters;          // 有标题无数字 → 保持源站顺序
  if (new Set(keys).size !== keys.length) return chapters;    // 数字重复（分卷/重话） → 保持源站顺序
  let needSort = false;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] < keys[i - 1]) { needSort = true; break; }
  }
  if (!needSort) return chapters;                             // 已升序 → 不改动
  return chapters
    .map((c, i) => ({ c, k: keys[i], i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)                   // 稳定排序
    .map((x) => x.c);
}

/** 详情：ComicDetails → {title, cover, url, chapters:[{title,url}], author, description, tags} */
export async function jsComicDetail(source, bookId) {
  const info = await source.comic.loadInfo(bookId);
  const chaptersMap = info.chapters && typeof info.chapters === 'object' ? info.chapters : null;
  const tagsObj = info.tags && !Array.isArray(info.tags) ? info.tags : null;
  const tags = Array.isArray(info.tags)
    ? info.tags
    : tagsObj
      ? Object.entries(tagsObj).flatMap(([g, arr]) => (Array.isArray(arr) ? arr : []).map((t) => (arr.length > 1 ? `${g}:${t}` : t)))
      : [];
  return {
    title: info.title || '',
    cover: info.cover || '',
    url: info.url || '',
    author: info.author || (tagsObj?.['作者']?.[0] ?? ''),
    description: info.description || '',
    tags,
    kind: info.mediaType === 'novel' || source.mediaType === 'novel' ? 'novel' : 'comic',
    chapters: chaptersMap
      ? sortChaptersByNumber(Object.entries(chaptersMap).map(([p, t], i) => ({ title: String(t || `第 ${i + 1} 话`), url: String(p) })))
      : null, // null = 小说整本（EPUB）下载
  };
}

/** 某一话的图片地址列表（在线阅读 / 导入共用） */
export async function jsChapterImages(source, bookId, chapterPath) {
  const r = await source.comic.loadEp(bookId, chapterPath);
  const images = Array.isArray(r) ? r : r?.images || [];
  if (!images.length) throw new Error('这一话没有解析到图片');
  const cfg = source.comic.onImageLoad ? headersOf(source.comic.onImageLoad(images[0])) : {};
  return { images: images.map(String), headers: cfg, decode: jsImageDecode(source) };
}

/** 图片下载所需的请求头（防盗链 Referer 等） */
export function jsImageHeaders(source, url) {
  try {
    if (source.comic?.onImageLoad) return headersOf(source.comic.onImageLoad(url));
  } catch { /* 源脚本异常时不拦截 */ }
  return {};
}

/** 书源声明的图片字节解码方案（如爱漫画 sub=47 xor=171），供后端还原混淆图片 */
export function jsImageDecode(source) {
  try {
    const d = source?.imageDecode;
    if (!d) return null;
    // AES-CBC 方案（漫蛙等）：{ aes: { key, iv } }
    if (d.aes && d.aes.key) return { aes: { key: String(d.aes.key), iv: d.aes.iv ? String(d.aes.iv) : String(d.aes.key) } };
    if (Number.isFinite(Number(d.sub)) && Number.isFinite(Number(d.xor))) {
      return { sub: Number(d.sub), xor: Number(d.xor) };
    }
  } catch { /* 源脚本异常时不拦截 */ }
  return null;
}

/** 小说整本 EPUB 下载信息 */
export async function jsNovelDownload(source, bookId) {
  if (!source.comic.downloadBook) return null;
  const d = await source.comic.downloadBook(bookId);
  return d && (d.url || d.textNovel) ? d : null;
}

/** 发现页：返回书源的 explore 分类列表；load(tabIndex, page) 取某一分类的漫画列表 */
export function jsDiscoverTabs(source) {
  const ex = source.explore || source.discover || [];
  return Array.isArray(ex) ? ex.map((e, i) => ({ index: i, title: e.title || `分类 ${i + 1}`, type: e.type || '' })) : [];
}
export async function jsDiscoverLoad(source, tabIndex, page = 1) {
  const ex = source.explore || source.discover || [];
  const tab = ex[tabIndex];
  if (!tab || typeof tab.load !== 'function') throw new Error('这个来源没有可浏览的分类');
  const out = await tab.load(Math.max(1, Number(page) || 1));
  let comics;
  if (Array.isArray(out)) comics = out;
  else if (out?.comics) comics = out.comics;
  else {
    // singlePageWithMultiPart：{ "分组名": [cards], ... } —— 把所有分组的卡片合并
    // 兼容 vomic 等源的「账号 / 注册引导」多分区结构，避免发现页 tab 空白。
    comics = [];
    if (out && typeof out === 'object') {
      for (const key of Object.keys(out)) {
        const v = out[key];
        if (Array.isArray(v)) comics.push(...v);
      }
    }
  }
  return {
    items: toComicItems(comics),
    maxPage: Math.max(1, Number(out?.maxPage) || page),
  };
}

/** Comic[] → 统一的书籍列表项（搜索 / 发现 / 抽奖共用） */
function toComicItems(comics) {
  return (Array.isArray(comics) ? comics : []).map((c) => ({
    title: c.title || '',
    link: String(c.id || ''),
    cover: c.cover || '',
    author: c.author || '',
    latestChapter: c.latestChapter || null,
    tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 6)
      : (c.tags && typeof c.tags === 'object' ? Object.values(c.tags).flat().map(String).slice(0, 6) : []),
  }));
}

/** 抽奖机：枚举某个源支持的分类/题材入口。
 *  fixed 分类直接取 categories/categoryParams；dynamic 分类调用 loader() 展开。
 *  返回 [{ part, name, param }]，供后端按题材别名匹配。 */
export async function jsLotteryGenreEntries(source) {
  const cat = source.category;
  const out = [];
  if (!cat || !Array.isArray(cat.parts)) return out;
  for (const part of cat.parts) {
    if (!part) continue;
    if (Array.isArray(part.categories)) {
      const params = Array.isArray(part.categoryParams) ? part.categoryParams : [];
      part.categories.forEach((name, i) => {
        if (name) out.push({ part: part.name, name: String(name), param: String(params[i] ?? name) });
      });
    } else if (typeof part.loader === 'function') {
      try {
        const rows = await part.loader();
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const label = r && (r.label || r.name || r.title);
          const attrs = r && r.target && r.target.attributes;
          const param = attrs && (attrs.param || attrs.category);
          if (label) out.push({ part: part.name, name: String(label), param: String(param || label) });
        }
      } catch { /* 单个动态分类失败不影响该源其它题材 */ }
    }
  }
  return out;
}

/** 抽奖机：按某个分类入口加载一页书（categoryComics.load(category, param, options, page)） */
export async function jsLotteryLoad(source, entry, page = 1) {
  const cc = source.categoryComics;
  if (!cc || typeof cc.load !== 'function') throw new Error('该源不支持分类加载');
  const out = await cc.load(entry.part, entry.param, [], Math.max(1, Number(page) || 1));
  const comics = Array.isArray(out) ? out : (out && Array.isArray(out.comics) ? out.comics : []);
  return toComicItems(comics);
}

/** 标签归一化：去掉空白/标点/符号并转小写，用于跨源合并与屏蔽匹配 */
export function normalizeTag(t) {
  return String(t || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 把书上的 tags（数组或 {分组:[...]} 对象）摊平成字符串数组 */
export function flattenTags(tags) {
  if (Array.isArray(tags)) return tags.map(String);
  if (tags && typeof tags === 'object') return Object.values(tags).flat().map(String);
  return [];
}

/** 一本书是否命中屏蔽标签：任一标签归一化后等于/包含屏蔽项即视为命中。
 *  blocked 为 normalizeTag 后的集合。 */
export function isTagBlocked(tags, blocked) {
  if (!blocked || !blocked.size) return false;
  return flattenTags(tags).some((t) => {
    const n = normalizeTag(t);
    if (!n) return false;
    for (const b of blocked) if (b && (n === b || n.includes(b))) return true;
    return false;
  });
}

/** 只取一本书详情的 tags（不解析章节，避免慢/失败影响题材聚合）。
 *  兼容数组与 { 分组: [标签] } 两种结构。 */
async function jsDetailTagsOnly(source, bookId) {
  // 轻量钩子：某些源（如 MangaFire）loadInfo 会连带抓全部章节（慢/依赖 VRF），
  // 提供 tagHints 只取详情题材，避免为了题材去抓章节。
  if (typeof source.tagHints === 'function') {
    try {
      const fast = await source.tagHints(bookId);
      if (Array.isArray(fast)) return fast.map(String).filter(Boolean);
    } catch { /* 落到 loadInfo 兜底 */ }
  }
  if (!source.comic || typeof source.comic.loadInfo !== 'function') return [];
  try {
    const info = await source.comic.loadInfo(bookId);
    const raw = info && info.tags;
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (raw && typeof raw === 'object') {
      return Object.values(raw).flat().map(String).filter(Boolean);
    }
  } catch { /* 单本详情失败不影响题材聚合 */ }
  return [];
}

/** 聚合某个源「所有书」的标签题材：分类题材名 + 各分类入口/发现页第一页的书籍 tags。
 *  题材主要来自分类入口与列表；但不少源（拷贝系/轻小说/MangaFire/漫蛙等）列表卡片
 *  不带题材、题材只在详情页，此时抽样若干本书的详情补全，并写入书名→标签索引供列表回填。
 *  返回 [{ tag, count }]（tag 保留原文用于展示），按词频降序。慢，由调用方做缓存与超时。 */
export async function jsCollectTags(source) {
  const counter = new Map();
  const add = (t) => {
    const s = String(t || '').trim();
    if (!s || s.length > 24) return;
    if (!normalizeTag(s)) return;
    counter.set(s, (counter.get(s) || 0) + 1);
  };
  const sourceKey = source.key;

  // 1) 分类题材入口名（最稳定的题材标签来源，成本低）
  let entries = [];
  try { entries = await jsLotteryGenreEntries(source); } catch { /* 单个源失败不影响其它 */ }
  for (const e of entries) if (e.name && e.name !== '全部') add(e.name);

  // 2) 各分类入口第一页书籍 tags（限量并发，避免站点压力过大）；同时记录书名→标签
  const picked = entries.filter((e) => e.name !== '全部' && e.param).slice(0, 12);
  await Promise.all(picked.map(async (e) => {
    try {
      const items = await jsLotteryLoad(source, e, 1);
      recordTagIndex(sourceKey, items);
      for (const it of items) for (const t of (it.tags || [])) add(t);
    } catch { /* 忽略单个分类失败 */ }
  }));

  // 3) 发现页各 tab 第一页书籍 tags；同时记录书名→标签与候选书籍（供详情补标签）
  let tabs = [];
  try { tabs = jsDiscoverTabs(source); } catch { /* 忽略 */ }
  const candidates = []; // { title, link }，去重后用于详情抽样
  const seenBook = new Set();
  await Promise.all(tabs.slice(0, 8).map(async (tab) => {
    try {
      const r = await jsDiscoverLoad(source, tab.index, 1);
      recordTagIndex(sourceKey, r.items || []);
      for (const it of (r.items || [])) {
        for (const t of (it.tags || [])) add(t);
        const link = String(it.link || '');
        if (link && !seenBook.has(link)) {
          seenBook.add(link);
          candidates.push({ title: it.title, link });
        }
      }
    } catch { /* 忽略单个 tab 失败 */ }
  }));

  // 4) 详情抽样补标签：列表卡片不带题材的源，从详情提取真实题材。
  //    仅在已收集标签偏少（< 3）时触发，限量 12 本、并发 4，避免对站点压力过大。
  if (counter.size < 3 && candidates.length) {
    const sample = candidates.slice(0, 12);
    let idx = 0;
    const workers = Array.from({ length: Math.min(4, sample.length) }, async () => {
      while (idx < sample.length) {
        const b = sample[idx++];
        const tags = await jsDetailTagsOnly(source, b.link);
        if (!tags.length) continue;
        // 记录书名→标签，供发现/搜索/抽奖列表回填
        recordTagIndex(sourceKey, [{ title: b.title, tags }]);
        for (const t of tags) add(t);
      }
    });
    await Promise.all(workers);
  }

  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 为某个 JS 源设置站点登录 Cookie（书源账号登录入口用）。
 *  cookieString 形如 "a=1; b=2"，按源域名存入该源的 cookie 罐，之后该源所有请求自动带上。 */
export function jsSetSourceCookies(sourceKey, cookieString, domain) {
  const key = String(sourceKey || '').replace(/^js:/, '');
  if (!key) return { ok: false, error: '缺少来源标识' };
  const raw = String(cookieString || '').trim();
  if (!raw) {
    delete cookieMap[key];
    saveSoon(COOKIE_FILE, cookieMap);
    return { ok: true, cleared: true };
  }
  // 兜底域名：优先用传入值，否则用源对象的 baseUrl
  let dm = String(domain || '').trim();
  if (!dm) {
    try { const s = getJsSource('js:' + key); dm = s && s.baseUrl ? new URL(s.baseUrl).hostname : ''; } catch { /* 忽略 */ }
  }
  const cookies = raw.split(';').map((p) => {
    const i = p.indexOf('=');
    const name = (i >= 0 ? p.slice(0, i) : p).trim();
    const value = i >= 0 ? p.slice(i + 1).trim() : '';
    if (!name) return null;
    return { name, value, domain: dm ? (dm.startsWith('.') ? dm : '.' + dm) : '', path: '/' };
  }).filter(Boolean);
  cookieMap[key] = cookies;
  saveSoon(COOKIE_FILE, cookieMap);
  return { ok: true, count: cookies.length, domain: dm };
}

/** 查询某源的登录态：cookie 罐条数 + dataMap 里的 token/凭据键。
 *  只返回布尔/计数，绝不返回 Cookie 或 token 的值，供前端「站点账号」显示是否已生效。 */
export function jsSourceLoginStatus(sourceKey) {
  const key = String(sourceKey || '').replace(/^js:/, '');
  if (!key) return { loggedIn: false, cookieCount: 0, credentialCount: 0 };
  const cookieCount = (cookieMap[key] || []).length;
  const data = dataMap[key] || {};
  // 常见凭据键：token / token_* / cookie / phpsessid / authorization / username 等，避免把普通设置误算登录
  const credentialKeys = Object.keys(data).filter((k) => /token|cookie|session|auth|password|passwd|username|user/i.test(k) && data[k]);
  return {
    loggedIn: cookieCount > 0 || credentialKeys.length > 0,
    cookieCount,
    credentialCount: credentialKeys.length,
  };
}

/** 清除某源的全部登录态：cookie 罐 + dataMap 里的凭据键。
 *  与「保存空 Cookie」兼容：旧逻辑只清 cookie，这里连 token 一起清，做到真正的一键退出。 */
export function jsClearSourceLogin(sourceKey) {
  const key = String(sourceKey || '').replace(/^js:/, '');
  if (!key) return { ok: false, error: '缺少来源标识' };
  const hadCookie = !!(cookieMap[key] && cookieMap[key].length);
  delete cookieMap[key];
  const data = dataMap[key] || {};
  let cleared = 0;
  for (const k of Object.keys(data)) {
    if (/token|cookie|session|auth|password|passwd|username|user/i.test(k)) { delete data[k]; cleared += 1; }
  }
  saveSoon(COOKIE_FILE, cookieMap);
  saveSoon(DATA_FILE, dataMap);
  return { ok: true, clearedCredentials: cleared, hadCookie };
}

/** 源账号密码登录：调用源脚本 account.login（如拷贝/热辣/vomic），凭据由源自行 saveData 持久化。
 *  返回 { ok, message }。用户可选用，非强制——登录只为同步书架/解锁受限内容。 */
export async function jsAccountLogin(sourceKey, account, password) {
  const key = String(sourceKey || '').replace(/^js:/, '');
  const s = getJsSource('js:' + key);
  if (!s) return { ok: false, error: '来源不存在' };
  if (!s.account || typeof s.account.login !== 'function') {
    return { ok: false, error: '这个来源不支持账号密码登录，请用「打开官网登录」后粘贴 Cookie' };
  }
  try {
    await s.account.login(String(account || '').trim(), String(password || ''));
    return { ok: true, message: '登录成功，登录态已保存' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || '登录失败') };
  }
}

/** 源的官网登录地址（供前端「打开官网登录」用） */
export function jsRegisterWebsite(sourceKey) {
  const key = String(sourceKey || '').replace(/^js:/, '');
  const s = getJsSource('js:' + key);
  if (!s) return '';
  try { return s.account?.registerWebsite || s.url || s.baseUrl || ''; } catch { return ''; }
}
