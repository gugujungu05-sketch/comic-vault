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
import { metadata, thumbnail, isSpread, normalizeSourceImage } from './media.js';

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

export async function storePage(tmpPath, originalName, mimeType, comicId, chapterId, decodeScheme = null) {
  // 读取临时文件内容，按真实字节探测格式：
  // 1) 部分在线书源（爱漫画）返回混淆字节，先还原；
  // 2) avif/heif 统一转 JPEG，避免老浏览器（含部分华为浏览器）不识别、
  //    以及 content-type 落到 application/octet-stream 导致破图。
  // extOf(originalName) 只作为兜底——文件名后缀常与真实内容不符（如 .avif 实为乱码）。
  let buf = await fsp.readFile(tmpPath);
  let ext;
  try {
    const norm = await normalizeSourceImage(buf, decodeScheme, { forceJpeg: true });
    buf = norm.buf;
    ext = norm.ext;
  } catch {
    ext = /^[a-z0-9]{2,5}$/i.test(String(mimeType || '').replace('image/', ''))
      ? mimeType.replace('image/', '')
      : 'jpg';
  }
  ext = (ext || 'jpg').toLowerCase();
  if (!IMAGE_RE.test(`.${ext}`)) ext = 'jpg';

  const pageId = newId('p');
  const dir = chapterDir(comicId, chapterId);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${pageId}.${ext}`);
  await fsp.writeFile(target, buf);
  await fsp.rm(tmpPath, { force: true }).catch(() => {});

  let width = 0;
  let height = 0;
  let hasThumb = false;
  try {
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

  return {
    id: pageId,
    /** 用户导入时的原始文件名，便于按自己排好的顺序核对与展示 */
    name: originalName,
    file: `${pageId}.${ext}`,
    width,
    height,
    size: buf.length,
    hasThumb,
    wide: isSpread(width, height),
  };
}
