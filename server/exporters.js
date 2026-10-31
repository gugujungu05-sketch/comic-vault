import path from 'node:path';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import archiver from 'archiver';
import { PDFDocument } from 'pdf-lib';
import { chapterDir } from './store.js';
import { pdfSafe } from './media.js';

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function safeName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function contentDisposition(name, ext) {
  const ascii = safeName(name).replace(/[^\x20-\x7E]/g, '_') || 'comic';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;
}

export function extOf(file) {
  return path.extname(file || '').slice(1).toLowerCase() || 'jpg';
}

function pad(n, len = 3) {
  return String(n).padStart(len, '0');
}

function chapterFolderName(chapter, index) {
  const base = pad(index + 1);
  const title = safeName(chapter.title, '').trim();
  return title ? `${base} - ${title}` : `${base}`;
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** ComicInfo.xml —— ComicRack / YACReader / Panels / Tachiyomi 等阅读器通用的元数据标准 */
export function comicInfoXml(comic, chapter, pageCount, index = 0) {
  const manga = comic.direction === 'rtl' ? 'YesAndRightToLeft' : 'No';
  const num = chapter.number != null && chapter.number !== '' ? chapter.number : index + 1;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${xmlEscape(chapter.title || `第 ${num} 话`)}</Title>`,
    `  <Series>${xmlEscape(comic.title)}</Series>`,
    `  <Number>${xmlEscape(num)}</Number>`,
    `  <Writer>${xmlEscape(comic.author || '')}</Writer>`,
    `  <Penciller>${xmlEscape(comic.artist || '')}</Penciller>`,
    `  <Summary>${xmlEscape(comic.description || '')}</Summary>`,
    `  <Genre>${xmlEscape((comic.tags || []).join(', '))}</Genre>`,
    `  <Tags>${xmlEscape((comic.tags || []).join(', '))}</Tags>`,
    `  <LanguageISO>${xmlEscape(comic.language || 'zh')}</LanguageISO>`,
    `  <Manga>${manga}</Manga>`,
    `  <PageCount>${pageCount}</PageCount>`,
    `  <ScanInformation>ComicVault</ScanInformation>`,
    `  <Notes>由 ComicVault 导出</Notes>`,
    '</ComicInfo>',
  ];
  return lines.join('\n');
}

/** 打包为 CBZ / ZIP（CBZ 额外附带 ComicInfo.xml） */
export async function exportArchive(res, { comic, chapters, format, filename }) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(filename, format));
  archive.pipe(res);

  const withMeta = format === 'cbz';
  const root = safeName(comic.title, 'comic');

  if (withMeta && chapters.length > 1) {
    archive.append(comicInfoXml(comic, chapters[0], comic.totalPages || 0, 0), {
      name: `${root}/ComicInfo.xml`,
    });
  }

  for (let ci = 0; ci < chapters.length; ci++) {
    const chapter = chapters[ci];
    const folder = `${root}/${chapterFolderName(chapter, ci)}`;
    let added = 0;
    for (let pi = 0; pi < chapter.pages.length; pi++) {
      const page = chapter.pages[pi];
      const file = path.join(chapterDir(comic.id, chapter.id), page.file);
      const ext = extOf(page.file);
      try {
        const st = await fsp.stat(file);
        archive.append(createReadStream(file), { name: `${folder}/${pad(pi + 1)}.${ext}`, size: st.size });
        added += 1;
      } catch {
        /* 文件缺失则跳过 */
      }
    }
    if (withMeta) {
      archive.append(comicInfoXml(comic, chapter, added, ci), { name: `${folder}/ComicInfo.xml` });
    }
  }

  await archive.finalize();
}

/** 打包为 PDF（按图片原始比例排版，自动旋转适配） */
export async function exportPdf(res, { comic, chapters, filename }) {
  const doc = await PDFDocument.create();
  doc.setTitle(comic.title);
  doc.setAuthor(comic.author || '');
  doc.setSubject((comic.tags || []).join(', '));
  doc.setProducer('ComicVault');
  doc.setCreationDate(new Date());

  const MAX_EDGE = 2400; // 限制单边像素，避免 PDF 体积失控

  for (const chapter of chapters) {
    for (const page of chapter.pages) {
      const file = path.join(chapterDir(comic.id, chapter.id), page.file);
      let buf;
      try {
        buf = await fsp.readFile(file);
      } catch {
        continue;
      }
      const safe = await pdfSafe(buf, extOf(page.file));
      if (!safe) continue; // 无 sharp 且非 jpg/png 时跳过
      let image;
      try {
        image = safe.kind === 'png' ? await doc.embedPng(safe.data) : await doc.embedJpg(safe.data);
      } catch {
        continue;
      }
      const { width, height } = image.scale(1);
      const ratio = Math.min(1, MAX_EDGE / Math.max(width, height));
      const pw = Math.max(1, Math.round(width * ratio));
      const ph = Math.max(1, Math.round(height * ratio));
      const pdfPage = doc.addPage([pw, ph]);
      pdfPage.drawImage(image, { x: 0, y: 0, width: pw, height: ph });
    }
  }

  const bytes = await doc.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(filename, 'pdf'));
  res.end(Buffer.from(bytes));
}

/** 打包为固定版式 EPUB（漫画专用，pre-paginated） */
export async function exportEpub(res, { comic, chapters, filename }) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', contentDisposition(filename, 'epub'));
  archive.pipe(res);
  archive.append('application/epub+zip', { name: 'mimetype', store: true });

  const bookId = comic.id;
  const manifest = [];
  const spine = [];
  const navItems = [];
  let pageIndex = 0;

  const pageXml = (imgHref, w, h, title) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" xml:lang="zh">
<head><title>${xmlEscape(title)}</title><meta name="viewport" content="width=${w}, height=${h}"/></head>
<body style="margin:0;padding:0;background:#000;">
  <div style="width:100%;height:100%;text-align:center;">
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" version="1.1">
      <image width="${w}" height="${h}" xlink:href="${imgHref}"/>
    </svg>
  </div>
</body>
</html>`;

  for (const chapter of chapters) {
    const chapterNav = { label: chapter.title || `第 ${chapter.number ?? ''} 话`, href: null };
    for (const page of chapter.pages) {
      pageIndex += 1;
      const ext = extOf(page.file);
      const imgName = `img_${pad(pageIndex, 5)}.${ext}`;
      const src = path.join(chapterDir(comic.id, chapter.id), page.file);
      try {
        const st = await fsp.stat(src);
        archive.append(createReadStream(src), { name: `OEBPS/images/${imgName}`, size: st.size });
      } catch {
        continue;
      }
      const w = page.width || 1200;
      const h = page.height || 1600;
      const pageId = `p${pad(pageIndex, 5)}`;
      const imgHref = `images/${imgName}`;
      archive.append(pageXml(imgHref, w, h, `${comic.title} - ${pageIndex}`), {
        name: `OEBPS/${pageId}.xhtml`,
      });
      manifest.push(`    <item id="${pageId}" href="${pageId}.xhtml" media-type="application/xhtml+xml" properties="svg"/>`);
      manifest.push(`    <item id="${pageId}_img" href="${imgHref}" media-type="${MIME[ext] || 'image/jpeg'}"/>`);
      spine.push(`    <itemref idref="${pageId}" linear="yes"/>`);
      if (!chapterNav.href) chapterNav.href = `${pageId}.xhtml`;
    }
    navItems.push(chapterNav);
  }

  if (!pageIndex) {
    archive.destroy();
    res.status(400).json({ error: '没有可导出的页面' });
    return;
  }

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>${xmlEscape(comic.title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${navItems
  .filter((n) => n.href)
  .map((n) => `      <li><a href="${n.href}">${xmlEscape(n.label)}</a></li>`)
  .join('\n')}
    </ol>
  </nav>
</body>
</html>`;
  archive.append(nav, { name: 'OEBPS/nav.xhtml' });
  manifest.push(`    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`);

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${xmlEscape(comic.title)}</dc:title>
    <dc:creator>${xmlEscape(comic.author || comic.artist || '未知')}</dc:creator>
    <dc:language>${xmlEscape(comic.language || 'zh')}</dc:language>
    <dc:description>${xmlEscape(comic.description || '')}</dc:description>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">auto</meta>
    <meta name="fixed-layout" content="true"/>
    <meta name="book-type" content="comic"/>
    <meta name="primary-writing-mode" content="${comic.direction === 'rtl' ? 'horizontal-rl' : 'horizontal-lr'}"/>
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine>
${spine.join('\n')}
  </spine>
</package>`;
  archive.append(opf, { name: 'OEBPS/content.opf' });

  archive.append(
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { name: 'META-INF/container.xml' },
  );

  await archive.finalize();
}
