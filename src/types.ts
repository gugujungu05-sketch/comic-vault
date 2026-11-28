export interface Page {
  id: string;
  file: string;
  width: number;
  height: number;
  size?: number;
  hasThumb?: boolean;
  url?: string;
  thumbUrl?: string | null;
  name?: string;
  /** 宽 > 高，判定为跨页大图，双页模式下应独占一屏 */
  wide?: boolean;
  splitFrom?: string;
}

export interface Chapter {
  id: string;
  title: string;
  number: number | null;
  pages: Page[];
  /** 小说章节：服务端正文文件名，通过 /api/novel/:comicId/:chapterId 按需读取 */
  textFile?: string;
  createdAt?: number;
  uploadedBy?: string | null;
  uploadedByName?: string;
}

export interface ShareInfo {
  enabled: boolean;
  token: string | null;
  allowDownload: boolean;
  expiresAt: number | null;
  hasPassword: boolean;
  views: number;
  /** 为空表示分享整本，否则只分享这些章节 */
  chapterIds?: string[];
  logCount?: number;
}

export interface ShareLog {
  ts: number;
  event: string;
  ip: string;
  ua: string;
  /** 同一访客合并成一条记录：累计访问次数与最近阅读位置 */
  visitorId?: string;
  visits?: number;
  position?: string;
  chapterTitle?: string;
}

/** 协作条目：别名 / 标签 / 封面，都记录添加者，只有本人能删 */
export interface MetaEntry {
  id: string;
  value?: string;
  url?: string;
  type?: 'page' | 'file';
  by: string;
  byName: string;
  at: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  bio: string;
  avatar: string;
  isAdmin: boolean;
  /** 单独授予的公告发布权限（站点公告账号） */
  canAnnounce: boolean;
  /** 是否已完成邮箱验证；验证后该邮箱可用于找回密码 */
  emailVerified: boolean;
  createdAt: number;
}

export interface PlazaComment {
  id: string;
  by: string;
  byName: string;
  content: string;
  at: number;
}

/** 广场分区（服务端预设，count 由接口实时统计） */
export interface PlazaBoard {
  id: string;
  name: string;
  icon: string;
  desc: string;
  count: number;
}

export type PlazaAttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** 帖子附件：图片 / 视频 / 音频 / 普通文件 */
export interface PlazaAttachment {
  id: string;
  kind: PlazaAttachmentKind;
  name: string;
  url: string;
  size: number;
  mime: string;
}

/** 用户自定义图片表情包 */
export interface Sticker {
  id: string;
  name: string;
  tags: string[];
  url: string;
  /** 仅文件名，用于在正文中写成 [emoji:xxx] 标记 */
  file: string;
  by: string;
  byName: string;
  at: number;
}

export interface PlazaPost {
  id: string;
  authorId: string;
  authorName: string;
  board: string;
  content: string;
  attachments: PlazaAttachment[];
  comic: { id: string; title: string; coverUrl: string | null; chapterCount: number } | null;
  shareUrl: string | null;
  /** 可见方式：public 所有人可见 / password 凭密码解锁 */
  visibility?: 'public' | 'password';
  locked?: boolean;
  likes: string[];
  comments: PlazaComment[];
  createdAt: number;
}

export interface CommunityComic extends ComicSummary {
  ownerName: string;
  category: string;
  views: number;
  downloads: number;
  likes: number;
  likedBy: string[];
  sample: boolean;
  license: string | null;
  sourceUrl: string | null;
  aliases: MetaEntry[];
  tagEntries: MetaEntry[];
  covers: MetaEntry[];
  activeCoverId: string | null;
  activeAliasId: string | null;
  chapters: {
    id: string;
    title: string;
    number: number | null;
    pageCount: number;
    uploadedBy: string | null;
    uploadedByName: string;
  }[];
}

export interface ComicSummary {
  id: string;
  /** novel = 文字小说（章节正文按需加载），comic/缺省 = 图片漫画 */
  kind?: 'comic' | 'novel';
  title: string;
  author: string;
  artist: string;
  description: string;
  tags: string[];
  status: 'ongoing' | 'completed' | 'hiatus';
  direction: 'ltr' | 'rtl';
  language: string;
  favorite: boolean;
  chapterCount: number;
  pageCount: number;
  coverUrl: string | null;
  coverChapterId: string | null;
  coverPageId: string | null;
  progress: { chapterId: string; pageIndex: number; updatedAt: number } | null;
  share: ShareInfo;
  createdAt: number;
  updatedAt: number;
  /* 导入 ComicInfo.xml 时保留的扩展元数据 */
  publisher?: string;
  year?: number | null;
  rating?: number | null;
  ageRating?: string;
  comicInfo?: Record<string, string> | null;
  /* ---- 多用户 / 社区字段 ---- */
  baseTitle?: string;
  scope?: 'personal' | 'community';
  visibility?: 'private' | 'public';
  allowDownload?: boolean;
  ownerId?: string | null;
  ownerName?: string;
  createdBy?: string | null;
  aliases?: MetaEntry[];
  tagEntries?: MetaEntry[];
  covers?: MetaEntry[];
  activeCoverId?: string | null;
  activeAliasId?: string | null;
  /* ---- 分类 / 排行 ---- */
  category?: string;
  views?: number;
  downloads?: number;
  likes?: number;
  lastActivityAt?: number;
}

export interface Comic extends ComicSummary {
  chapters: Chapter[];
}

/** 阅读器滤镜预设 */
export type ReaderFilter = 'none' | 'warm' | 'invert' | 'gray';

export interface ReaderPrefs {
  mode: 'single' | 'double' | 'continuous' | 'webtoon';
  fit: 'contain' | 'width' | 'height' | 'original';
  direction: 'ltr' | 'rtl';
  filter: ReaderFilter;
  brightness: number;
  contrast: number;
  smartDouble: boolean;
  /** 双页对开(翻页模式)下是否保持单页自然顺序 1→2→3，不受 LTR/RTL 方向镜像影响 */
  keepPageOrder?: boolean;
  /** 滚动模式（上下滚动/条漫）下每行的并排页数：1 单列 / 2 双页 / 3 三页 / 4 四页 */
  scrollCols?: number;
  /** 兼容旧键：滚动双页。读取时映射为 scrollCols=2 */
  scrollDouble?: boolean;
  /** 滚动模式下隐藏被标记为跨页的大图（旧行为，保留兼容；新界面改用 splitWide） */
  hideWide?: boolean;
  /** 观看时把合并的跨页大图拆成左右两张单页显示（可逆，不改原图） */
  splitWide?: boolean;
  /** 连续跨章：翻到本章末自动进入下一章，跨章不中断 */
  linkChapters?: boolean;
}

export interface TranslateConfig {
  provider: 'gemini' | 'openai' | 'custom' | 'google';
  apiKey: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  /** 谷歌免费后端用的视觉识别模型（只识别文字框，翻译走谷歌免费接口） */
  detectorModel?: string;
  targetLang: string;
  fontFamily: string;
  fontSizeOffset: number;
  inkColor: string;
  useOutline: boolean;
  /** 译文样式跟随原文（颜色/粗细），默认开启；关闭则用上面的固定字号与颜色 */
  autoStyle: boolean;
  defaults: Record<'gemini' | 'openai' | 'custom' | 'google', { baseUrl: string; model: string }>;
}

export interface TranslateResult {
  url: string;
  count: number;
  cached: boolean;
}

/** 全品类聚合检索结果（多语言 + 正版信息） */
export interface UniversalMedia {
  id: string;
  source: string;
  sourceUrl: string;
  title: string;
  /** 多语言标题集合，供「优先显示语言」切换 */
  titles?: { native: string; romaji: string; english: string; chinese: string };
  nativeTitle: string;
  englishTitle: string;
  chineseTitle?: string;
  synonyms: string[];
  cover: string;
  banner: string;
  color: string;
  description: string;
  kind: string;          // manga / anime / game / music
  category?: string;     // manga / novel / anime / movie / game / music
  format: string;        // TV / MOVIE / MANGA / NOVEL / ONA ...
  status: string;
  year: number | null;
  score: number | null;  // 0-10
  meanScore?: number | null;
  popularity: number;
  favourites?: number;
  episodes: number | null;
  chapters: number | null;
  volumes: number | null;
  duration?: number | null;
  country?: string;
  origin?: string;       // 原作来源：MANGA / LIGHT_NOVEL ...
  licensed?: boolean;    // 是否有正版授权
  studios?: { name: string; siteUrl: string }[];
  rankings?: { rank: number; context: string; year: number | null }[];
  tags: string[];
  links: { site: string; rawSite?: string; url: string; type: 'watch' | 'official' | 'social' | 'info'; language?: string; color?: string }[];
  streamingEpisodes?: { site: string; title: string; url: string; thumbnail: string }[];
  relations?: { relation: string; id: string; title: string; cover: string; format?: string; kind: string; sourceUrl: string }[];
  characters?: { name: string; nativeName?: string; image: string; sourceUrl: string }[];
  staff?: { name: string; image: string; sourceUrl: string }[];
}

/** 检索首页多榜单分区 */
export interface UniTrendSection {
  key: string;
  label: string;
  results: UniversalMedia[];
}

export interface Settings {
  defaultDirection: 'ltr' | 'rtl';
  theme: 'dark' | 'light';
}

export interface Stats {
  comicCount: number;
  chapterCount: number;
  pageCount: number;
  storageBytes: number;
  storageFiles: number;
  hasSharp: boolean;
  archiveEngine?: { available: boolean; formats?: string[]; error?: string };
}

/* ------------------------------ 发现 / 排行 / 动态 / 公告 / 软件 ------------------------------ */

export interface Category {
  id: string;
  name: string;
  icon: string;
  count: number;
}

export interface RankingItem {
  id: string;
  title: string;
  coverUrl: string | null;
  author: string;
  category: string;
  views: number;
  likes: number;
  downloads: number;
  chapterCount: number;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  sample: boolean;
  rank: number;
  score: number;
}

export interface UploadRecord {
  id: string;
  at: number;
  comicId: string | null;
  comicTitle: string;
  chapterId: string | null;
  chapterTitle: string;
  userId: string | null;
  userName: string;
  kind: 'comic' | 'chapter' | 'pages';
  count: number;
}

export interface ActivityItem {
  id: string;
  type: string;
  at: number;
  text: string;
  link: string;
  icon: string;
  userName: string;
  count: number;
}

export interface AnnouncementComment {
  id: string;
  by: string;
  byName: string;
  text: string;
  at: number;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  by: string;
  byName: string;
  at: number;
  pinned: boolean;
  editedAt?: number;
  comments?: AnnouncementComment[];
}

export interface SoftwareItem {
  id: string;
  platform: string;
  icon: string;
  name: string;
  file: string;
  size: string;
  desc: string;
  url: string;
  primary?: boolean;
  /** 发版脚本算出的真实体积（字节） */
  sizeBytes?: number | null;
  /** 发版脚本算出的 SHA256 */
  sha256?: string | null;
  /** 是否由本站 /files/ 直接提供（而非跳转资料库） */
  local?: boolean;
  /** 该成品文件的更新时间 */
  updatedAt?: number | null;
}

export interface SoftwareInfo {
  /** 安装包版本（四段式） */
  version: string;
  /** 网站版本（与客户端独立演进） */
  webVersion?: string;
  versions?: { web: string; desktop: string; android: string };
  /** Electron 打包用的三段构建号 */
  buildVersion?: string;
  /** 发版序号 */
  build?: number;
  releasedAt?: number | null;
  /** 是否已接入发版脚本（清单随文件热更新） */
  autoUpdated?: boolean;
  versionRule?: Record<string, string> | null;
  software: SoftwareItem[];
  notes: string[];
  driveUrl: string;
  sitePath: string;
}

export interface UpdateInfo {
  channel: string;
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes: string[];
  downloadUrl: string;
  apkUrl: string;
  releasedAt: number | null;
  alwaysLatest: boolean;
  hint: string;
}

/** 合规批量导入：用户粘贴清单并确认拥有合法授权 */
export interface ImportComicItem {
  title: string;
  author?: string;
  description?: string;
  category?: string;
  tags?: string[];
  sourceUrl?: string;
  chapters?: { title?: string; pages?: string[] }[];
}

export interface ImportResult {
  ok: boolean;
  created: { id: string; title: string; chapters: number; pages: number }[];
  importedImages: number;
  errors: string[];
}

