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
export const DB_FILE = path.join(DATA_DIR, 'db.json');

for (const dir of [DATA_DIR, STORE_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function defaultDb() {
  return {
    version: 1,
    comics: [],
    settings: {
      defaultDirection: 'ltr',
      theme: 'dark',
    },
  };
}

let db = null;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.settings = { ...defaultDb().settings, ...(db.settings || {}) };
      db.comics = db.comics || [];
    } else {
      db = defaultDb();
    }
  } catch (err) {
    // 数据库损坏：把坏文件留档，避免下次启动继续用坏数据覆盖
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(DB_FILE, backup);
      console.error(`[store] 数据库损坏（${err.message}），已备份到 ${backup}，使用空库启动`);
    } catch {
      console.error('[store] 数据库读取失败:', err.message);
    }
    db = defaultDb();
  }
  return db;
}

export function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  // 原子写入：先写临时文件再改名，任何时刻磁盘上都是一个完整可解析的 JSON
  const tmp = `${DB_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, snapshot, 'utf8');
  fs.renameSync(tmp, DB_FILE);
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

/** 漫画封面候选：优先自定义封面，其次第一章第一页 */
export function coverOf(comic) {
  if (comic.cover?.pageId) {
    const ch = comic.chapters.find((c) => c.id === comic.cover.chapterId);
    const pg = ch?.pages.find((p) => p.id === comic.cover.pageId);
    if (pg && ch) return { url: pageUrl(comic, ch, pg), chapter: ch, page: pg };
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
