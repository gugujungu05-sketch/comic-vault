/**
 * 图像处理助手：sharp 可用时用于转码/压缩/缩略图，不可用时降级为原文件。
 */
let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = null;
}
export const hasSharp = !!sharp;

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff']);

export async function toJpegBuffer(buf, { maxWidth = 0, quality = 88 } = {}) {
  if (!sharp) return { data: buf, mime: 'image/jpeg', fallback: true };
  let pipeline = sharp(buf, { failOn: 'none' }).rotate();
  if (maxWidth > 0) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  const data = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  return { data, mime: 'image/jpeg', fallback: false };
}

export async function thumbnail(buf, width = 420) {
  if (!sharp) return null;
  try {
    return await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

export async function metadata(buf) {
  if (!sharp) return null;
  try {
    const m = await sharp(buf, { failOn: 'none' }).metadata();
    return { width: m.width || 0, height: m.height || 0 };
  } catch {
    return null;
  }
}

export async function pdfSafe(buf, ext) {
  // pdf-lib 仅支持 jpg / png；其他格式借助 sharp 转 jpeg
  if (ext === 'jpg' || ext === 'jpeg') return { data: buf, kind: 'jpg' };
  if (ext === 'png') return { data: buf, kind: 'png' };
  const out = await toJpegBuffer(buf, { maxWidth: 0, quality: 92 });
  if (out.fallback) return null;
  return { data: out.data, kind: 'jpg' };
}
