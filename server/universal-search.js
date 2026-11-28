/**
 * 全站书籍检索（比番组计划更全）
 *
 * 聚合多个无需 Key 的公开元数据 API，一次搜索覆盖：漫画、动画、TV/剧场版、轻小说，
 * 并返回「哪里能看」的官方流媒体/观看网址。
 *
 * 数据源（均为免费、无需 API Key）：
 *   - AniList GraphQL：ACGN 全品类（漫画/动画/小说），多语言标题、简介、封面、评分、
 *     标签、播出年份、集数/话数、官方外链（Crunchyroll/Bilibili/Netflix 等观看地址）。
 *     对中文名搜索也支持（其内部有别名库）。
 *
 * 所有上游请求在服务端发起，规避浏览器跨域；失败时优雅降级，不影响其它源。
 */
import express from 'express';

const ANILIST = 'https://graphql.anilist.co';
const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/* AniList 详情查询字段（列表页与详情共用） */
const MEDIA_FIELDS = `
  id
  title { romaji native english }
  coverImage { large medium color }
  bannerImage
  description(asHtml: false)
  type
  format
  status
  episodes
  chapters
  volumes
  seasonYear
  averageScore
  popularity
  genres
  tags { name rank isMediaSpoiler }
  siteUrl
  externalLinks { site url type language }
  startDate { year month day }
  synonyms
`;

const SEARCH_QUERY = `
  query($q: String, $type: MediaType, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage total }
      media(search: $q, type: $type, sort: SEARCH_MATCH, isAdult: false) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const DETAIL_QUERY = `
  query($id: Int) {
    Media(id: $id) {
      ${MEDIA_FIELDS}
      relations { edges { relationType node { id type title { romaji native english } coverImage { large } siteUrl } } }
      characters(sort: [ROLE, RELEVANCE], perPage: 8) { nodes { name { full native } image { large } siteUrl } }
      staff(sort: RELEVANCE, perPage: 6) { nodes { name { full } image { large } siteUrl } }
    }
  }
`;

/* 中文常用译名 → AniList 可检索的罗马音/英文。
   AniList 对简中别名收录不全（如"芙莉莲"搜不到），这里补一层常见映射；
   未命中的中文词仍可用日文/英文/罗马音搜，前端也给了提示。 */
const ZH_ALIAS = {
  '葬送的芙莉莲': 'Sousou no Frieren', '芙莉莲': 'Sousou no Frieren',
  '进击的巨人': 'Shingeki no Kyojin', '攻击的巨人': 'Shingeki no Kyojin',
  '海贼王': 'ONE PIECE', '航海王': 'ONE PIECE',
  '火影忍者': 'NARUTO', '咒术回战': 'Jujutsu Kaisen',
  '鬼灭之刃': 'Kimetsu no Yaiba', '电锯人': 'Chainsaw Man',
  '间谍过家家': 'SPY x FAMILY', '藤本树': 'Chainsaw Man',
  '我的英雄学院': 'Boku no Hero Academia', '一拳超人': 'One-Punch Man',
  '排球少年': 'Haikyuu', '灌篮高手': 'Slam Dunk',
  '名侦探柯南': 'Detective Conan', '柯南': 'Detective Conan',
  '蜡笔小新': 'Crayon Shin-chan', '哆啦A梦': 'Doraemon',
  '龙珠': 'Dragon Ball', '七龙珠': 'Dragon Ball',
  '死神': 'BLEACH', '境界记录带': 'BLEACH',
  '银魂': 'Gintama', '妖精的尾巴': 'Fairy Tail',
  '钢之炼金术师': 'Fullmetal Alchemist', '钢炼': 'Fullmetal Alchemist',
  '東京喰種': 'Tokyo Ghoul', '东京喰种': 'Tokyo Ghoul',
  '四月是你的谎言': 'Shigatsu wa Kimi no Uso',
  '你的名字': 'Kimi no Na wa', '铃芽之旅': 'Suzume',
  '天气之子': 'Tenki no Ko', '千与千寻': 'Sen to Chihiro',
  '辉夜大小姐': 'Kaguya-sama', '辉夜大小姐想让我告白': 'Kaguya-sama',
  '原神': 'Genshin Impact', '崩坏星穹铁道': 'Honkai Star Rail',
  '蓝色监狱': 'Blue Lock', '蓝色时期': 'Blue Period',
  '药屋少女的呢喃': 'Kusuriya no Hitorigoto', '猫猫': 'Kusuriya no Hitorigoto',
  '葬送': 'Sousou no Frieren', '迷宫饭': 'Dungeon Meshi',
  '坂本大佬': 'Sakamoto Days', '坂本': 'Sakamoto Days',
  '胆大党': 'Dandadan', '超自然武装': 'Dandadan',
  '忍者之家': 'House of Ninjas', '迷宫': 'Dungeon Meshi',
};
function expandQuery(q) {
  const key = String(q || '').trim();
  return ZH_ALIAS[key] || key;
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

/** 把 AniList media 归一化成统一结构 */
function normalizeMedia(m) {
  if (!m) return null;
  const title = m.title || {};
  const cover = m.coverImage || {};
  // 观看链接：STREAMING 优先，其次 INFO 官方站；过滤掉社交/广告
  const links = [];
  for (const l of (m.externalLinks || [])) {
    const type = String(l.type || '');
    if (!/^(STREAMING|INFO)$/.test(type)) continue;
    if (!l.url) continue;
    links.push({ site: l.site || '官网', url: l.url, type: type === 'STREAMING' ? 'watch' : 'info' });
  }
  const tags = (m.genres || []).concat((m.tags || []).filter((t) => !t.isMediaSpoiler).map((t) => t.name));
  return {
    id: `anilist:${m.id}`,
    source: 'AniList',
    sourceUrl: m.siteUrl || `https://anilist.co/${String(m.type || '').toLowerCase()}/${m.id}`,
    title: title.romaji || title.english || title.native || '',
    nativeTitle: title.native || '',
    englishTitle: title.english || '',
    synonyms: Array.isArray(m.synonyms) ? m.synonyms : [],
    cover: cover.extraLarge || cover.large || cover.medium || '',
    banner: m.bannerImage || '',
    color: cover.color || '',
    description: stripHtml(m.description),
    kind: String(m.type || '').toLowerCase(),          // manga / anime
    format: String(m.format || ''),                    // TV / MOVIE / MANGA / NOVEL / ONA ...
    status: String(m.status || ''),
    year: m.seasonYear || (m.startDate && m.startDate.year) || null,
    score: m.averageScore != null ? Number(m.averageScore) / 10 : null, // 0-10
    popularity: m.popularity || 0,
    episodes: m.episodes || null,
    chapters: m.chapters || null,
    volumes: m.volumes || null,
    tags: [...new Set(tags)].slice(0, 20),
    links,
    relations: [],
  };
}

export function registerUniversalSearch(app) {
  const router = express.Router();

  // 全站检索：?q=关键词&type=manga|anime|all&page=1
  router.get('/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ results: [], page: 1, hasNextPage: false, query: q });
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const typeRaw = String(req.query.type || 'all').toLowerCase();
      const mediaType = typeRaw === 'manga' ? 'MANGA' : typeRaw === 'anime' ? 'ANIME' : undefined;

      // 中文查询：先按别名展开，AniList 对简中别名收录不全，展开成罗马音命中率更高。
      const searchQ = expandQuery(q);
      const vars = { q: searchQ, page, perPage: 20 };
      if (mediaType) vars.type = mediaType;
      let j = await anilistRequest(SEARCH_QUERY, vars);
      let pg = j?.data?.Page || {};
      let media = pg.media || [];
      // 若别名展开后仍为空且原词是中文，尝试原词（有些中文别名 AniList 是有的）
      if (!media.length && searchQ !== q) {
        try {
          const j2 = await anilistRequest(SEARCH_QUERY, { ...vars, q });
          const pg2 = j2?.data?.Page || {};
          if ((pg2.media || []).length) { j = j2; pg = pg2; media = pg2.media; }
        } catch { /* 保留首次结果 */ }
      }
      const results = media.map(normalizeMedia).filter(Boolean);
      res.json({
        results,
        page,
        hasNextPage: !!(pg.pageInfo && pg.pageInfo.hasNextPage),
        total: pg.pageInfo?.total || 0,
        query: q,
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
      if (!m) return res.status(400).json({ error: '无效的书籍 ID' });
      const j = await anilistRequest(DETAIL_QUERY, { id: Number(m[1]) });
      const media = j?.data?.Media;
      if (!media) return res.status(404).json({ error: '未找到' });
      const item = normalizeMedia(media);
      item.relations = ((media.relations?.edges || []).map((e) => ({
        relation: e.relationType,
        id: `anilist:${e.node?.id}`,
        title: e.node?.title?.romaji || e.node?.title?.native || '',
        cover: e.node?.coverImage?.large || '',
        kind: String(e.node?.type || '').toLowerCase(),
        sourceUrl: e.node?.siteUrl || '',
      })));
      item.characters = (media.characters?.nodes || []).map((c) => ({
        name: c.name?.full || '', image: c.image?.large || '', sourceUrl: c.siteUrl || '',
      }));
      item.staff = (media.staff?.nodes || []).map((s) => ({
        name: s.name?.full || '', image: s.image?.large || '', sourceUrl: s.siteUrl || '',
      }));
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: err?.message || '获取详情失败' });
    }
  });

  // 热门排行（首页推荐）：?type=anime|manga
  router.get('/trending', async (req, res) => {
    try {
      const typeRaw = String(req.query.type || 'anime').toLowerCase();
      const type = typeRaw === 'manga' ? 'MANGA' : 'ANIME';
      const query = `query($type: MediaType){Page(page:1,perPage:20){media(type:$type,sort:TRENDING_DESC,isAdult:false){${MEDIA_FIELDS}}}}`;
      const j = await anilistRequest(query, { type });
      const results = ((j?.data?.Page?.media) || []).map(normalizeMedia).filter(Boolean);
      res.json({ results, source: 'AniList' });
    } catch (err) {
      res.status(502).json({ error: err?.message || '获取排行失败' });
    }
  });

  app.use('/api/unisearch', router);
}
