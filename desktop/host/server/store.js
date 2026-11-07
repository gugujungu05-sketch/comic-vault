import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.CV_DATA_DIR || path.join(ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'store');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/** 广场附件与自定义表情包的独立目录，和漫画原图分开，便于单独清理 */
export const PLAZA_DIR = path.join(STORE_DIR, '_plaza');
export const DB_FILE = path.join(DATA_DIR, 'db.json');

for (const dir of [DATA_DIR, STORE_DIR, TMP_DIR, BACKUP_DIR, PLAZA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 从备份目录里找出最近一份可解析的数据库 */
function restoreFromBackup() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
      .sort().reverse();
    for (const f of files.slice(0, 8)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.comics)) {
          console.error(`[store] 已从备份恢复：${f}`);
          return parsed;
        }
      } catch {
        /* 试下一份 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function defaultDb() {
  return {
    version: 3,
    comics: [],
    users: [],
    sessions: [],
    codes: [],
    posts: [],
    emojis: [],
    /** 主页动态流事件、公共书库上传记录、公告、分类、软件版本清单 */
    activities: [],
    uploads: [],
    announcements: [],
    categories: [],
    softwareReleases: [],
    meta: {},
    settings: {
      defaultDirection: 'ltr',
      theme: 'dark',
    },
  };
}

export const DB_ARRAY_KEYS = [
  'comics', 'users', 'sessions', 'codes', 'posts', 'emojis',
  'activities', 'uploads', 'announcements', 'categories', 'softwareReleases',
];

/**
 * 公告发布权限只授予「我的账号」：
 *   - 用 CV_ANNOUNCER_EMAIL 环境变量显式指定（推荐，换账号不改代码）；
 *   - 未指定时自动授予最早的管理员账号，且只初始化一次，不会随新注册用户扩散。
 * 普通用户、后来的管理员都不会自动获得该权限。
 */
export function ensureAnnouncer(db) {
  const configured = String(process.env.CV_ANNOUNCER_EMAIL || '').trim().toLowerCase();
  if (configured) {
    const target = db.users.find((u) => String(u.email || '').toLowerCase() === configured);
    if (target) {
      for (const u of db.users) u.canAnnounce = u === target;
      db.meta.announcerInitialized = true;
      return;
    }
  }
  if (db.meta.announcerInitialized) return;
  const first = db.users.find((u) => u.isAdmin) || db.users[0];
  if (first) {
    first.canAnnounce = true;
    db.meta.announcerInitialized = true;
  }
}

/** 补齐旧版本漫画 / 用户缺失的字段，保证新接口读到的数据形状一致 */
function normalize(db) {
  const defaults = defaultDb();
  db.settings = { ...defaults.settings, ...(db.settings || {}) };
  db.meta = db.meta && typeof db.meta === 'object' && !Array.isArray(db.meta) ? db.meta : {};
  for (const key of DB_ARRAY_KEYS) {
    db[key] = Array.isArray(db[key]) ? db[key] : [];
  }
  for (const c of db.comics) {
    c.aliases = Array.isArray(c.aliases) ? c.aliases : [];
    c.covers = Array.isArray(c.covers) ? c.covers : [];
    c.tagEntries = Array.isArray(c.tagEntries) ? c.tagEntries : [];
    c.scope = c.scope || 'personal';
    c.visibility = c.visibility || 'private';
    if (c.allowDownload === undefined) c.allowDownload = true;
    // 分类 / 排行 / 动态所需的计数字段
    if (!c.category) c.category = 'other';
    if (!Number.isFinite(c.views)) c.views = 0;
    if (!Number.isFinite(c.downloads)) c.downloads = 0;
    if (!Array.isArray(c.likes)) c.likes = [];
    if (!Number.isFinite(c.lastActivityAt)) c.lastActivityAt = c.updatedAt || c.createdAt || Date.now();
  }
  // 升级前用邮箱+密码注册的老账号视为已验证邮箱，
  // 避免新增「已验证才能找回密码」后，老账号反而无法使用找回功能。
  // 新注册账号会显式写入 emailVerified: false。
  for (const u of db.users) {
    if (u.emailVerified === undefined) u.emailVerified = true;
    if (u.canAnnounce === undefined) u.canAnnounce = false;
  }
  ensureAnnouncer(db);
  return db;
}

let db = null;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db || typeof db !== 'object' || Array.isArray(db)) {
        throw new Error('数据库内容不是有效对象');
      }
      normalize(db);
    } else {
      db = defaultDb();
    }
  } catch (err) {
    // 数据库损坏：先留档，再优先从自动备份恢复
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(DB_FILE, backup);
      console.error(`[store] 数据库损坏（${err.message}），已留档 ${backup}`);
    } catch {
      console.error('[store] 数据库读取失败:', err.message);
    }
    db = normalize(restoreFromBackup() || defaultDb());
    // 立即把恢复结果写回，避免再次启动重复走恢复逻辑
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch {
      /* 忽略 */
    }
  }
  return db;
}

let lastBackup = 0;

export function saveDb() {
  // 关键保护：绝不能把「尚未加载」的空数据库写进文件
  if (!db || typeof db !== 'object' || Array.isArray(db)) return;
  const snapshot = JSON.stringify(db, null, 2);
  // 原子写入：先写临时文件再改名，任何时刻磁盘上都是一个完整可解析的 JSON
  const tmp = `${DB_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, snapshot, 'utf8');
  fs.renameSync(tmp, DB_FILE);

  // 每 10 分钟留一份可恢复快照，最多保留 6 份
  if (Date.now() - lastBackup > 10 * 60 * 1000) {
    lastBackup = Date.now();
    try {
      const f = path.join(BACKUP_DIR, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(f, snapshot, 'utf8');
      const all = fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('db-')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 6))) {
        fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
      }
    } catch {
      /* 备份失败不影响主流程 */
    }
  }
}

export function saveDbSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveDb();
    } catch (err) {
      console.error('[store] 保存失败:', err.message);
    }
  }, 120);
}

export function newId(prefix = 'c') {
  return `${prefix}_${nanoid(12)}`;
}

export function getComic(id) {
  return loadDb().comics.find((c) => c.id === id) || null;
}

export function getComicByShareToken(token) {
  return loadDb().comics.find((c) => c.share?.token === token) || null;
}

export function getChapter(comic, chapterId) {
  return comic?.chapters?.find((ch) => ch.id === chapterId) || null;
}

export function comicDir(comicId) {
  return path.join(STORE_DIR, comicId);
}

export function chapterDir(comicId, chapterId) {
  return path.join(STORE_DIR, comicId, chapterId);
}

/** 漫画封面候选：当前选中的多封面之一 > 旧版自定义封面 > 第一章第一页 */
export function coverOf(comic) {
  const multi = (comic.covers || []).find((c) => c.id === comic.activeCoverId);
  if (multi) return { url: multi.url, chapter: null, page: null };
  if (comic.covers?.length) return { url: comic.covers[0].url, chapter: null, page: null };
  if (comic.cover?.pageId) {
    const ch = comic.chapters.find((c) => c.id === comic.cover.chapterId);
    const pg = ch?.pages.find((p) => p.id === comic.cover.pageId);
    if (pg && ch) return { url: pageUrl(comic, ch, pg), chapter: ch, page: pg };
  }
  if (comic.cover?.type === 'file' && comic.cover.file) {
    return { url: `/api/files/${comic.id}/_cover/${comic.cover.file}`, chapter: null, page: null };
  }
  for (const ch of comic.chapters || []) {
    if (ch.pages?.length) {
      const pg = ch.pages[0];
      return { url: pageUrl(comic, ch, pg), chapter: ch, page: pg };
    }
  }
  return null;
}

export function pageUrl(comic, chapter, page) {
  return `/api/files/${comic.id}/${chapter.id}/${page.file}`;
}

/** 删除漫画的磁盘目录 */
export async function removeComicFiles(comicId) {
  await fsp.rm(comicDir(comicId), { recursive: true, force: true });
}

/** 删除章节的磁盘目录 */
export async function removeChapterFiles(comicId, chapterId) {
  await fsp.rm(chapterDir(comicId, chapterId), { recursive: true, force: true });
}

/** 统计磁盘占用（字节）与文件数 */
export async function dirStats(dir) {
  let size = 0;
  let files = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        files += 1;
        const st = await fsp.stat(p).catch(() => null);
        if (st) size += st.size;
      }
    }
  }
  await walk(dir);
  return { size, files };
}
