/**
 * 定时自动追更。
 *
 * 订阅 = 书源里的一本漫画（sourceId + 详情页链接），可选关联书库里的一本漫画（comicId）。
 * 服务端每分钟扫描一次到期订阅：重新抓详情页章节列表，与上次快照对比，
 * 发现新章节时按 autoDownload 自动导入到关联漫画（最多每次 10 话，防止失控）。
 *
 * 存储：data/subscriptions.json（不进 git）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { loadDb, getComic, DATA_DIR } from './store.js';
import { allSources, fetchComicDetail, importChapterFromSource } from './sources.js';
import { requireUser } from './social.js';

const now = () => Date.now();
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const SCAN_STEP = 60 * 1000; // 每分钟扫一遍
const MAX_IMPORT_PER_CHECK = 10; // 一次检查最多自动下载的话数
const INTERVALS = [10, 30, 60, 180, 360, 720, 1440]; // 允许的检查间隔（分钟）

let subs = [];
let scanning = false;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
    if (Array.isArray(arr)) return arr;
  } catch { /* 首次为空 */ }
  return [];
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2) + '\n');
  }, 200);
}

function saveNow() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2) + '\n');
}

/** 对外展示视图：附上关联漫画的当前话数 */
function subView(s) {
  const db = loadDb();
  const comic = s.comicId ? getComic(s.comicId) : null;
  return {
    id: s.id,
    userId: s.userId,
    sourceId: s.sourceId,
    sourceName: s.sourceName || '',
    url: s.url,
    title: s.title || '未命名订阅',
    cover: s.cover || (comic ? (comic.coverUrl || null) : null),
    comicId: s.comicId || null,
    comicTitle: comic ? comic.title : null,
    comicExists: !!comic,
    enabled: s.enabled !== false,
    autoDownload: !!s.autoDownload,
    intervalMin: s.intervalMin || 60,
    lastCheckAt: s.lastCheckAt || null,
    lastNewAt: s.lastNewAt || null,
    newCount: s.newCount || 0,
    chapterCount: s.chapterCount ?? (comic ? comic.chapters.length : null),
    latestChapterTitle: s.latestChapterTitle || '',
    lastError: s.lastError || '',
    checking: !!s.checking,
  };
}

/** 检查一个订阅：返回 { fresh:[{title,url}], imported } */
async function checkSubscription(s, { autoImport } = {}) {
  const source = allSources().find((x) => x.id === s.sourceId);
  if (!source) {
    s.lastError = '书源不存在或已被删除';
    return { fresh: [], imported: 0 };
  }
  const detail = await fetchComicDetail(source, s.url);
  if (detail.title) s.title = detail.title;
  if (detail.cover) s.cover = detail.cover;
  const urls = detail.chapters.map((c) => c.url);
  const known = new Set(s.knownUrls || []);
  const fresh = detail.chapters.filter((c) => !known.has(c.url));
  s.chapterCount = urls.length;
  s.latestChapterTitle = detail.chapters.at(-1)?.title || s.latestChapterTitle;
  s.lastCheckAt = now();
  s.lastError = '';

  if (s.knownUrls && fresh.length && (autoImport ?? s.autoDownload)) {
    let comic = s.comicId ? getComic(s.comicId) : null;
    if (s.comicId && !comic) s.comicId = null; // 关联漫画被删，重新建一本
    let imported = 0;
    for (const ch of fresh.slice(-MAX_IMPORT_PER_CHECK)) {
      try {
        const r = await importChapterFromSource({
          source, userId: s.userId, comic,
          title: s.title, cover: s.cover, comicUrl: s.url,
          chapterTitle: ch.title, chapterUrl: ch.url,
        });
        comic = r.comic;
        s.comicId = comic.id;
        imported++;
      } catch (err) {
        s.lastError = `自动下载「${ch.title}」失败：${err.message}`;
        break;
      }
    }
    if (imported) {
      s.newCount = (s.newCount || 0) + imported;
      s.lastNewAt = now();
    }
    s.lastImported = imported;
  }

  // 更新章节快照（只留最近 500 条，防无限膨胀）
  s.knownUrls = urls.slice(-500);
  return { fresh, imported: s.lastImported || 0 };
}

/** 后台扫描：顺序检查所有到期订阅，避免并发打爆站点 */
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const due = subs.filter((s) => s.enabled !== false && now() - (s.lastCheckAt || 0) >= (s.intervalMin || 60) * 60000);
    for (const s of due) {
      try {
        await checkSubscription(s);
      } catch (err) {
        s.lastError = err?.name === 'AbortError' ? '检查超时' : err.message || String(err);
        s.lastCheckAt = now();
      }
      saveSoon();
    }
  } finally {
    scanning = false;
  }
}

export function registerUpdates(app) {
  subs = load();

  app.get('/api/subscriptions', requireUser, (req, res) => {
    res.json({ subscriptions: subs.filter((s) => s.userId === req.user.id).map(subView) });
  });

  // 新建订阅：{ sourceId, url, comicId?, title?, cover?, intervalMin?, autoDownload? }
  app.post('/api/subscriptions', requireUser, async (req, res) => {
    const b = req.body || {};
    const source = allSources().find((x) => x.id === b.sourceId);
    if (!source) return res.status(404).json({ error: '书源不存在' });
    const url = String(b.url || '');
    if (!url.startsWith('http')) return res.status(400).json({ error: '缺少漫画详情页链接' });
    let comic = b.comicId ? getComic(b.comicId) : null;
    if (b.comicId && (!comic || comic.createdBy !== req.user.id))
      return res.status(404).json({ error: '关联漫画不存在或不属于你' });

    try {
      const detail = await fetchComicDetail(source, url);
      const s = {
        id: `sub-${nanoid(7)}`,
        userId: req.user.id,
        sourceId: source.id,
        sourceName: source.name || source.id,
        url,
        title: b.title || detail.title || comic?.title || '未命名订阅',
        cover: detail.cover || b.cover || null,
        comicId: comic?.id || null,
        enabled: true,
        autoDownload: !!b.autoDownload,
        intervalMin: INTERVALS.includes(Number(b.intervalMin)) ? Number(b.intervalMin) : 60,
        // 首次快照：现有章节全部视为已知，之后只追新增
        knownUrls: detail.chapters.map((c) => c.url).slice(-500),
        chapterCount: detail.chapters.length,
        latestChapterTitle: detail.chapters.at(-1)?.title || '',
        createdAt: now(),
      };
      subs.unshift(s);
      saveNow();
      res.json({ ok: true, subscription: subView(s) });
    } catch (err) {
      const msg = err?.name === 'AbortError' ? '站点无响应或超时' : err.message || '订阅失败';
      res.status(502).json({ error: msg });
    }
  });

  app.put('/api/subscriptions/:id', requireUser, (req, res) => {
    const s = subs.find((x) => x.id === req.params.id && x.userId === req.user.id);
    if (!s) return res.status(404).json({ error: '订阅不存在' });
    const b = req.body || {};
    if (b.enabled !== undefined) s.enabled = !!b.enabled;
    if (b.autoDownload !== undefined) s.autoDownload = !!b.autoDownload;
    if (b.intervalMin !== undefined && INTERVALS.includes(Number(b.intervalMin))) s.intervalMin = Number(b.intervalMin);
    if (b.comicId !== undefined) {
      const comic = b.comicId ? getComic(b.comicId) : null;
      if (b.comicId && (!comic || comic.createdBy !== req.user.id))
        return res.status(404).json({ error: '关联漫画不存在或不属于你' });
      s.comicId = comic ? comic.id : null;
    }
    saveSoon();
    res.json({ ok: true, subscription: subView(s) });
  });

  app.delete('/api/subscriptions/:id', requireUser, (req, res) => {
    const before = subs.length;
    subs = subs.filter((x) => !(x.id === req.params.id && x.userId === req.user.id));
    saveNow();
    res.json({ ok: true, removed: before - subs.length });
  });

  // 立即检查一次：autoDownload 开着就顺带下载新章节
  app.post('/api/subscriptions/:id/check', requireUser, async (req, res) => {
    const s = subs.find((x) => x.id === req.params.id && x.userId === req.user.id);
    if (!s) return res.status(404).json({ error: '订阅不存在' });
    if (s.checking) return res.status(409).json({ error: '正在检查中，请稍候' });
    s.checking = true;
    saveSoon();
    try {
      const r = await checkSubscription(s);
      res.json({ ok: true, fresh: r.fresh.length, imported: r.imported, subscription: subView(s) });
    } catch (err) {
      s.lastError = err?.name === 'AbortError' ? '检查超时' : err.message || String(err);
      s.lastCheckAt = now();
      res.status(502).json({ error: s.lastError, subscription: subView(s) });
    } finally {
      s.checking = false;
      saveNow();
    }
  });

  setInterval(() => { scan().catch(() => {}); }, SCAN_STEP).unref();
}
