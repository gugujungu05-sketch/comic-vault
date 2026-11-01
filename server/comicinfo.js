/**
 * ComicInfo.xml —— ComicRack / YACReader / Panels / Tachiyomi / Koreader 通用的元数据标准。
 * 这里负责「全量字段解析」与「导出时写回」，导入时不丢字段、导出时保留原信息。
 */

/** 需要原样保留的字段（顺序即写回顺序） */
export const COMIC_INFO_FIELDS = [
  'Title',
  'Series',
  'Number',
  'Volume',
  'AlternateSeries',
  'AlternateNumber',
  'StoryArc',
  'SeriesGroup',
  'Summary',
  'Notes',
  'Writer',
  'Penciller',
  'Inker',
  'Colorist',
  'Letterer',
  'Editor',
  'Translator',
  'Publisher',
  'Imprint',
  'Genre',
  'Tags',
  'Web',
  'Characters',
  'Teams',
  'Locations',
  'MainCharacterOrTeam',
  'ScanInformation',
  'AgeRating',
  'Rating',
  'CommunityRating',
  'Review',
  'LanguageISO',
  'Format',
  'BlackAndWhite',
  'Manga',
  'Year',
  'Month',
  'Day',
  'PageCount',
  'Count',
];

export function decodeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 解析 ComicInfo.xml，返回全部识别到的字段（值都做过去转义与去空白） */
export function parseComicInfo(xmlText) {
  if (!xmlText) return null;
  const out = {};
  for (const tag of COMIC_INFO_FIELDS) {
    const m = xmlText.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) {
      const v = decodeXml(m[1]).trim();
      if (v) out[tag] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 把 ComicInfo 映射到 ComicVault 的漫画字段 */
export function comicFieldsFromInfo(info) {
  if (!info) return {};
  const list = (v) =>
    String(v || '')
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean);
  const tags = list(info.Tags || info.Genre);
  const manga = String(info.Manga || '');
  const rtl = /yes|right/i.test(manga);
  const year = Number(info.Year) || null;
  return {
    title: info.Series || info.Title || '',
    author: info.Writer || '',
    artist: info.Penciller || info.Inker || info.Colorist || '',
    description: info.Summary || info.Notes || '',
    tags,
    language: (info.LanguageISO || '').toLowerCase() || '',
    direction: rtl ? 'rtl' : undefined,
    publisher: info.Publisher || '',
    year: year || undefined,
    rating: Number(info.CommunityRating || info.Rating) || undefined,
    ageRating: info.AgeRating || '',
    number: info.Number || '',
    volume: info.Volume || '',
  };
}

/**
 * 导出 CBZ 时生成 ComicInfo.xml。
 * 若漫画保留了导入时的原始元数据（comic.comicInfo），以其为基底，
 * 再用当前库里的信息覆盖关键字段，避免丢失出版社/年份/评分等原生字段。
 */
export function comicInfoXml(comic, chapter, pageCount, index = 0) {
  const base = { ...(comic.comicInfo || {}) };
  const num = chapter.number != null && chapter.number !== '' ? chapter.number : index + 1;
  const merged = {
    ...base,
    Title: chapter.title || `第 ${num} 话`,
    Series: comic.title,
    Number: num,
    Writer: comic.author || base.Writer || '',
    Penciller: comic.artist || base.Penciller || '',
    Summary: comic.description || base.Summary || '',
    Genre: (comic.tags || []).join(', ') || base.Genre || '',
    Tags: (comic.tags || []).join(', ') || base.Tags || '',
    LanguageISO: comic.language || base.LanguageISO || 'zh',
    Manga: comic.direction === 'rtl' ? 'YesAndRightToLeft' : 'No',
    PageCount: pageCount,
    ScanInformation: base.ScanInformation || 'ComicVault',
    Notes: base.Notes || '由 ComicVault 导出',
  };
  // 空值不写出，保持 XML 干净
  const body = COMIC_INFO_FIELDS.filter((f) => merged[f] !== undefined && merged[f] !== '')
    .map((f) => `  <${f}>${xmlEscape(merged[f])}</${f}>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    body,
    '</ComicInfo>',
  ].join('\n');
}
