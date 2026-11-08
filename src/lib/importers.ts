import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ZipReader, BlobReader, BlobWriter, TextWriter, type FileEntry } from '@zip.js/zip.js';
import { naturalCompare } from './util';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
export const ARCHIVE_RE = /\.(zip|cbz)$/i;
export const PDF_RE = /\.pdf$/i;
export const EPUB_RE = /\.epub$/i;
/** 浏览器端解不了的压缩包，交给服务端 7-Zip 引擎（与 server/archive.js 的 SEVENZ_RE 对齐） */
export const SEVENZ_ONLY_RE =
  /\.(7z|rar|cbr|cb7|r\d{2}|ace|arj|lzh|lha|cab|iso|tar|tgz|gz|bz2|xz)$/i;

/** 导入对话框 accept 用的完整格式列表（与 ingest 的识别能力一致，避免选得到却解不了） */
export const IMPORT_ACCEPT =
  'image/*,.zip,.cbz,.pdf,.epub,.rar,.cbr,.7z,.cb7,.r00,.r01,.tar,.tgz,.gz,.bz2,.xz,.ace,.arj,.lzh,.lha,.cab,.iso';

export interface RawItem {
  name: string;
  blob: Blob;
  path: string; // 相对路径，含目录
}

export interface ImportGroup {
  title: string;
  items: RawItem[];
}

export interface ArchiveMeta {
  title?: string;
  author?: string;
  artist?: string;
  tags?: string[];
  description?: string;
  direction?: 'ltr' | 'rtl';
  publisher?: string;
  year?: number;
  rating?: number;
  ageRating?: string;
  language?: string;
  /** 原始字段全量，导出 CBZ 时原样写回 */
  raw?: Record<string, string>;
}

/** ComicInfo.xml 中需要读取的字段（ComicRack 标准） */
const COMIC_INFO_FIELDS = [
  'Title', 'Series', 'Number', 'Volume', 'Summary', 'Notes', 'Writer', 'Penciller', 'Inker',
  'Colorist', 'Letterer', 'Editor', 'Publisher', 'Imprint', 'Genre', 'Tags', 'Web',
  'Characters', 'Teams', 'Locations', 'ScanInformation', 'AgeRating', 'Rating',
  'CommunityRating', 'LanguageISO', 'Format', 'BlackAndWhite', 'Manga', 'Year', 'Month',
  'Day', 'PageCount', 'StoryArc', 'SeriesGroup', 'AlternateSeries', 'AlternateNumber',
];

/** 从 DataTransfer 中递归收集文件（支持拖拽文件夹） */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<{ name: string; blob: Blob; path: string }[]> {
  const out: { name: string; blob: Blob; path: string }[] = [];
  const entries: FileSystemEntry[] = [];
  if (dt.items?.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
      else {
        const f = item.getAsFile();
        if (f) out.push({ name: f.name, blob: f, path: f.name });
      }
    }
  }
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, '', out);
  }
  if (!out.length && dt.files?.length) {
    for (const f of Array.from(dt.files)) out.push({ name: f.name, blob: f, path: f.name });
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: { name: string; blob: Blob; path: string }[]) {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
    if (file) out.push({ name: file.name, blob: file, path: `${prefix}${file.name}` });
    return;
  }
  const dirReader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries 每次最多返回 100 条，需要循环读取
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      dirReader.readEntries(resolve as (e: FileSystemEntry[]) => void, () => resolve([])),
    );
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** 从 input.files（含 webkitRelativePath）收集 */
export function filesFromFileList(list: FileList | File[]): { name: string; blob: Blob; path: string }[] {
  return Array.from(list).map((f) => ({
    name: f.name,
    blob: f,
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
  }));
}

/** 解压 zip/cbz，返回图片项与可选元数据 */
export async function extractArchive(file: Blob): Promise<{ items: RawItem[]; meta?: ArchiveMeta }> {
  const reader = new ZipReader(new BlobReader(file));
  const entries = await reader.getEntries();
  const items: RawItem[] = [];
  let meta: ArchiveMeta | undefined;

  for (const entry of entries) {
    if (entry.directory) continue;
    const filename = entry.filename.replace(/\\/g, '/');
    const base = filename.split('/').pop() || filename;
    if (/comicinfo\.xml$/i.test(base) && !meta) {
      const text = await entry.getData?.(new TextWriter());
      if (text) meta = parseComicInfo(String(text));
      continue;
    }
    if (!IMAGE_RE.test(base)) continue;
    if (/(^|\/)(__MACOSX|\.)/.test(filename)) continue;
    const blob = await entry.getData!(new BlobWriter());
    items.push({ name: base, blob, path: filename });
  }
  await reader.close();
  items.sort((a, b) => naturalCompare(a.path, b.path));
  return { items, meta };
}

/** 读取 XML/HTML 标签上的属性值（单双引号均可） */
function attrOf(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

/**
 * 解析 EPUB（本质是 zip）：读 container.xml → OPF → 按 spine（书内阅读顺序）提取图片。
 * spine 引用 xhtml 页时，解析其中的 <img src> / <image xlink:href> 并按出现顺序取图、去重；
 * OPF/spine 解析失败时兜底遍历全部图片按自然排序返回，不让导入直接失败。
 */
export async function extractEpub(file: Blob): Promise<{ items: RawItem[]; meta?: ArchiveMeta }> {
  const reader = new ZipReader(new BlobReader(file));
  const entries = (await reader.getEntries()).filter(
    (e): e is FileEntry => e.directory === false,
  );
  const byName = new Map<string, FileEntry>();
  for (const e of entries) byName.set(e.filename.replace(/\\/g, '/'), e);
  const readText = async (e: FileEntry) => String(await e.getData(new TextWriter()));
  const isPageImage = (zipPath: string) => {
    const base = zipPath.split('/').pop() || zipPath;
    return IMAGE_RE.test(base) && !/\.svg$/i.test(base) ? base : '';
  };
  const items: RawItem[] = [];
  let meta: ArchiveMeta | undefined;

  try {
    try {
      // 1) META-INF/container.xml → rootfile（OPF 全路径）
      let opfPath = '';
      const container = byName.get('META-INF/container.xml');
      if (container) {
        const m = (await readText(container)).match(/full-path\s*=\s*["']([^"']+)["']/i);
        if (m) opfPath = m[1];
      }
      if (!opfPath || !byName.has(opfPath)) {
        const guess = entries.find((e) => /\.opf$/i.test(e.filename));
        opfPath = guess ? guess.filename.replace(/\\/g, '/') : '';
      }
      const opfEntry = opfPath ? byName.get(opfPath) : undefined;

      if (opfEntry) {
        const opf = await readText(opfEntry);
        const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
        // href 可能带 URL 编码，相对 baseDir 所在目录，解析成 zip 内完整路径
        const resolve = (baseDir: string, href: string) => {
          let h = href.split('#')[0];
          try { h = decodeURIComponent(h); } catch { /* 保留原样 */ }
          const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
          for (const seg of h.split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') stack.pop();
            else stack.push(seg);
          }
          return stack.join('/');
        };

        // 2) manifest：id → { href, media-type }
        const manifest = new Map<string, { href: string; type: string }>();
        for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
          const id = attrOf(m[0], 'id');
          const href = attrOf(m[0], 'href');
          if (!id || !href) continue;
          manifest.set(id, { href, type: attrOf(m[0], 'media-type').toLowerCase() });
        }

        // 3) spine 顺序 → 图片
        const seen = new Set<string>();
        const pushImage = async (zipPath: string) => {
          const base = isPageImage(zipPath);
          if (!base || seen.has(zipPath)) return;
          const entry = byName.get(zipPath);
          if (!entry) return;
          const blob = await entry.getData(new BlobWriter());
          seen.add(zipPath);
          items.push({ name: base, blob, path: zipPath });
        };
        for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
          const id = attrOf(m[0], 'idref');
          const it = id ? manifest.get(id) : undefined;
          if (!it) continue;
          const zipPath = resolve(opfDir, it.href);
          if (it.type.startsWith('image/')) {
            await pushImage(zipPath);
            continue;
          }
          if (/\.x?html?$/i.test(zipPath) || /xhtml|html/.test(it.type)) {
            const page = byName.get(zipPath);
            if (!page) continue;
            const html = await readText(page);
            // 页内引用的图片相对 xhtml 页所在目录
            const pageDir = zipPath.includes('/') ? zipPath.slice(0, zipPath.lastIndexOf('/')) : '';
            for (const im of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
              await pushImage(resolve(pageDir, im[1]));
            }
            for (const im of html.matchAll(/<image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi)) {
              if (/^data:/i.test(im[1])) continue;
              await pushImage(resolve(pageDir, im[1]));
            }
          }
        }

        // 4) 元数据： Dublin Core 字段 → ArchiveMeta
        const dc = (tag: string) =>
          [...opf.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))]
            .map((m) => decodeXml(m[1].trim()))
            .filter(Boolean);
        const subjects = dc('dc:subject');
        const yearM = dc('dc:date')[0]?.match(/\d{4}/);
        meta = {
          title: dc('dc:title')[0],
          author: dc('dc:creator').join(', '),
          publisher: dc('dc:publisher')[0],
          description: dc('dc:description')[0],
          tags: subjects.length ? subjects : undefined,
          year: yearM ? Number(yearM[0]) : undefined,
        };
      }
    } catch {
      /* OPF/spine 解析失败，走下面的兜底 */
    }

    if (!items.length) {
      // 兜底：解不出阅读顺序时，遍历 zip 里全部图片按自然排序
      const loose: RawItem[] = [];
      for (const e of entries) {
        const filename = e.filename.replace(/\\/g, '/');
        if (!isPageImage(filename)) continue;
        if (/(^|\/)(__MACOSX|\.)/.test(filename)) continue;
        const blob = await e.getData(new BlobWriter());
        loose.push({
          name: filename.split('/').pop() || filename,
          blob,
          path: filename,
        });
      }
      loose.sort((a, b) => naturalCompare(a.path, b.path));
      items.push(...loose);
    }
  } finally {
    await reader.close();
  }
  return { items, meta };
}

function parseComicInfo(xml: string): ArchiveMeta {
  const pick = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? decodeXml(m[1].trim()) : undefined;
  };
  const raw: Record<string, string> = {};
  for (const tag of COMIC_INFO_FIELDS) {
    const v = pick(tag);
    if (v) raw[tag] = v;
  }
  const tags = (raw.Tags || raw.Genre || '')
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const manga = raw.Manga || '';
  const year = Number(raw.Year) || undefined;
  const rating = Number(raw.CommunityRating || raw.Rating) || undefined;
  return {
    title: raw.Series || raw.Title,
    author: raw.Writer || '',
    artist: raw.Penciller || raw.Inker || raw.Colorist || '',
    tags,
    description: raw.Summary || raw.Notes || '',
    direction: /right|yes/i.test(manga) ? 'rtl' : 'ltr',
    publisher: raw.Publisher || '',
    year,
    rating,
    ageRating: raw.AgeRating || '',
    language: (raw.LanguageISO || '').toLowerCase() || '',
    raw: Object.keys(raw).length ? raw : undefined,
  };
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 把 PDF 每页渲染成图片 */
export async function pdfToImages(
  file: Blob,
  baseName = 'document',
  opts: { targetWidth?: number; quality?: number } = {},
): Promise<RawItem[]> {
  const targetWidth = opts.targetWidth || 1600;
  const quality = opts.quality ?? 0.92;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const items: RawItem[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, Math.max(0.5, targetWidth / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (blob) {
      items.push({ name: `${baseName}_${String(i).padStart(3, '0')}.jpg`, blob, path: `${baseName}/${String(i).padStart(3, '0')}.jpg` });
    }
    page.cleanup();
  }
  await pdf.destroy();
  return items;
}

export type GroupMode = 'folder' | 'count' | 'all' | 'prefix';

/** 按规则把图片分组为「话」 */
/**
 * @param keepOrder 为 true 时保留 items 的数组顺序（用户在导入面板里手动排好的顺序），
 *                  不再按文件名自然排序；分话分组也保持出现顺序。
 */
export function groupItems(
  items: RawItem[], mode: GroupMode, perChapter = 25, keepOrder = false,
): ImportGroup[] {
  const sorted = keepOrder ? [...items] : [...items].sort((a, b) => naturalCompare(a.path, b.path));
  const orderKeys = (pairs: [string, RawItem[]][]) =>
    keepOrder ? pairs : [...pairs].sort((a, b) => naturalCompare(a[0], b[0]));
  if (mode === 'all') {
    return sorted.length ? [{ title: '第 1 话', items: sorted }] : [];
  }
  if (mode === 'count') {
    const groups: ImportGroup[] = [];
    for (let i = 0; i < sorted.length; i += perChapter) {
      groups.push({ title: `第 ${groups.length + 1} 话`, items: sorted.slice(i, i + perChapter) });
    }
    return groups;
  }
  if (mode === 'prefix') {
    const map = new Map<string, RawItem[]>();
    for (const item of sorted) {
      const base = item.name.replace(/\.[^.]+$/, '');
      const m = base.match(/^\D*(\d+)/);
      const key = m ? m[1] : base.slice(0, 3);
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return orderKeys([...map.entries()])
      .map(([key, list], i) => ({ title: `第 ${Number(key) || i + 1} 话`, items: list }));
  }

  // folder：按顶层目录分组
  const map = new Map<string, RawItem[]>();
  for (const item of sorted) {
    const parts = item.path.split('/').filter(Boolean);
    const key = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  const rootItems = map.get('') || [];
  map.delete('');
  const groups: ImportGroup[] = [];
  if (rootItems.length) groups.push({ title: '第 1 话', items: rootItems });
  orderKeys([...map.entries()])
    .forEach(([dir, list], i) => {
      const name = dir.split('/').pop() || dir;
      groups.push({ title: name || `第 ${i + 1} 话`, items: list });
    });
  return groups.map((g, i) => (g.title ? g : { ...g, title: `第 ${i + 1} 话` }));
}
