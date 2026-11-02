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
  createdAt: number;
}

export interface PlazaComment {
  id: string;
  by: string;
  byName: string;
  content: string;
  at: number;
}

export interface PlazaPost {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  comic: { id: string; title: string; coverUrl: string | null; chapterCount: number } | null;
  shareUrl: string | null;
  likes: string[];
  comments: PlazaComment[];
  createdAt: number;
}

export interface CommunityComic extends ComicSummary {
  ownerName: string;
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
}

export interface Comic extends ComicSummary {
  chapters: Chapter[];
}

/** 阅读器滤镜预设 */
export type ReaderFilter = 'none' | 'warm' | 'invert' | 'gray';

export interface ReaderPrefs {
  mode: 'single' | 'double' | 'continuous';
  fit: 'contain' | 'width' | 'height' | 'original';
  direction: 'ltr' | 'rtl';
  filter: ReaderFilter;
  brightness: number;
  contrast: number;
  smartDouble: boolean;
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
