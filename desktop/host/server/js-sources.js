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
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { DATA_DIR } from './store.js';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'js-sources');
const COOKIE_FILE = path.join(DATA_DIR, 'js-source-cookies.json');
const DATA_FILE = path.join(DATA_DIR, 'js-source-data.json');
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
const saveSoon = (file, map) => writeJsonMap(file, map); // 写入量小，直接同步落盘

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
const HTTP_CACHE_TTL = 60 * 1000;
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), FETCH_TIMEOUT);
  try {
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
    const res = await fetch(url, {
      method,
      headers: head,
      body: payload,
      redirect: 'follow',
      signal: ctrl.signal,
    });
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
    const out = { status: res.status, body: Buffer.from(buf).toString('utf8'), url: res.url || url };
    if (cacheable && res.status >= 200 && res.status < 400) {
      HTTP_CACHE.set(ckey, { t: Date.now(), v: { ...out } });
      if (HTTP_CACHE.size > 300) {
        const now = Date.now();
        for (const [k, x] of HTTP_CACHE) if (now - x.t > HTTP_CACHE_TTL) HTTP_CACHE.delete(k);
      }
    }
    return out;
  } catch (err) {
    /* 网络失败时若有过期缓存，降级返回旧内容，避免因单点抖动导致整页卡死 */
    if (cacheable) {
      const stale = HTTP_CACHE.get(ckey);
      if (stale) return { ...stale.v };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  }));
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
      ? Object.entries(chaptersMap).map(([p, t], i) => ({ title: String(t || `第 ${i + 1} 话`), url: String(p) }))
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
    items: comics.map((c) => ({
      title: c.title || '',
      link: String(c.id || ''),
      cover: c.cover || '',
      author: c.author || '',
      latestChapter: c.latestChapter || null,
    })),
    maxPage: Math.max(1, Number(out?.maxPage) || page),
  };
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
