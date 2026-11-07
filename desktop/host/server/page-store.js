/**
 * 页面落盘的共享实现。
 *
 * 之前只存在于 server/index.js 内部；为了让「公共书库合规批量导入」
 * 也能复用同一套命名、尺寸探测与缩略图逻辑，抽到独立模块。
 * index.js 与 discovery.js 都从这里 import，行为保持一致。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, chapterDir, comicDir } from './store.js';
import { metadata, thumbnail, isSpread } from './media.js';
import { extOf } from './exporters.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
};

export function isImageName(name) {
  return IMAGE_RE.test(String(name || ''));
}

export async function storePage(tmpPath, originalName, mimeType, comicId, chapterId) {
  let ext = extOf(originalName);
  if (!MIME_EXT[mimeType] && !/^[a-z0-9]{2,5}$/.test(ext)) ext = 'jpg';
  if (mimeType && MIME_EXT[mimeType] && !IMAGE_RE.test(originalName || '')) ext = MIME_EXT[mimeType];
  ext = (ext || 'jpg').toLowerCase();

  const pageId = newId('p');
  const dir = chapterDir(comicId, chapterId);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${pageId}.${ext}`);
  await fsp.rename(tmpPath, target).catch(async () => {
    await fsp.copyFile(tmpPath, target);
    await fsp.rm(tmpPath, { force: true });
  });

  let width = 0;
  let height = 0;
  let hasThumb = false;
  try {
    const buf = await fsp.readFile(target);
    const meta = await metadata(buf);
    if (meta) {
      width = meta.width;
      height = meta.height;
    }
    const thumb = await thumbnail(buf);
    if (thumb) {
      const tdir = path.join(comicDir(comicId), '_thumbs', chapterId);
      await fsp.mkdir(tdir, { recursive: true });
      await fsp.writeFile(path.join(tdir, `${pageId}.webp`), thumb);
      hasThumb = true;
    }
  } catch {
    /* 元数据失败不影响导入 */
  }

  const stat = await fsp.stat(target).catch(() => null);
  return {
    id: pageId,
    /** 用户导入时的原始文件名，便于按自己排好的顺序核对与展示 */
    name: originalName,
    file: `${pageId}.${ext}`,
    width,
    height,
    size: stat?.size || 0,
    hasThumb,
    wide: isSpread(width, height),
  };
}
