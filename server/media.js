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

/**
 * 页面级图像编辑：旋转 + 裁剪。
 * @param {Buffer} buf 原图
 * @param {{rotate?: number, crop?: {x:number,y:number,w:number,h:number}}} opts
 *        crop 使用百分比（0-100），基于「旋转之后」的画面坐标系。
 */
export async function transformImage(buf, { rotate = 0, crop = null } = {}) {
  if (!sharp) throw new Error('服务端未启用 sharp，无法编辑页面');
  const image = sharp(buf, { failOn: 'none' });
  // 先按 EXIF 转正，再叠加用户旋转
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const baseAngle = ((rotate % 360) + 360) % 360;
  let pipeline = image.rotate(baseAngle);
  const swapped = baseAngle === 90 || baseAngle === 270;
  const W = swapped ? meta.height || 0 : meta.width || 0;
  const H = swapped ? meta.width || 0 : meta.height || 0;
  if (crop && W && H) {
    const left = Math.max(0, Math.round((crop.x / 100) * W));
    const top = Math.max(0, Math.round((crop.y / 100) * H));
    const width = Math.max(1, Math.min(W - left, Math.round((crop.w / 100) * W)));
    const height = Math.max(1, Math.min(H - top, Math.round((crop.h / 100) * H)));
    pipeline = pipeline.extract({ left, top, width, height });
  }
  return await pipeline.toBuffer();
}

/** 把一张跨页大图切成两页；rtl 时右侧先读，所以返回 [右, 左] */
export async function splitSpread(buf, rtl = false) {
  if (!sharp) throw new Error('服务端未启用 sharp，无法拆分跨页');
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error('无法读取图片尺寸');
  const half = Math.floor(W / 2);
  const right = await sharp(buf, { failOn: 'none' })
    .extract({ left: half, top: 0, width: W - half, height: H })
    .toBuffer();
  const left = await sharp(buf, { failOn: 'none' })
    .extract({ left: 0, top: 0, width: half, height: H })
    .toBuffer();
  return rtl ? [right, left] : [left, right];
}

/** 把两张图横向拼成一张跨页图；rtl 时 b 在左、a 在右 */
export async function mergeSpread(bufA, bufB, rtl = false) {
  if (!sharp) throw new Error('服务端未启用 sharp，无法合并页面');
  const [ma, mb] = await Promise.all([
    sharp(bufA, { failOn: 'none' }).metadata(),
    sharp(bufB, { failOn: 'none' }).metadata(),
  ]);
  const targetH = Math.max(ma.height || 0, mb.height || 0);
  const resizeTo = async (buf, m) => {
    if (m.height === targetH) return { buf, w: m.width };
    const w = Math.round(((m.width || 1) * targetH) / (m.height || 1));
    return { buf: await sharp(buf, { failOn: 'none' }).resize({ width: w, height: targetH }).toBuffer(), w };
  };
  const A = await resizeTo(bufA, ma);
  const B = await resizeTo(bufB, mb);
  const first = rtl ? B : A;
  const second = rtl ? A : B;
  return await sharp({
    create: {
      width: first.w + second.w,
      height: targetH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: first.buf, left: 0, top: 0 },
      { input: second.buf, left: first.w, top: 0 },
    ])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

/** 判断一张图是否是跨页（宽 > 高，且明显偏宽） */
export function isSpread(width, height, minRatio = 1.15) {
  if (!width || !height) return false;
  return width / height >= minRatio;
}

export async function pdfSafe(buf, ext) {
  // pdf-lib 仅支持 jpg / png；其他格式借助 sharp 转 jpeg
  if (ext === 'jpg' || ext === 'jpeg') return { data: buf, kind: 'jpg' };
  if (ext === 'png') return { data: buf, kind: 'png' };
  const out = await toJpegBuffer(buf, { maxWidth: 0, quality: 92 });
  if (out.fallback) return null;
  return { data: out.data, kind: 'jpg' };
}
