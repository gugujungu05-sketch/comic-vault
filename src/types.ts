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
