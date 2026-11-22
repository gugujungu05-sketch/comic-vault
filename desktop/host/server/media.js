/**
 * 图像处理助手：sharp 可用时用于转码/压缩/缩略图，不可用时降级为原文件。
 */
let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = null;
}
let nodeCrypto = null;
try { nodeCrypto = (await import('node:crypto')).default; } catch { /* 忽略 */ }
export const hasSharp = !!sharp;

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff']);

/**
 * 部分漫画源站对图片字节做了轻量混淆，浏览器端 JS 会先解码再显示；
 * 后端若直接保存原始字节，用户看到的就是一张破图。这里在落盘/代理前统一还原。
 *
 * 已知方案：爱漫画（MCCMS）用 ((byte - SHIFT) & 0xff) ^ KEY，
 * 其中 XOR_KEY=0xAB(171)、SHIFT_VALUE=47（见 server/js-sources/aimanhua.js）。
 * 解码后是标准 avif（头 00 00 00 .. ftyp avif）。
 *
 * @param {Buffer} buf 源站返回的原始字节
 * @param {{sub?:number, xor?:number}|null} scheme 书源声明的解码参数；不传则尝试已知方案
 * @returns {Buffer|null} 解码后的可用图片字节；不是混淆数据/无法解码时返回 null
 */
export function decodeSourceImage(buf, scheme = null) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;

  // AES-CBC 方案（漫蛙 manwa 等）：整段字节是密文，key/iv 为同一串 16 字节 hex/utf8。
  // 解密后是标准 WebP/JPEG。仅在源显式声明 aes 时尝试，避免误伤正常图片。
  if (scheme && scheme.aes && nodeCrypto) {
    try {
      const rawKey = String(scheme.aes.key || '');
      const keyBuf = /^[0-9a-fA-F]{32}$/.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'utf8');
      const ivBuf = scheme.aes.iv
        ? (/^[0-9a-fA-F]{32}$/.test(String(scheme.aes.iv)) ? Buffer.from(String(scheme.aes.iv), 'hex') : Buffer.from(String(scheme.aes.iv), 'utf8'))
        : keyBuf;
      if (keyBuf.length === 16 || keyBuf.length === 24 || keyBuf.length === 32) {
        const algo = `aes-${keyBuf.length * 8}-cbc`;
        const dec = nodeCrypto.createDecipheriv(algo, keyBuf, ivBuf);
        const out = Buffer.concat([dec.update(buf), dec.final()]);
        if (looksLikeImage(out)) return out;
      }
    } catch { /* 不是 AES 数据则忽略 */ }
  }

  const schemes = [];
  if (scheme && Number.isFinite(Number(scheme.sub)) && Number.isFinite(Number(scheme.xor))) {
    schemes.push({ sub: Number(scheme.sub), xor: Number(scheme.xor) });
  }
  // 已知内置方案：爱漫画 sub=47 xor=171；去重避免重复尝试
  const builtin = { sub: 47, xor: 171 };
  if (!schemes.some((s) => s.sub === builtin.sub && s.xor === builtin.xor)) schemes.push(builtin);

  for (const { sub, xor } of schemes) {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = ((buf[i] - sub) & 0xff) ^ (xor & 0xff);
    // 校验解码结果确实是常见图片，避免把正常图片误解码成乱码
    if (looksLikeImage(out)) return out;
  }
  return null;
}

/** 魔数判定：Buffer 是否已经是浏览器可直接显示的图片 */
export function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return true;
  // WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') return true;
  // BMP
  if (buf.toString('ascii', 0, 2) === 'BM') return true;
  // ISO BMFF: avif / heic / heif（ftyp 在第 4 字节）
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (/^(avif|avis|heic|heix|hevc|hevx|mif1|msf1|miaf)$/i.test(brand)) return true;
  }
  return false;
}

/**
 * 把源站图片字节归一化为浏览器可显示、content-type 明确的格式。
 * - 混淆数据先解码；
 * - avif/heif 在无 sharp 或调用方需要时转 JPEG（兼容性最好）。
 * @returns {Promise<{buf:Buffer, ext:string, mime:string, decoded:boolean}>}
 */
export async function normalizeSourceImage(buf, scheme = null, { forceJpeg = true } = {}) {
  let data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let decoded = false;
  if (!looksLikeImage(data)) {
    const fixed = decodeSourceImage(data, scheme);
    if (fixed) { data = fixed; decoded = true; }
  }
  // 探测格式
  let ext = 'jpg';
  let mime = 'image/jpeg';
  if (data.toString('ascii', 4, 8) === 'ftyp') {
    ext = 'avif'; mime = 'image/avif';
  } else if (data.toString('ascii', 1, 4) === 'PNG') { ext = 'png'; mime = 'image/png'; }
  else if (data.toString('ascii', 0, 4) === 'RIFF') { ext = 'webp'; mime = 'image/webp'; }
  else if (data.toString('ascii', 0, 3) === 'GIF') { ext = 'gif'; mime = 'image/gif'; }
  else if (data[0] === 0xff && data[1] === 0xd8) { ext = 'jpg'; mime = 'image/jpeg'; }
  // avif/heif 兼容：部分老浏览器不认 avif，统一转 JPEG
  if (forceJpeg && sharp && ext === 'avif') {
    try {
      const jpg = await sharp(data, { failOn: 'none' }).rotate().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
      if (jpg.length) return { buf: jpg, ext: 'jpg', mime: 'image/jpeg', decoded: true };
    } catch { /* 转码失败则保留原 avif */ }
  }
  return { buf: data, ext, mime, decoded };
}

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
