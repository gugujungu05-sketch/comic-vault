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
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const ANILIST = 'https://graphql.anilist.co';
const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/* ------------------------------ 中文本地化（零成本本地映射 + GLM 按需翻译缓存） ------------------------------ */
/* AniList 的简介/标签几乎全是英文，原生语言标题是日文。中文元数据库（Bangumi/维基）在部分环境不可达，
   因此采用两层策略：① 常见标签/枚举用本地映射即时中文化；② 标题/简介用 GLM 文本翻译后落盘缓存，
   只翻一次（详情打开时按需），后续命中缓存不再消耗 token。参考 VeneraX「识别/翻译解耦 + 预翻译缓存」思路。 */

const I18N_FILE = path.join(DATA_DIR, 'unisearch-i18n.json');
let i18nCache = null;
function loadI18n() {
  if (i18nCache) return i18nCache;
  try { i18nCache = JSON.parse(fs.readFileSync(I18N_FILE, 'utf8')); }
  catch { i18nCache = {}; }
  return i18nCache;
}
function saveI18n() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(I18N_FILE, JSON.stringify(i18nCache || {}, null, 2), 'utf8');
  } catch { /* 缓存写失败不影响功能 */ }
}
function getI18n(id) { return loadI18n()[id] || null; }
function putI18n(id, patch) {
  const c = loadI18n();
  c[id] = { ...(c[id] || {}), ...patch, ts: Date.now() };
  saveI18n();
}

/* 常见英文标签 → 中文（AniList tags/genres 是有限枚举，本地映射零延迟零成本） */
const TAG_ZH = {
  'Action':'动作','Adventure':'冒险','Comedy':'喜剧','Drama':'剧情','Fantasy':'奇幻','Horror':'恐怖','Mystery':'悬疑',
  'Romance':'恋爱','Sci-Fi':'科幻','Slice of Life':'日常','Sports':'运动','Supernatural':'超自然','Thriller':'惊悚',
  'Psychological':'心理','Historical':'历史','Military':'军事','Mecha':'机甲','Music':'音乐','School':'校园',
  'Shounen':'少年','Shoujo':'少女','Seinen':'青年','Josei':'女性','Kids':'儿童','Family':'家庭','Harem':'后宫',
  'Isekai':'异世界','Reincarnation':'转生','Time Loop':'时间循环','Time Travel':'穿越时空','Time Manipulation':'时间操控',
  'Magic':'魔法','Superpower':'超能力','Martial Arts':'武侠','Samurai':'武士','Ninja':'忍者','Pirates':'海盗',
  'Detective':'侦探','Crime':'犯罪','Political':'政治','War':'战争','Survival':'生存','Post-Apocalyptic':'末世',
  'Cyberpunk':'赛博朋克','Space':'太空','Aliens':'外星人','Kaiju':'怪兽','Monster':'怪物','Demons':'恶魔',
  'Ghosts':'幽灵','Vampires':'吸血鬼','Witches':'魔女','Mythology':'神话','Folklore':'民俗','Philosophy':'哲学',
  'Religion':'宗教','Space Opera':'太空歌剧','Gunfighter':'枪战','Western':'西部','Superhero':'超级英雄',
  'Team Sports':'团队运动','Football':'足球','Basketball':'篮球','Baseball':'棒球','Volleyball':'排球','Rugby':'橄榄球',
  'Golf':'高尔夫','Tennis':'网球','Boxing':'拳击','Wrestling':'摔跤','Racing':'赛车','Fishing':'钓鱼',
  'Cooking':'美食','Gourmet':'美食','Music Industry':'音乐产业','Idols':'偶像','Acting':'演艺','Art':'艺术',
  'Photography':'摄影','Journalism':'新闻','Business':'商业','Medicine':'医疗','Law':'法律','Courtroom':'法庭',
  'Food':'美食','Travel':'旅行','Nature':'自然','Animals':'动物','Kemonomimi':'兽耳','Nekomimi':'猫耳',
  'Crossdressing':'女装','Gender Bending':'性转','Cosplay':'角色扮演','Otaku Culture':'御宅文化','Gaming':'游戏',
  'Anime Industry':'动画产业','Manga Industry':'漫画产业','Award Winning':'获奖作品','Adaptation':'改编',
  'Original':'原创','Visual Novel':'视觉小说','Erotica':'情色','Ecchi':'绅士','Gore':'血腥','Violence':'暴力',
  'Male Protagonist':'男主角','Female Protagonist':'女主角','Primarily Teen Cast':'青少年主角','Ensemble Cast':'群像剧',
  'Found Family':'寻亲','Coming of Age':'成长','Friendship':'友情','Rivalry':'宿敌','Revenge':'复仇',
  'Tragedy':'悲剧','Melancholy':'忧郁','Emotional':'情感','Feel Good':'治愈','Iyashikei':'治愈系','Wholesome':'温馨',
  'Dark':'黑暗','Gritty':'写实','Satire':'讽刺','Parody':'恶搞','Slapstick':'搞笑','Deadpan':'冷幽默',
  'Time Manipulation':'时间操控','Memory Manipulation':'记忆操控','Mind Control':'精神控制','Illusions':'幻觉',
  'Dream':'梦境','Alternate Universe':'平行世界','Isekai':'异世界','Transport':'穿越','Summoning':'召唤',
  'Dragons':'龙','Elf':'精灵','Dwarves':'矮人','Fairy':'妖精','Gods':'神明','Angels':'天使','Fallen Angels':'堕天使',
  'Giant Robots':'巨型机器人','Mecha':'机甲','Cyborg':'赛博格','Android':'仿生人','AI':'人工智能',
  'Steampunk':'蒸汽朋克','Dieselpunk':'柴油朋克','Atom Punk':'原子朋克','Retro':'复古','Vintage':'复古',
  'College':'大学','High School':'高中','Middle School':'初中','Elementary School':'小学','Workplace':'职场',
  'Childhood Friends':'青梅竹马','Siblings':'兄弟姐妹','Parents':'父母','Teacher-Student':'师生','Master-Servant':'主仆',
  'Butler':'管家','Maid':'女仆','Idol':'偶像','Princess':'公主','Prince':'王子','King':'国王','Queen':'女王',
  'Villain':'反派','Anti-Hero':'反英雄','Hero':'英雄','Chosen One':'天选之人','Destiny':'命运','Fate':'命运',
  'Swordplay':'剑术','Archery':'射箭','Magic Knight':'魔法骑士','Assassin':'刺客','Mercenary':'佣兵','Knight':'骑士',
  'Witch':'魔女','Wizard':'巫师','Sorcerer':'术士','Shaman':'萨满','Onmyouji':'阴阳师','Yokai':'妖怪',
  'Gambling':'赌博','Psychological Game':'心理博弈','Chess':'棋类','Board Game':'桌游','Video Games':'电子游戏',
  'Delinquents':'不良少年','Yakuza':'黑道','Gang':'帮派','Terrorism':'恐怖主义','Spy':'间谍','Assassination':'暗杀',
  'Heist':'盗贼','Treasure Hunt':'寻宝','Archaeology':'考古','Fossils':'化石','Dinosaurs':'恐龙',
  'Apocalypse':'末日','Zombies':'丧尸','Plague':'瘟疫','Disaster':'灾难','Natural Disaster':'自然灾害',
  'Time Skip':'时间跳跃','Memory Loss':'失忆','Amnesia':'失忆','Reincarnation':'转生','Isekai':'异世界',
  'Transmigration':'穿越','Possession':'附身','Body Swap':'身体互换','Immortality':'永生','Curse':'诅咒',
  'Contract':'契约','Pact':'契约','Sacrifice':'献祭','Resurrection':'复活','Afterlife':'来世','Reincarnation':'转世',
  'Hospital':'医院','Prison':'监狱','Court':'法庭','Politics':'政治','Election':'选举','Revolution':'革命',
  'Space Station':'空间站','Moon':'月球','Mars':'火星','Galaxy':'银河','Universe':'宇宙','Dimension':'次元',
  'Virtual Reality':'虚拟现实','Simulation':'模拟','Game World':'游戏世界','Dungeon':'地下城','Labyrinth':'迷宫',
  'Treasure':'宝藏','Quest':'任务','Journey':'旅程','Pilgrimage':'朝圣','Road Trip':'公路旅行',
  'Solo Leveling':'单人升级','Level Up':'升级','System':'系统','Skill':'技能','Ranking':'排名','Tournament':'大赛',
  'Betrayal':'背叛','Loyalty':'忠诚','Honor':'荣誉','Duty':'责任','Sacrifice':'牺牲','Redemption':'救赎',
  'Forbidden Love':'禁忌之恋','First Love':'初恋','Unrequited Love':'单恋','Love Triangle':'三角恋','Marriage':'婚姻',
  'Wedding':'婚礼','Pregnancy':'怀孕','Baby':'婴儿','Childhood':'童年','Growth':'成长','Coming Home':'归乡',
  'Black Comedy':'黑色幽默','Absurdist':'荒诞','Surreal':'超现实','Experimental':'实验性','Avant Garde':'先锋',
  'Gothic':'哥特','Noir':'黑色电影','Film Noir':'黑色电影','Splatter':'血浆','Torture':'酷刑','Psychological Horror':'心理恐怖',
  'Body Horror':'肉体恐怖','Cosmic Horror':'宇宙恐怖','Eldritch':'诡秘','Lovecraftian':'克苏鲁',
  'Space Western':'太空西部','Space Fantasy':'太空奇幻','Planetary Romance':'行星传奇','Solar System':'太阳系',
};

const FORMAT_ZH = {
  TV:'TV 动画', TV_SHORT:'短篇动画', MOVIE:'剧场版', OVA:'OVA', ONA:'网络动画', SPECIAL:'特别篇',
  MANGA:'漫画', NOVEL:'轻小说', ONE_SHOT:'短篇漫画', MUSIC:'音乐', GAME:'游戏',
};
const STATUS_ZH = {
  FINISHED:'已完结', ONGOING:'连载中', RELEASING:'连载中', NOT_YET_RELEASED:'未播出',
  CANCELLED:'已取消', HIATUS:'休刊中',
};
const ORIGIN_ZH = {
  MANGA:'漫画改编', LIGHT_NOVEL:'轻小说改编', NOVEL:'小说改编', ORIGINAL:'原创',
  VISUAL_NOVEL:'视觉小说改编', VIDEO_GAME:'游戏改编', OTHER:'其它', MANGA_ADAPTATION:'漫画改编',
};
const COUNTRY_ZH = {
  JP:'日本', CN:'中国', KR:'韩国', TW:'中国台湾', HK:'中国香港', US:'美国', GB:'英国',
  FR:'法国', DE:'德国', CA:'加拿大', AU:'澳大利亚', IT:'意大利', ES:'西班牙', RU:'俄罗斯',
};
function zhTag(t) { return TAG_ZH[t] || t; }
function localizedTags(tags) { return (tags || []).map((t) => zhTag(String(t))); }

/* 用 GLM 文本翻译（思考模型必须开思考，6s 左右；只在详情/批量按需触发，结果落盘缓存） */
async function glmTranslate(payload) {
  const db = loadDbSafe();
  const t = (db?.settings && db.settings.translate) || {};
  const key = String(t.apiKey || '');
  const baseUrl = String(t.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const model = String(t.model || 'glm-5.3-flash');
  if (!key) return null;
  const prompt = '你是ACG领域翻译。把下面的内容翻译成简体中文：作品名用通用中文译名（无译名则音译），简介自然流畅，标签用简短中文词。只输出一行合法JSON，不要多余文字，格式：{"title":"...","desc":"...","tags":["...","..."]}\n原文：' + JSON.stringify(payload);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    const match = String(content).match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      desc: typeof parsed.desc === 'string' ? parsed.desc : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((x) => typeof x === 'string') : [],
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
/* 批量翻译：一次 GLM 调用翻译多条（标题/简介/标签），按 id 返回。效率远高于逐条调用。 */
async function glmTranslateBatch(items) {
  const db = loadDbSafe();
  const t = (db?.settings && db.settings.translate) || {};
  const key = String(t.apiKey || '');
  const baseUrl = String(t.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const model = String(t.model || 'glm-5.3-flash');
  if (!key || !items.length) return {};
  const input = items.map((it) => ({ id: it.id, title: it.title || '', desc: (it.desc || '').slice(0, 500), tags: (it.tags || []).slice(0, 8) }));
  const prompt = '你是ACG领域翻译。把数组里每一条翻译成简体中文：作品名用通用中文译名（无译名则音译），简介自然流畅，标签用简短中文词。只输出一个合法JSON数组，元素顺序与输入一致，每个元素格式：{"id":"原id","title":"...","desc":"...","tags":["..."]}，不要多余文字。\n原文数组：' + JSON.stringify(input);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
      signal: ac.signal,
    });
    if (!r.ok) return {};
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return {};
    const match = String(content).match(/\[[\s\S]*\]/);
    if (!match) return {};
    const arr = JSON.parse(match[0]);
    const out = {};
    for (const row of (Array.isArray(arr) ? arr : [])) {
      if (!row || !row.id) continue;
      out[row.id] = {
        title: typeof row.title === 'string' ? row.title : '',
        desc: typeof row.desc === 'string' ? row.desc : '',
        tags: Array.isArray(row.tags) ? row.tags.filter((x) => typeof x === 'string') : [],
      };
    }
    return out;
  } catch { return {}; }
  finally { clearTimeout(timer); }
}
function loadDbSafe() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8')); }
  catch { return null; }
}

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
  // 轻小说 / 热门新番补充
  '葬送的芙莉莲': 'Sousou no Frieren',
  '关于我转生变成史莱姆这档事': 'Tensei Shitara Slime Datta Ken', '转生史莱姆': 'Tensei Shitara Slime Datta Ken',
  '史莱姆': 'Tensei Shitara Slime Datta Ken', 'overlord': 'Overlord', '不死者之王': 'Overlord',
  '樵夫之剑': 'Kikou Sennyo Rouran', '哥布林杀手': 'Goblin Slayer', '哥殺': 'Goblin Slayer',
  '为美好的世界献上祝福': 'KonoSuba', '素晴': 'KonoSuba', '这个美术社大有问题': 'Bijutsu Bukatsu no Yuucha wa Owaranai',
  '盾之勇者成名录': 'Tate no Yuusha no Nariagari', '盾勇': 'Tate no Yuusha no Nariagari',
  '回复术士的重启人生': 'Kaifuku Jutsushi no Yarinaoshi', '平凡职业造就世界最强': 'Hataraku Maou-sama',
  '青春猪头少年': 'Seishun Buta Yarou',
  '青春猪头少年不会梦到兔女郎学姐': 'Seishun Buta Yarou', '樱岛麻衣': 'Seishun Buta Yarou',
  '我的青春恋爱物语果然有问题': 'OreGairu', '春物': 'OreGairu', '比企谷八幡': 'OreGairu',
  '欢迎来到实力至上主义的教室': 'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e', '实教': 'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e',
  '龙王的工作': 'Ryuuou no Oshigoto', '幼女': 'Ryuuou no Oshigoto', '陨石': 'Ryuuou no Oshigoto',
  '三月的狮子': 'Sangatsu no Lion', '3月的狮子': 'Sangatsu no Lion', '狮子宫': 'Sangatsu no Lion',
  '紫罗兰永恒花园': 'Violet Evergarden', '薇尔莉特': 'Violet Evergarden', '京紫': 'Violet Evergarden',
  '少女终末旅行': 'Shoujo Shuumatsu Ryokou', '少女终末': 'Shoujo Shuumatsu Ryokou',
  '到 UFO 之丘': 'UFO ga Tobu Oka', '旋转少女': 'Roto', '水星领航员': 'ARIA',
  '狼与香辛料': 'Spice and Wolf', '狼辛': 'Spice and Wolf', '赫萝': 'Spice and Wolf',
  '灼眼的夏娜': 'Shakugan no Shana', '夏娜': 'Shakugan no Shana', '凉宫春日': 'Suzumiya Haruhi',
  '幸运星': 'Lucky Star', '幸运☆星': 'Lucky Star', '起司': 'Lucky Star', '美少女战士': 'Bishoujo Senshi Sailor Moon',
  '魔法少女小圆': 'Puella Magi Madoka Magica', '小圆': 'Puella Magi Madoka Magica', '圆神': 'Puella Magi Madoka Magica',
  'Fate/stay night': 'Fate stay night', 'fate': 'Fate', 'FGO': 'Fate Grand Order', ' Fate/Grand Order': 'Fate Grand Order',
  '命运之夜': 'Fate stay night', '魔法禁书目录': 'Toaru Majutsu no Index', '魔禁': 'Toaru Majutsu no Index',
  '某科学的超电磁炮': 'Toaru Kagaku no Railgun', '炮姐': 'Toaru Kagaku no Railgun', '御坂美琴': 'Toaru Kagaku no Railgun',
  '心理测量者': 'PSYCHO-PASS', '犯罪心理': 'PSYCHO-PASS', '通用': 'PSYCHO-PASS',
  '电锯人': 'Chainsaw Man', '链锯人': 'Chainsaw Man', '电次': 'Chainsaw Man',
  '炎炎消防队': 'Enen no Shouboutai', '消防队': 'Enen no Shouboutai',
  '一拳超人': 'One-Punch Man', '琦玉': 'One-Punch Man', '埼玉': 'One-Punch Man',
  '咒术回战': 'Jujutsu Kaisen', '五条悟': 'Jujutsu Kaisen', '虎杖悠仁': 'Jujutsu Kaisen',
  '鬼灭之刃': 'Kimetsu no Yaiba', '炭治郎': 'Kimetsu no Yaiba', '祢豆子': 'Kimetsu no Yaiba',
  '进击的巨人': 'Shingeki no Kyojin', '艾伦': 'Shingeki no Kyojin', '三笠': 'Shingeki no Kyojin',
  '海贼王': 'ONE PIECE', '路飞': 'ONE PIECE', '索隆': 'ONE PIECE', '娜美': 'ONE PIECE',
  '火影忍者': 'NARUTO', '鸣人': 'NARUTO', '佐助': 'NARUTO', '博人': 'BORUTO',
  '死神': 'BLEACH', '黑崎一护': 'BLEACH', '银魂': 'Gintama', '坂田银时': 'Gintama',
  '博多豚骨拉面团': 'Hakata Tonkotsu Ramens', '多田骏介': 'Hakata Tonkotsu Ramens',
  '黑执事': 'Kuroshitsuji', '夏尔': 'Kuroshitsuji', '赛巴斯': 'Kuroshitsuji',
  '文豪野犬': 'Bungou Stray Dogs', '太宰治': 'Bungou Stray Dogs', '中岛敦': 'Bungou Stray Dogs',
  '偶像梦幻祭': 'Ensemble Stars', 'es': 'Ensemble Stars', '合奏明星': 'Ensemble Stars',
  '刀剑乱舞': 'Touken Ranbu', '刀男': 'Touken Ranbu', '冲田组': 'Touken Ranbu',
  '偶像大师': 'THE IDOLM@STER', '灰姑娘': 'THE IDOLM@STER CINDERELLA GIRLS', 'mltd': 'THE IDOLM@STER Million Live',
  ' Love Live': 'Love Live', 'lovelive': 'Love Live', ' μ\'sic': 'Love Live', 'Aqours': 'Love Live Sunshine',
  'BanG Dream': 'BanG Dream', '少女乐团': 'BanG Dream', 'Roselia': 'BanG Dream', 'Poppin Party': 'BanG Dream',
  '赛马娘': 'Uma Musume Pretty Derby', '马娘': 'Uma Musume Pretty Derby', '特别周': 'Uma Musume Pretty Derby',
  '辉夜大小姐想让我告白': 'Kaguya-sama', '白银御行': 'Kaguya-sama', '四宫辉夜': 'Kaguya-sama',
  '五等分的新娘': '5-toubun no Hanayome', '五等分': '5-toubun no Hanayome', '中野三玖': '5-toubun no Hanayome',
  '租借女友': 'Rent-A-Girlfriend', '和也': 'Rent-A-Girlfriend', '水原千鹤': 'Rent-A-Girlfriend',
  '堀与宫村': 'Hori Miya', '宫村伊澄': 'Hori Miya', '堀京子': 'Hori Miya',
  '会长是女仆大人': 'Kaichou wa Maid-sama', '鲇泽美咲': 'Kaichou wa Maid-sama',
  '月刊少女野崎君': 'Gekkan Shoujo Nozaki-kun', '野崎梅太郎': 'Gekkan Shoujo Nozaki-kun',
  '元气少女缘结神': 'Kamichama Karin', '桃园奈奈生': 'Kamichama Karin', '巴卫': 'Kamichama Karin',
  '邻座的怪同学': 'Tonari no Kaibutsu-kun', '好想告诉你': 'Kimi ni Todoke', '爽子': 'Kimi ni Todoke',
  '交响情人梦': 'Nodame Cantabile', '野田妹': 'Nodame Cantabile', '千秋': 'Nodame Cantabile',
  '蜂蜜与四叶草': 'Honey and Clover', 'honey': 'Honey and Clover', '竹本': 'Honey and Clover',
  '穿越时空的少女': 'Toki wo Kakeru Shoujo', '秒速五厘米': '5cm per Second', '秒五': '5cm per Second',
  '叶绿体': 'Ryouhei', '言叶之庭': 'Koto no Ha no Niwa', '追逐繁星的孩子': 'Hoshi wo Ou Kodomo',
  '声之形': 'Koe no Katachi', '将也': 'Koe no Katachi', '西宫硝子': 'Koe no Katachi',
  '心灵奇旅': 'Soul', '天气之子': 'Tenki no Ko', '帆高': 'Tenki no Ko', '阳菜': 'Tenki no Ko',
  '铃芽户缔': 'Suzume', '铃芽之户': 'Suzume', '草太': 'Suzume',
  '灌篮高手': 'Slam Dunk', '樱木花道': 'Slam Dunk', '流川枫': 'Slam Dunk', '赤木': 'Slam Dunk',
  '排球少年': 'Haikyuu', '日向翔阳': 'Haikyuu', '影山飞雄': 'Haikyuu', '乌野': 'Haikyuu',
  '网球王子': 'Prince of Tennis', '越前龙马': 'Prince of Tennis', '迹部': 'Prince of Tennis',
  'free男子游泳部': 'Free', '男子游泳部': 'Free', '凛': 'Free', '遥': 'Free',
  '强风吹拂': 'Kaze ga Tsuyoku Fuiteiru', '藏原走': 'Kaze ga Tsuyoku Fuiteiru', '清濑灰二': 'Kaze ga Tsuyoku Fuiteiru',
  '蓝色监狱': 'Blue Lock', '洁世一': 'Blue Lock', '蜂乐回': 'Blue Lock',
  '黑色五叶草': 'Black Clover', '黑色四叶草': 'Black Clover', '黑草': 'Black Clover', '阿斯塔': 'Black Clover', '尤诺': 'Black Clover',
  '七大罪': 'Nanatsu no Taizai', '梅利奥达斯': 'Nanatsu no Taizai', '伊丽莎白': 'Nanatsu no Taizai',
  '妖精的尾巴': 'Fairy Tail', '纳兹': 'Fairy Tail', '露西': 'Fairy Tail', '哈比': 'Fairy Tail',
  '钢之炼金术师': 'Fullmetal Alchemist', '钢炼': 'Fullmetal Alchemist', '爱德华': 'Fullmetal Alchemist', '阿尔': 'Fullmetal Alchemist',
  '无职转生': 'Mushoku Tensei', '鲁迪': 'Mushoku Tensei', '洛琪希': 'Mushoku Tensei', '艾莉丝': 'Mushoku Tensei',
  'Re从零开始': 'Re:Zero', 're0': 'Re:Zero', '昴': 'Re:Zero', '爱蜜莉雅': 'Re:Zero', '雷姆': 'Re:Zero', '蕾姆': 'Re:Zero',
  '从零开始的异世界生活': 'Re:Zero', '罗兹瓦尔': 'Re:Zero', '碧翠丝': 'Re:Zero',
  '为美好的世界献上祝福': 'KonoSuba', '素晴': 'KonoSuba', '和真': 'KonoSuba', '阿库娅': 'KonoSuba', '惠惠': 'KonoSuba', '达克妮丝': 'KonoSuba',
  'OVERLORD': 'Overlord', '骨王': 'Overlord', '安兹': 'Overlord', '雅儿贝德': 'Overlord',
  '哥布林杀手': 'Goblin Slayer', '哥杀': 'Goblin Slayer', '女神官': 'Goblin Slayer',
  '剑风传奇': 'Berserk', '烙印勇士': 'Berserk', '格斯': 'Berserk', '格里菲斯': 'Berserk',
  '浪客剑心': 'Rurouni Kenshin', '剑心': 'Rurouni Kenshin', '薰': 'Rurouni Kenshin',
  '名侦探柯南': 'Detective Conan', '柯南': 'Detective Conan', '工藤新一': 'Detective Conan', '毛利小五郎': 'Detective Conan',
  '金田一': 'Kindaichi', '少年侦探团': 'Detective Conan', '怪盗基德': 'Detective Conan',
  '哆啦A梦': 'Doraemon', '机器猫': 'Doraemon', '叮当猫': 'Doraemon', '大雄': 'Doraemon',
  '蜡笔小新': 'Crayon Shin-chan', '野原新之助': 'Crayon Shin-chan', '小新': 'Crayon Shin-chan',
  '樱桃小丸子': 'Chibi Maruko-chan', '小丸子': 'Chibi Maruko-chan',
  '龙珠': 'Dragon Ball', '七龙珠': 'Dragon Ball', '悟空': 'Dragon Ball', '贝吉塔': 'Dragon Ball', '龟仙人': 'Dragon Ball',
  '一拳超人': 'One-Punch Man', '饿狼': 'One-Punch Man', '埼玉': 'One-Punch Man',
  '间谍过家家': 'SPY×FAMILY', '间谍家家酒': 'SPY×FAMILY', '黄昏': 'SPY×FAMILY', '阿尼亚': 'SPY×FAMILY', '约尔': 'SPY×FAMILY',
  '电锯人': 'Chainsaw Man', '帕瓦': 'Chainsaw Man', '早川秋': 'Chainsaw Man', '玛奇玛': 'Chainsaw Man',
  '胆大党': 'Dandadan', '超自然武装': 'Dandadan', '当哒当': 'Dandadan', '绫濑桃': 'Dandadan', '厄卡伦': 'Dandadan',
  '迷宫饭': 'Dungeon Meshi', '迷宮飯': 'Dungeon Meshi', '玛露希尔': 'Dungeon Meshi', '莱欧斯': 'Dungeon Meshi',
  '药屋少女的呢喃': 'Kusuriya no Hitorigoto', '猫猫': 'Kusuriya no Hitorigoto', '壬氏': 'Kusuriya no Hitorigoto', '药师少女': 'Kusuriya no Hitorigoto',
  '葬送的芙莉莲': 'Sousou no Frieren', '芙莉莲': 'Sousou no Frieren', '菲伦': 'Sousou no Frieren', '休塔尔克': 'Sousou no Frieren',
  '坂本大佬': 'Sakamoto Days', '坂本': 'Sakamoto Days', '坂本辰马': 'Sakamoto Days',
  '蓝色时期': 'Blue Period', '蓝青': 'Blue Period', '矢口八虎': 'Blue Period',
  '跃动青春': 'Skip and Loafer', '跳水男孩': 'Skip and Loafer',
  '葬送的芙莉莲': 'Sousou no Frieren',
  '我推的孩子': 'Oshi no Ko', '爱豆': 'Oshi no Ko', '星野爱': 'Oshi no Ko', '阿库亚': 'Oshi no Ko', '露比': 'Oshi no Ko',
  '【我推的孩子】': 'Oshi no Ko', '推子': 'Oshi no Ko',
  '咒术回战': 'Jujutsu Kaisen', '宿傩': 'Jujutsu Kaisen', '伏黑惠': 'Jujutsu Kaisen', '钉崎野蔷薇': 'Jujutsu Kaisen',
  '鬼灭之刃': 'Kimetsu no Yaiba', '善逸': 'Kimetsu no Yaiba', '伊之助': 'Kimetsu no Yaiba', '义勇': 'Kimetsu no Yaiba',
  '海贼王': 'ONE PIECE', '罗': 'ONE PIECE', '山治': 'ONE PIECE', '乔巴': 'ONE PIECE', '罗宾': 'ONE PIECE', '弗兰奇': 'ONE PIECE',
  '进击的巨人': 'Shingeki no Kyojin', '利威尔': 'Shingeki no Kyojin', '兵长': 'Shingeki no Kyojin', '阿尔敏': 'Shingeki no Kyojin',
};
function expandQuery(q) {
  const key = String(q || '').trim();
  if (ZH_ALIAS[key]) return ZH_ALIAS[key];
  // 容错：查询里包含某个中文别名（如"黑色四叶草 漫画"）时，替换为别名对应的罗马音并保留其余词
  if (/[\u4e00-\u9fff]/.test(key)) {
    let best = '';
    for (const alias of Object.keys(ZH_ALIAS)) {
      if (key.includes(alias) && alias.length > best.length) best = alias;
    }
    if (best) return key.replace(best, ZH_ALIAS[best]);
  }
  return key;
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
  const rawTags = (m.genres || []).concat((m.tags || []).filter((t) => !t.isMediaSpoiler).map((t) => t.name));
  const tags = [...new Set(rawTags)].slice(0, 24);
  const studios = ((m.studios?.nodes) || []).map((s) => ({ name: s.name, siteUrl: s.siteUrl || '' }));
  const rankings = (m.rankings || []).slice(0, 6).map((r) => ({ rank: r.rank, context: r.context, year: r.year || null }));
  const id = `anilist:${m.id}`;
  const cached = getI18n(id);                         // GLM 翻译缓存（标题/简介）
  const zhFromAlias = pickChineseTitle(title, synonyms);
  const format = String(m.format || '');
  const status = String(m.status || '');
  const origin = String(m.source || '');
  const country = m.countryOfOrigin || '';
  const desc = stripHtml(m.description);

  return {
    id,
    source: 'AniList',
    sourceUrl: m.siteUrl || `https://anilist.co/${String(m.type || '').toLowerCase()}/${m.id}`,
    // 多语言标题：title 仍是默认显示名（原生优先），另给完整集合供前端切换
    title: title.native || title.romaji || title.english || '',
    titles: {
      native: title.native || '',
      romaji: title.romaji || '',
      english: title.english || '',
      chinese: cached?.title || zhFromAlias || '',
    },
    nativeTitle: title.native || '',
    englishTitle: title.english || '',
    chineseTitle: cached?.title || zhFromAlias || '',
    synonyms,
    cover: cover.extraLarge || cover.large || cover.medium || '',
    banner: m.bannerImage || '',
    color: cover.color || '',
    description: cached?.desc || desc,
    descriptionOriginal: cached?.desc ? desc : undefined,
    translated: !!(cached?.title || cached?.desc),
    kind: String(m.type || '').toLowerCase(),          // manga / anime
    category: categoryOf(m.format, m.type),            // manga/novel/anime/movie/music
    format,
    formatZh: FORMAT_ZH[format] || format,
    status,
    statusZh: STATUS_ZH[status] || status,
    year: m.seasonYear || (m.startDate && m.startDate.year) || null,
    score: m.averageScore != null ? Number(m.averageScore) / 10 : null, // 0-10
    meanScore: m.meanScore != null ? Number(m.meanScore) / 10 : null,
    popularity: m.popularity || 0,
    favourites: m.favourites || 0,
    episodes: m.episodes || null,
    chapters: m.chapters || null,
    volumes: m.volumes || null,
    duration: m.duration || null,
    country,
    countryZh: COUNTRY_ZH[country] || country,
    origin,                                           // 原作来源：MANGA / LIGHT_NOVEL / NOVEL ...
    originZh: ORIGIN_ZH[origin] || origin,
    licensed: !!m.isLicensed,                         // 是否有正版授权
    studios,                                          // 制作公司
    rankings,                                         // 排名（如"highest rated"）
    tags: cached?.tags?.length ? cached.tags : localizedTags(tags),
    tagsOriginal: tags,
    links,
    streamingEpisodes: [],                            // 仅详情填充
    relations: [],
  };
}

export function registerUniversalSearch(app) {
  const router = express.Router();

  // 品类清单
  router.get('/categories', (_req, res) => res.json({ categories: UNI_CATEGORIES, source: '聚合公开元数据库' }));

  /* 批量中文本地化：前端把未翻译的条目一次性送来，用 GLM 翻译标题/简介/标签后落盘缓存。
     只在用户主动搜索/打开详情时触发，已缓存条目直接跳过，避免重复消耗 token。 */
  router.post('/localize', async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 12) : [];
      const out = {};
      const pending = items.filter((it) => it && it.id && !getI18n(it.id));
      // 先返回已缓存的
      for (const it of items) {
        const c = it?.id ? getI18n(it.id) : null;
        if (c) out[it.id] = { title: c.title || '', desc: c.desc || '', tags: c.tags || [] };
      }
      if (!pending.length) return res.json({ localized: out, source: 'cache' });
      // 一次 GLM 调用批量翻译全部待翻条目（最多 8 条），结果逐条落盘缓存
      const batch = pending.slice(0, 8);
      const zhMap = await glmTranslateBatch(batch.map((it) => ({
        id: it.id, title: it.title || '', desc: it.desc || '', tags: (it.tags || []).slice(0, 8),
      })));
      for (const [id, zh] of Object.entries(zhMap)) {
        if (zh && (zh.title || zh.desc)) { putI18n(id, zh); out[id] = zh; }
      }
      res.json({ localized: out, source: 'glm' });
    } catch (err) {
      res.status(502).json({ error: err?.message || '本地化失败' });
    }
  });

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
      // 详情按需中文化：无缓存时翻译标题/简介/标签并落盘（一次性，后续命中缓存）
      if (!getI18n(id)) {
        const zh = await glmTranslate({
          title: media.title?.native || media.title?.romaji || '',
          desc: item.descriptionOriginal || item.description || '',
          tags: (item.tagsOriginal || item.tags || []).slice(0, 10),
        });
        if (zh) {
          putI18n(id, zh);
          if (zh.title) { item.chineseTitle = zh.title; item.titles.chinese = zh.title; }
          if (zh.desc) { item.descriptionOriginal = item.description; item.description = zh.desc; }
          if (zh.tags?.length) item.tags = zh.tags;
          item.translated = true;
        }
      }
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
