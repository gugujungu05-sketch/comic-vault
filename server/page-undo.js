/**
 * 页面操作撤销（章节级快照栈）。
 *
 * 背景：页面编辑（上传 / 删除 / 排序 / 移动 / 合并 / 拆分 / 旋转裁剪）此前都是
 * 即时覆盖保存、直接删文件，误操作无法恢复。本模块在每次编辑“之前”把该章节
 * 的完整状态存成快照，提供单步/多步撤销。
 *
 * 空间优化：页面原图用硬链接（同一 data 盘内 link 几乎零成本）。因为所有写操作
 * 都是「写新文件名 → 删旧文件」（见 rewritePage）或「rm」，不会原地覆盖同一路径，
 * 所以硬链接能安全保留旧内容。缩略图会被同名覆盖写，因此缩略图用复制。
 *
 * 快照目录：data/store/_undo/<comicId>/<chapterId>/<时间戳_snapId>/
 *   meta.json  -> { op, label, ts, pages:[...], files:{fileName:snapshotName} }
 *   files/     -> 页面原图（硬链接）
 *   thumbs/    -> 缩略图（复制，小）
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STORE_DIR, chapterDir, comicDir, newId, saveDb } from './store.js';

const UNDO_DIR = path.join(STORE_DIR, '_undo');
const KEEP = 12; // 每章最多保留的快照数

function snapRoot(comicId, chapterId) {
  return path.join(UNDO_DIR, comicId, chapterId);
}

async function safeLink(src, dst) {
  try {
    await fsp.link(src, dst);
  } catch {
    await fsp.copyFile(src, dst);
  }
}

/**
 * 在编辑操作前为章节建快照。comic/chapter 来自 loadDb，pages 需深拷贝。
 * 失败不应阻断编辑，故内部 try/catch 后静默返回 null。
 */
export async function snapshotChapter(comic, chapter, op = 'edit', label = '') {
  try {
    if (!comic?.id || !chapter?.id) return null;
    const id = `${Date.now().toString(36)}_${newId('s').replace(/^s_?/, '')}`;
    const root = snapRoot(comic.id, chapter.id);
    const dir = path.join(root, id);
    await fsp.mkdir(path.join(dir, 'files'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'thumbs'), { recursive: true });

    const pages = JSON.parse(JSON.stringify(chapter.pages || []));
    const files = {};
    const srcDir = chapterDir(comic.id, chapter.id);
    const thumbDir = path.join(comicDir(comic.id), '_thumbs', chapter.id);

    for (const p of pages) {
      if (!p.file) continue;
      const src = path.join(srcDir, p.file);
      const dst = path.join(dir, 'files', p.file);
      try {
        await safeLink(src, dst);
        files[p.file] = p.file;
      } catch { /* 源文件不存在则跳过 */ }
      if (p.hasThumb) {
        const ts = path.join(thumbDir, `${p.id}.webp`);
        try { await fsp.copyFile(ts, path.join(dir, 'thumbs', `${p.id}.webp`)); } catch { /* 忽略 */ }
      }
    }

    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      id, op, label, ts: Date.now(), chapterTitle: chapter.title || '', pages, files,
    }, null, 2));

    await prune(root);
    return id;
  } catch (err) {
    console.error('[undo] 快照失败:', err.message);
    return null;
  }
}

async function prune(root) {
  try {
    const entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name)); // 时间戳前缀倒序 = 最新在前
    for (const old of entries.slice(KEEP)) {
      await fsp.rm(old.path, { recursive: true, force: true });
    }
  } catch { /* 忽略 */ }
}

async function listSnapshots(comicId, chapterId) {
  try {
    const root = snapRoot(comicId, chapterId);
    const entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
    return entries;
  } catch {
    return [];
  }
}

/** 返回可撤销步数与最近一次操作描述 */
export async function undoStatus(comicId, chapterId) {
  const names = await listSnapshots(comicId, chapterId);
  let latest = null;
  if (names.length) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(snapRoot(comicId, chapterId), names[0], 'meta.json'), 'utf8'));
      latest = { op: meta.op, label: meta.label, ts: meta.ts };
    } catch { /* 忽略 */ }
  }
  return { canUndo: names.length, latest };
}

/**
 * 撤销最近一次快照：把章节文件与元数据恢复到快照状态，然后消费该快照。
 * 返回 { ok, label, op, remaining }。
 */
export async function undoChapter(comic, chapter) {
  const names = await listSnapshots(comic.id, chapter.id);
  if (!names.length) return { ok: false, error: '没有可撤销的操作' };
  const dir = path.join(snapRoot(comic.id, chapter.id), names[0]);
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return { ok: false, error: '快照已损坏' };
  }

  try {
    const dest = chapterDir(comic.id, chapter.id);
    const thumbDest = path.join(comicDir(comic.id), '_thumbs', chapter.id);
    // 清空当前章节页面文件与缩略图（只含本章目录，元数据仍在 db）
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rm(thumbDest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });

    for (const [fileName, snapName] of Object.entries(meta.files || {})) {
      const src = path.join(dir, 'files', snapName);
      try { await fsp.copyFile(src, path.join(dest, fileName)); } catch { /* 忽略 */ }
    }
    const snapThumbs = path.join(dir, 'thumbs');
    let thumbNames = [];
    try { thumbNames = await fsp.readdir(snapThumbs); } catch { /* 无缩略图 */ }
    if (thumbNames.length) {
      await fsp.mkdir(thumbDest, { recursive: true });
      for (const t of thumbNames) {
        try { await fsp.copyFile(path.join(snapThumbs, t), path.join(thumbDest, t)); } catch { /* 忽略 */ }
      }
    }

    chapter.pages = meta.pages || [];
    comic.updatedAt = Date.now();
    saveDb(); // 立即落盘，避免防抖窗口内用户刷新丢失
  } catch (err) {
    console.error('[undo] 恢复失败:', err.message);
    return { ok: false, error: '恢复失败: ' + err.message };
  }

  // 消费该快照
  await fsp.rm(dir, { recursive: true, force: true });
  const remaining = Math.max(0, names.length - 1);
  return { ok: true, label: meta.label, op: meta.op, remaining, pageCount: chapter.pages.length };
}

/** 清空某漫画/章节的全部快照（删除漫画或章节时调用，避免垃圾堆积） */
export async function clearUndo(comicId, chapterId) {
  try {
    if (chapterId) await fsp.rm(snapRoot(comicId, chapterId), { recursive: true, force: true });
    else await fsp.rm(path.join(UNDO_DIR, comicId), { recursive: true, force: true });
  } catch { /* 忽略 */ }
}
