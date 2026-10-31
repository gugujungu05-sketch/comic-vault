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
}

export interface Comic extends ComicSummary {
  chapters: Chapter[];
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
}
