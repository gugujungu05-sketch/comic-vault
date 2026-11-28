/**
 * 全品类聚合检索（漫画 / 轻小说 / 动画 / 影视 / 游戏 / 音乐）
 *
 * 说明：本模块是「聚合检索」，把若干公开元数据 API 归一化成统一结构，
 * 让用户一次搜索就能看到多品类条目 + 各平台的多语言译名 + 正版发布/观看信息。
 * 数据来自各公开元数据库，本模块不声称"比谁更全"，只做聚合与规范化。
 *
 * 数据源（免费、无需 API Key）：
 *   - AniList GraphQL：ACGN 全品类（MANGA/NOVEL/ANIME/MOVIE/MUSIC），
 *     多语言标题与同义词、简介、封面、评分、人气、标签、年份、集/话/卷数、
 *     制作公司、原作来源、正版授权标记、官方外链（观看 / 官方 / 社交）、分集观看地址。
 *
 * 所有上游请求都在服务端发起以规避跨域；单个源失败优雅降级，不影响其它源。
 */
import express from 'express';

const ANILIST = 'https://graphql.anilist.co';
const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/* 分类：把 AniList 的 format 归到更好理解的品类，供前端筛选 */
export const UNI_CATEGORIES = [
  { key: 'all', label: '全部', hint: '综合所有品类' },
  { key: 'manga', label: '漫画', hint: '日漫 / 港漫 / 条漫' },
  { key: 'novel', label: '轻小说', hint: '轻小说 / Web 小说' },
  { key: 'anime', label: '动画', hint: 'TV / 网络 / OVA' },
  { key: 'movie', label: '影视', hint: '剧场版 / 电影' },
  { key: 'game', label: '游戏', hint: '改编游戏 / 原作游戏' },
  { key: 'music', label: '音乐', hint: '原声 / 主题曲' },
];

/* AniList 详情字段（列表页与详情共用；全部多语言与正版信息字段都在内） */
const MEDIA_FIELDS = `
  id
  title { romaji native english }
  synonyms
  coverImage { extraLarge large medium color }
  bannerImage
  description(asHtml: false)
  type
  format
  status
  episodes
  chapters
  volumes
  duration
  seasonYear
  averageScore
  meanScore
  popularity
  favourites
  genres
  tags { name rank isMediaSpoiler }
  siteUrl
  externalLinks { site url type language color icon }
  startDate { year month day }
  countryOfOrigin
  source
  isLicensed
  studios(isMain: true) { nodes { name siteUrl } }
  rankings { rank type context year }
`;

const SEARCH_QUERY = `
  query($q: String, $type: MediaType, $format: MediaFormat, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage total }
      media(search: $q, type: $type, format: $format, sort: SEARCH_MATCH, isAdult: false) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const DETAIL_QUERY = `
  query($id: Int) {
    Media(id: $id) {
      ${MEDIA_FIELDS}
      relations { edges { relationType node { id type format title { romaji native english } coverImage { large } siteUrl } } }
      characters(sort: [ROLE, RELEVANCE], perPage: 10) { nodes { name { full native } image { large } siteUrl } }
      staff(sort: RELEVANCE, perPage: 8) { nodes { name { full } image { large } siteUrl } }
      streamingEpisodes { site title url thumbnail }
    }
  }
`;

/* 中文常用译名 → AniList 可检索的罗马音/英文。
   AniList 对简中别名收录不全（如"芙莉莲"搜不到），这里补一层常见映射；
   未命中的中文词仍可用日文/英文/罗马音搜索。 */
const ZH_ALIAS = {
  '葬送的芙莉莲': 'Sousou no Frieren', '芙莉莲': 'Sousou no Frieren', '葬送的芙莉蓮': 'Sousou no Frieren',
  '进击的巨人': 'Shingeki no Kyojin', '攻击的巨人': 'Shingeki no Kyojin', '進撃の巨人': 'Shingeki no Kyojin',
  '海贼王': 'ONE PIECE', '航海王': 'ONE PIECE', 'ONE PIECE': 'ONE PIECE',
  '火影忍者': 'NARUTO', '咒术回战': 'Jujutsu Kaisen', '咒術迴戰': 'Jujutsu Kaisen',
  '鬼灭之刃': 'Kimetsu no Yaiba', '鬼滅之刃': 'Kimetsu no Yaiba', '电锯人': 'Chainsaw Man', '電鋸人': 'Chainsaw Man',
  '间谍过家家': 'SPY x FAMILY', '間諜家家酒': 'SPY x FAMILY', '藤本树': 'Chainsaw Man',
  '我的英雄学院': 'Boku no Hero Academia', '一拳超人': 'One-Punch Man',
  '排球少年': 'Haikyuu', '灌篮高手': 'Slam Dunk', '名侦探柯南': 'Detective Conan', '柯南': 'Detective Conan',
  '蜡笔小新': 'Crayon Shin-chan', '哆啦A梦': 'Doraemon', '龙珠': 'Dragon Ball', '七龙珠': 'Dragon Ball',
  '死神': 'BLEACH', '银魂': 'Gintama', '妖精的尾巴': 'Fairy Tail',
  '钢之炼金术师': 'Fullmetal Alchemist', '钢炼': 'Fullmetal Alchemist',
  '東京喰種': 'Tokyo Ghoul', '东京喰种': 'Tokyo Ghoul', '四月是你的谎言': 'Shigatsu wa Kimi no Uso',
  '你的名字': 'Kimi no Na wa', '铃芽之旅': 'Suzume', '鈴芽之旅': 'Suzume',
  '天气之子': 'Tenki no Ko', '千与千寻': 'Sen to Chihiro',
  '辉夜大小姐': 'Kaguya-sama', '辉夜大小姐想让我告白': 'Kaguya-sama',
  '蓝色监狱': 'Blue Lock', '蓝色时期': 'Blue Period', '药屋少女的呢喃': 'Kusuriya no Hitorigoto',
  '猫猫': 'Kusuriya no Hitorigoto', '迷宫饭': 'Dungeon Meshi', '迷宮飯': 'Dungeon Meshi',
  '坂本大佬': 'Sakamoto Days', '坂本': 'Sakamoto Days', '胆大党': 'Dandadan', '超自然武装': 'Dandadan',
  '无职转生': 'Mushoku Tensei', '無職轉生': 'Mushoku Tensei', 'Re:0': 'Re:Zero',
  '从零开始的异世界生活': 'Re:Zero', 'roland': 'Re:Zero',
  '原神': 'Genshin Impact', '崩坏星穹铁道': 'Honkai Star Rail', '崩壞星穹鐵道': 'Honkai Star Rail',
};
function expandQuery(q) {
  const key = String(q || '').trim();
  return ZH_ALIAS[key] || key;
}

/* format → 品类 key（与 UNI_CATEGORIES 对应） */
function categoryOf(format, type) {
  const f = String(format || '');
  if (f === 'MANGA' || f === 'ONE_SHOT') return 'manga';
  if (f === 'NOVEL') return 'novel';
  if (f === 'MOVIE') return 'movie';
  if (f === 'MUSIC') return 'music';
  if (['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'].includes(f)) return 'anime';
  return String(type || '').toLowerCase() === 'manga' ? 'manga' : 'anime';
}

/* 品类 key → AniList type / format 约束 */
function anilistConstraint(catRaw) {
  const cat = String(catRaw || 'all').toLowerCase();
  switch (cat) {
    case 'manga': return { type: 'MANGA', format: 'MANGA' };
    case 'novel': return { type: 'MANGA', format: 'NOVEL' };
    case 'movie': return { type: 'ANIME', format: 'MOVIE' };
    case 'music': return { type: 'ANIME', format: 'MUSIC' };
    case 'anime': return { type: 'ANIME' };
    case 'game': return {}; // AniList 无游戏品类，留给未来接入 IGDB/RAWG
    default: return {};
  }
}

/* 正版发布平台中文名（把 AniList 的 site 名映射成用户看得懂的多语言平台名） */
const WATCH_SITE_ZH = {
  'Crunchyroll': 'Crunchyroll', 'Netflix': 'Netflix', 'Bilibili TV': '哔哩哔哩（海外）',
  'Bilibili': '哔哩哔哩', 'Hulu': 'Hulu', 'Amazon Prime Video': 'Amazon Prime Video',
  'Disney+': 'Disney+', 'YouTube': 'YouTube', 'Official Site': '官方网站',
};
function watchSiteName(site) {
  return WATCH_SITE_ZH[site] || site || '观看平台';
}

async function anilistRequest(query, variables) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(ANILIST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': UA_DEFAULT,
      },
      body: JSON.stringify({ query, variables }),
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`AniList HTTP ${r.status}: ${text.slice(0, 200)}`);
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('AniList 返回无法解析'); }
    if (j.errors && j.errors.length && !j.data) throw new Error(j.errors[0]?.message || 'AniList 错误');
    return j;
  } finally { clearTimeout(timer); }
}

function stripHtml(s) {
  return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

/* iTunes Search API：免费无 Key，补充「游戏」品类（正版 App Store 入口） */
async function itunesSearch(q, media, country = 'us', limit = 12) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=${media}&country=${country}&limit=${limit}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA_DEFAULT }, signal: ac.signal });
    if (!r.ok) throw new Error(`iTunes HTTP ${r.status}`);
    const j = await r.json();
    return j.results || [];
  } finally { clearTimeout(timer); }
}

/** iTunes 条目 → 统一结构（正版入口指向 App Store / Apple Music） */
function normalizeItunes(x, category) {
  if (!x) return null;
  const cover = x.artworkUrl100 || x.artworkUrl512 || x.artworkUrl60 || '';
  const hiCover = cover.replace(/100x100bb/, '600x600bb');
  const url = x.trackViewUrl || x.collectionViewUrl || x.artistViewUrl || '';
  return {
    id: `itunes:${x.trackId || x.collectionId || Math.random().toString(36).slice(2)}`,
    source: 'Apple',
    sourceUrl: url,
    title: x.trackName || x.collectionName || '',
    titles: { native: x.trackName || '', romaji: '', english: x.trackName || '', chinese: '' },
    nativeTitle: x.trackName || '',
    englishTitle: x.trackName || '',
    chineseTitle: '',
    synonyms: [],
    cover: hiCover, banner: '', color: x.artworkUrl100 ? '' : '',
    description: stripHtml(x.description || x.shortDescription || ''),
    kind: category === 'game' ? 'game' : 'music',
    category,
    format: category === 'game' ? 'GAME' : 'MUSIC',
    status: '',
    year: x.releaseDate ? new Date(x.releaseDate).getFullYear() : null,
    score: null, meanScore: null,
    popularity: x.trackCount || 0, favourites: 0,
    episodes: null, chapters: null, volumes: null, duration: null,
    country: x.country || 'us',
    origin: '', licensed: true, studios: [], rankings: [],
    tags: [x.primaryGenreName, x.genreName].filter(Boolean),
    links: url ? [{ site: category === 'game' ? 'App Store（正版）' : 'Apple Music（正版）', rawSite: 'Apple', url, type: 'watch', language: '', color: '#fa2d48' }] : [],
    streamingEpisodes: [], relations: [],
  };
}

/* 从多语言标题与同义词中挑出中文名（含简/繁），供中文界面优先显示 */
function pickChineseTitle(title, synonyms) {
  const all = [title?.english, title?.romaji, title?.native, ...(synonyms || [])].filter(Boolean);
  const zh = all.find((s) => /[\u4e00-\u9fff]/.test(s));
  return zh || '';
}

/** 把 AniList media 归一化成统一结构（保留全部多语言 / 正版信息） */
function normalizeMedia(m) {
  if (!m) return null;
  const title = m.title || {};
  const cover = m.coverImage || {};
  const synonyms = Array.isArray(m.synonyms) ? m.synonyms.filter(Boolean) : [];

  /* 外链分类：观看(STREAMING) / 官方(INFO) / 社交(SOCIAL) */
  const links = [];
  for (const l of (m.externalLinks || [])) {
    if (!l.url) continue;
    const t = String(l.type || '');
    const kind = t === 'STREAMING' ? 'watch' : t === 'INFO' ? 'official' : t === 'SOCIAL' ? 'social' : 'info';
    links.push({
      site: watchSiteName(l.site),
      rawSite: l.site || '',
      url: l.url,
      type: kind,
      language: l.language || '',
      color: l.color || '',
    });
  }
  const tags = (m.genres || []).concat((m.tags || []).filter((t) => !t.isMediaSpoiler).map((t) => t.name));
  const studios = ((m.studios?.nodes) || []).map((s) => ({ name: s.name, siteUrl: s.siteUrl || '' }));
  const rankings = (m.rankings || []).slice(0, 6).map((r) => ({ rank: r.rank, context: r.context, year: r.year || null }));

  return {
    id: `anilist:${m.id}`,
    source: 'AniList',
    sourceUrl: m.siteUrl || `https://anilist.co/${String(m.type || '').toLowerCase()}/${m.id}`,
    // 多语言标题：title 仍是默认显示名（原生优先），另给完整集合供前端切换
    title: title.native || title.romaji || title.english || '',
    titles: {
      native: title.native || '',
      romaji: title.romaji || '',
      english: title.english || '',
      chinese: pickChineseTitle(title, synonyms),
    },
    nativeTitle: title.native || '',
    englishTitle: title.english || '',
    chineseTitle: pickChineseTitle(title, synonyms),
    synonyms,
    cover: cover.extraLarge || cover.large || cover.medium || '',
    banner: m.bannerImage || '',
    color: cover.color || '',
    description: stripHtml(m.description),
    kind: String(m.type || '').toLowerCase(),          // manga / anime
    category: categoryOf(m.format, m.type),            // manga/novel/anime/movie/music
    format: String(m.format || ''),                    // TV / MOVIE / MANGA / NOVEL / ONA ...
    status: String(m.status || ''),
    year: m.seasonYear || (m.startDate && m.startDate.year) || null,
    score: m.averageScore != null ? Number(m.averageScore) / 10 : null, // 0-10
    meanScore: m.meanScore != null ? Number(m.meanScore) / 10 : null,
    popularity: m.popularity || 0,
    favourites: m.favourites || 0,
    episodes: m.episodes || null,
    chapters: m.chapters || null,
    volumes: m.volumes || null,
    duration: m.duration || null,
    country: m.countryOfOrigin || '',
    origin: String(m.source || ''),                    // 原作来源：MANGA / LIGHT_NOVEL / NOVEL ...
    licensed: !!m.isLicensed,                         // 是否有正版授权
    studios,                                          // 制作公司
    rankings,                                         // 排名（如"highest rated"）
    tags: [...new Set(tags)].slice(0, 24),
    links,
    streamingEpisodes: [],                            // 仅详情填充
    relations: [],
  };
}

export function registerUniversalSearch(app) {
  const router = express.Router();

  // 品类清单
  router.get('/categories', (_req, res) => res.json({ categories: UNI_CATEGORIES, source: '聚合公开元数据库' }));

  // 全品类检索：?q=关键词&type=manga|novel|anime|movie|game|music|all&page=1
  router.get('/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ results: [], page: 1, hasNextPage: false, query: q });
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const cat = String(req.query.type || 'all').toLowerCase();
      const constraint = anilistConstraint(cat);

      /* 游戏 / 音乐品类走 iTunes（App Store / Apple Music 正版入口） */
      if (cat === 'game' || cat === 'music') {
        const media = cat === 'game' ? 'software' : 'music';
        const rows = await itunesSearch(q, media, 'us', 20);
        const results = rows.map((x) => normalizeItunes(x, cat)).filter(Boolean);
        return res.json({ results, page: 1, hasNextPage: false, total: results.length, query: q, category: cat, source: 'Apple iTunes' });
      }

      /* 多语言搜索：中文查询先按别名展开成罗马音 */
      const searchQ = expandQuery(q);
      const vars = { q: searchQ, page, perPage: 20, ...constraint };
      let j = await anilistRequest(SEARCH_QUERY, vars);
      let pg = j?.data?.Page || {};
      let media = pg.media || [];
      // 别名展开后为空则尝试原词（部分中文别名 AniList 直接收录）
      if (!media.length && searchQ !== q) {
        try {
          const j2 = await anilistRequest(SEARCH_QUERY, { ...vars, q });
          const pg2 = j2?.data?.Page || {};
          if ((pg2.media || []).length) { j = j2; pg = pg2; media = pg2.media; }
        } catch { /* 保留首次结果 */ }
      }
      // 全部品类：再补一次小说检索合并（AniList 的 ALL 搜索对 NOVEL 命中偏低）
      if (cat === 'all') {
        try {
          const j3 = await anilistRequest(SEARCH_QUERY, { q: searchQ, page, perPage: 10, type: 'MANGA', format: 'NOVEL' });
          const extra = ((j3?.data?.Page?.media) || []).map(normalizeMedia).filter(Boolean);
          const seen = new Set(media.map((m) => m?.id));
          for (const e of extra) if (!seen.has(Number(String(e.id).split(':')[1]))) media.push({ __normalized: e });
        } catch { /* ignore */ }
      }
      const results = media.map((m) => (m && m.__normalized ? m.__normalized : normalizeMedia(m))).filter(Boolean);
      res.json({
        results,
        page,
        hasNextPage: !!(pg.pageInfo && pg.pageInfo.hasNextPage),
        total: pg.pageInfo?.total || 0,
        query: q,
        category: cat,
        source: 'AniList',
      });
    } catch (err) {
      res.status(502).json({ error: err?.message || '检索失败' });
    }
  });

  // 详情：?id=anilist:12345
  router.get('/detail', async (req, res) => {
    try {
      const id = String(req.query.id || '');
      const m = /^anilist:(\d+)$/.exec(id);
      if (!m) return res.status(400).json({ error: '无效的条目 ID' });
      const j = await anilistRequest(DETAIL_QUERY, { id: Number(m[1]) });
      const media = j?.data?.Media;
      if (!media) return res.status(404).json({ error: '未找到' });
      const item = normalizeMedia(media);
      item.relations = ((media.relations?.edges || []).map((e) => ({
        relation: e.relationType,
        id: `anilist:${e.node?.id}`,
        title: e.node?.title?.romaji || e.node?.title?.native || '',
        cover: e.node?.coverImage?.large || '',
        format: e.node?.format || '',
        kind: String(e.node?.type || '').toLowerCase(),
        sourceUrl: e.node?.siteUrl || '',
      })));
      item.characters = (media.characters?.nodes || []).map((c) => ({
        name: c.name?.full || '', nativeName: c.name?.native || '',
        image: c.image?.large || '', sourceUrl: c.siteUrl || '',
      }));
      item.staff = (media.staff?.nodes || []).map((s) => ({
        name: s.name?.full || '', image: s.image?.large || '', sourceUrl: s.siteUrl || '',
      }));
      item.streamingEpisodes = (media.streamingEpisodes || []).map((e) => ({
        site: watchSiteName(e.site), title: e.title || '', url: e.url || '', thumbnail: e.thumbnail || '',
      }));
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: err?.message || '获取详情失败' });
    }
  });

  /* 首页推荐：多榜单聚合（热门 / 人气 / 高分 / 新作），不是单一网站热门榜 */
  router.get('/trending', async (req, res) => {
    try {
      const cat = String(req.query.type || 'anime').toLowerCase();
      const constraint = anilistConstraint(cat === 'manga' ? 'manga' : cat === 'novel' ? 'novel' : 'anime');
      const typeName = constraint.type || 'ANIME';
      const typeClause = constraint.format ? `,format:${constraint.format}` : '';
      const lists = [
        { key: 'trending', label: '正在热播', sort: 'TRENDING_DESC' },
        { key: 'popular', label: '人气最高', sort: 'POPULARITY_DESC' },
        { key: 'top', label: '评分最高', sort: 'SCORE_DESC' },
        { key: 'new', label: '最新作品', sort: 'START_DATE_DESC' },
      ];
      const sections = await Promise.all(lists.map(async (lst) => {
        try {
          const query = `query($type: MediaType){Page(page:1,perPage:12){media(type:$type${typeClause},sort:${lst.sort},isAdult:false){${MEDIA_FIELDS}}}}`;
          const j = await anilistRequest(query, { type: typeName });
          return { key: lst.key, label: lst.label, results: ((j?.data?.Page?.media) || []).map(normalizeMedia).filter(Boolean) };
        } catch { return { key: lst.key, label: lst.label, results: [] }; }
      }));
      res.json({ sections, results: sections[0]?.results || [], source: 'AniList 多榜单聚合' });
    } catch (err) {
      res.status(502).json({ error: err?.message || '获取排行失败' });
    }
  });

  app.use('/api/unisearch', router);
}
