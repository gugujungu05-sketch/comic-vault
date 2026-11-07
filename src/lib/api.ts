import type {
  ActivityItem, Announcement, Category, Chapter, Comic, ComicSummary, CommunityComic,
  ImportComicItem, ImportResult, MetaEntry, PlazaAttachment, PlazaBoard, PlazaPost,
  RankingItem, Settings, ShareLog, SoftwareInfo, Stats, Sticker, UpdateInfo,
  UploadRecord, User,
} from '../types';
import { getShareCode, withShareCode } from './util';

/**
 * 托管环境下，接口返回的资源地址（封面、页面图、缩略图）会直接用于 <img src>，
 * 浏览器不会自动带上凭据。这里在前端统一补上，确保图片一定加载得出来。
 */
function injectCode<T>(value: T, code: string | null, depth = 0): T {
  if (!code || depth > 12 || value == null) return value;
  if (typeof value === 'string') {
    if (!value.startsWith('/api/') || value.includes('sharecode=')) return value;
    return `${value}${value.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(code)}` as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => injectCode(v, code, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[k] = injectCode(
        (value as Record<string, unknown>)[k],
        code,
        depth + 1,
      );
    }
    return value;
  }
  return value;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { error?: string })?.error || res.statusText || '请求失败';
    throw new Error(message);
  }
  return injectCode(data as T, getShareCode());
}

export const api = {
  list: () => request<{ comics: ComicSummary[]; settings: Settings }>('/api/comics'),

  create: (body: Partial<Comic>) =>
    request<Comic>('/api/comics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  get: (id: string) => request<Comic>(`/api/comics/${id}`),

  update: (id: string, body: Partial<Comic>) =>
    request<ComicSummary>(`/api/comics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  remove: (id: string) => request<{ ok: boolean }>(`/api/comics/${id}`, { method: 'DELETE' }),

  duplicate: (id: string) => request<ComicSummary>(`/api/comics/${id}/duplicate`, { method: 'POST' }),

  addChapter: (id: string, body: { title: string; number?: number; index?: number }) =>
    request<Chapter[]>(`/api/comics/${id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  updateChapter: (comicId: string, chapterId: string, body: { title?: string; number?: number }) =>
    request<Chapter[]>(`/api/comics/${comicId}/chapters/${chapterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  deleteChapter: (comicId: string, chapterId: string) =>
    request<Chapter[]>(`/api/comics/${comicId}/chapters/${chapterId}`, { method: 'DELETE' }),

  reorderChapters: (comicId: string, order: string[]) =>
    request<Chapter[]>(`/api/comics/${comicId}/chapters/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    }),

  uploadPages: (
    comicId: string,
    chapterId: string,
    files: { name: string; blob: Blob }[],
    index?: number,
    onProgress?: (done: number, total: number) => void,
  ) => {
    const BATCH = 12;
    let last: Chapter = { id: chapterId, title: '', number: 0, pages: [] };
    return (async () => {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const form = new FormData();
        for (const f of batch) form.append('files', f.blob, f.name);
        if (typeof index === 'number') form.append('index', String(index + i));
        const result = await request<{ chapter: Chapter; added: number }>(
          `/api/comics/${comicId}/chapters/${chapterId}/pages`,
          { method: 'POST', body: form },
        );
        last = result.chapter;
        onProgress?.(Math.min(i + BATCH, files.length), files.length);
      }
      return last;
    })();
  },

  deletePage: (comicId: string, chapterId: string, pageId: string) =>
    request<{ ok: boolean }>(`/api/comics/${comicId}/chapters/${chapterId}/pages/${pageId}`, {
      method: 'DELETE',
    }),

  reorderPages: (comicId: string, chapterId: string, order: string[]) =>
    request<{ ok: boolean }>(`/api/comics/${comicId}/chapters/${chapterId}/pages/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    }),

  movePages: (comicId: string, chapterId: string, pageIds: string[], targetChapterId: string) =>
    request<{ ok: boolean; moved: number }>(`/api/comics/${comicId}/chapters/${chapterId}/pages/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageIds, targetChapterId }),
    }),

  uploadCover: async (comicId: string, blob: Blob, name = 'cover.jpg') => {
    const form = new FormData();
    form.append('file', blob, name);
    return request<{ ok: boolean; coverUrl: string }>(`/api/comics/${comicId}/cover`, {
      method: 'POST',
      body: form,
    });
  },

  setCoverPage: (comicId: string, chapterId: string, pageId: string) =>
    request<{ ok: boolean }>(`/api/comics/${comicId}/cover/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterId, pageId }),
    }),

  setProgress: (comicId: string, chapterId: string, pageIndex: number) =>
    request<{ ok: boolean }>(`/api/comics/${comicId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterId, pageIndex }),
    }),

  setShare: (
    comicId: string,
    body: {
      enabled?: boolean;
      password?: string;
      expiresInDays?: number;
      allowDownload?: boolean;
      chapterIds?: string[];
    },
  ) =>
    request<ComicSummary['share']>(`/api/comics/${comicId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** 吊销：换一个新 token，旧链接立即失效 */
  rotateShare: (comicId: string) =>
    request<ComicSummary['share']>(`/api/comics/${comicId}/share/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),

  shareLogs: (comicId: string) => request<{ logs: ShareLog[] }>(`/api/comics/${comicId}/share/logs`),

  clearShareLogs: (comicId: string) =>
    request<{ ok: boolean }>(`/api/comics/${comicId}/share/logs`, { method: 'DELETE' }),

  /* ---------- 页面编辑 ---------- */

  editPage: (
    comicId: string,
    chapterId: string,
    pageId: string,
    body: { rotate?: number; crop?: { x: number; y: number; w: number; h: number } | null; scope?: 'page' | 'chapter' | 'comic' },
  ) =>
    request<{ ok: boolean; updated: number; chapter: Chapter }>(
      `/api/comics/${comicId}/chapters/${chapterId}/pages/${pageId}/edit`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ),

  splitPages: (comicId: string, chapterId: string, body: { pageIds?: string[]; rtl?: boolean; minRatio?: number }) =>
    request<{ ok: boolean; split: number; chapter: Chapter }>(
      `/api/comics/${comicId}/chapters/${chapterId}/pages/split`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ),

  mergePages: (comicId: string, chapterId: string, body: { pageIds: string[]; rtl?: boolean }) =>
    request<{ ok: boolean; merged: number; chapter: Chapter }>(
      `/api/comics/${comicId}/chapters/${chapterId}/pages/merge`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ),

  /* ---------- RAR / 7z 压缩包导入（服务端解压） ---------- */

  importArchive: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{
      sessionId: string;
      files: { path: string; name: string; size: number }[];
      meta: Record<string, string> | null;
      fields: {
        title?: string;
        author?: string;
        artist?: string;
        description?: string;
        tags?: string[];
        language?: string;
        direction?: 'ltr' | 'rtl';
        publisher?: string;
        year?: number;
        rating?: number;
        ageRating?: string;
      };
    }>('/api/import/archive', { method: 'POST', body: form });
  },

  commitArchive: (
    sessionId: string,
    body: {
      groups: { title: string; paths: string[] }[];
      comicId?: string;
      title?: string;
      author?: string;
      artist?: string;
      description?: string;
      tags?: string[];
      direction?: 'ltr' | 'rtl';
      language?: string;
      publisher?: string;
      year?: number | null;
      rating?: number | null;
      ageRating?: string;
      comicInfo?: Record<string, string> | null;
    },
  ) =>
    request<{ comic: ComicSummary; chapters: { id: string; title: string; pageCount: number }[] }>(
      `/api/import/archive/${sessionId}/commit`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ),

  getShared: (token: string, password?: string) =>
    request<PublicComic>(`/api/share/${token}`, {
      headers: password ? { 'x-share-password': password } : undefined,
    }),

  unlockShare: (token: string, password: string) =>
    request<{ ok: boolean }>(`/api/share/${token}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  importFolder: (body: { dir: string; mode?: 'folder' | 'flat'; pagesPerChapter?: number; comicId?: string; title?: string }) =>
    request<{ comic: ComicSummary; chapters: { id: string; title: string; pageCount: number }[] }>(
      '/api/import/folder',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),

  stats: () => request<Stats>('/api/stats'),

  /** 当前连接的服务器信息：网页、安装应用、桌面软件共用同一数据源 */
  runtime: () =>
    request<{
      app: string;
      version: string;
      features: { pwa: boolean; desktop: boolean; community: boolean; share: boolean };
    }>('/api/runtime'),

  saveSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

/** 账号 / 社区 / 广场接口 */
export const social = {
  status: () =>
    request<{
      user: User | null;
      needsSetup: boolean;
      hasUsers: number;
      codeLogin: { emailEnabled: boolean; devMode: boolean; channel?: string; recoveryEnabled?: boolean };
    }>('/api/auth/status'),

  register: (body: { email: string; password: string; name?: string }) =>
    request<{ user: User; first: boolean }>('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  login: (body: { email: string; password: string }) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  sendCode: (email: string) =>
    request<{ ok: boolean; sent: boolean; devCode: string | null; hint: string; channel?: string }>('/api/auth/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    }),

  loginCode: (email: string, code: string) =>
    request<{ user: User; created: boolean }>('/api/auth/login-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }),
    }),

  /** 注册后可稍后补做的邮箱验证 */
  sendVerifyCode: () =>
    request<{ ok: boolean; sent: boolean; devCode: string | null; hint: string }>(
      '/api/auth/email/send-code', { method: 'POST' },
    ),

  verifyEmail: (code: string) =>
    request<{ ok: boolean; user: User }>('/api/auth/email/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    }),

  /** 仅已验证邮箱 + 已配置真实发信时可用 */
  forgotSend: (email: string) =>
    request<{ ok: boolean; sent?: boolean; hint: string }>('/api/auth/forgot/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    }),

  forgotReset: (body: { email: string; code: string; password: string }) =>
    request<{ ok: boolean; hint: string }>('/api/auth/forgot/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User; comics: ComicSummary[]; postCount: number }>('/api/me'),

  updateMe: (body: { name?: string; bio?: string; avatar?: string; password?: string }) =>
    request<{ user: User }>('/api/me', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  uploadAvatar: (file: Blob, name = 'avatar.png') => {
    const form = new FormData();
    form.append('file', file, name);
    return request<{ ok: boolean; url: string }>('/api/me/avatar', { method: 'POST', body: form });
  },

  userPage: (id: string) =>
    request<{ user: User; comics: ComicSummary[]; posts: PlazaPost[] }>(`/api/users/${id}`),

  community: (params: { q?: string; category?: string; sort?: string } = {}) => {
    const p = new URLSearchParams();
    if (params.q?.trim()) p.set('q', params.q.trim());
    if (params.category && params.category !== 'all') p.set('category', params.category);
    if (params.sort && params.sort !== 'updated') p.set('sort', params.sort);
    const qs = p.toString();
    return request<{ comics: CommunityComic[]; category: string; sort: string; query: string }>(
      `/api/community/comics${qs ? `?${qs}` : ''}`,
    );
  },

  addAlias: (id: string, value: string) =>
    request<{ entries: MetaEntry[]; id: string }>(`/api/comics/${id}/aliases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    }),

  addTag: (id: string, value: string) =>
    request<{ entries: MetaEntry[]; id: string }>(`/api/comics/${id}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    }),

  addCoverPage: (id: string, chapterId: string, pageId: string) =>
    request<{ entries: MetaEntry[]; id: string }>(`/api/comics/${id}/covers/page`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterId, pageId }),
    }),

  addCoverFile: (id: string, file: Blob, name = 'cover.jpg') => {
    const form = new FormData();
    form.append('file', file, name);
    return request<{ entries: MetaEntry[]; id: string }>(`/api/comics/${id}/covers/upload`, {
      method: 'POST', body: form,
    });
  },

  activateCover: (id: string, coverId: string) =>
    request<{ ok: boolean }>(`/api/comics/${id}/covers/${coverId}/activate`, { method: 'POST' }),

  activateAlias: (id: string, aliasId: string) =>
    request<{ ok: boolean }>(`/api/comics/${id}/aliases/${aliasId}/activate`, { method: 'POST' }),

  deleteEntry: (id: string, kind: 'aliases' | 'tags' | 'covers', entryId: string) =>
    request<{ entries: MetaEntry[] }>(`/api/comics/${id}/${kind}/${entryId}`, { method: 'DELETE' }),

  boards: () => request<{ boards: PlazaBoard[] }>('/api/plaza/boards'),

  posts: (board = 'all', q = '') =>
    request<{ posts: PlazaPost[]; boards: PlazaBoard[]; board: string; query: string; count: number }>(
      `/api/plaza/posts?board=${encodeURIComponent(board)}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),

  createPost: (body: {
    content: string;
    comicId?: string;
    shareUrl?: string;
    board?: string;
    attachments?: PlazaAttachment[];
    /** 可见方式：默认公开；password 需要填 password */
    visibility?: 'public' | 'password';
    password?: string;
  }) =>
    request<{ post: PlazaPost }>('/api/plaza/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  /** 解锁「密码可见」的帖子（密码正确时返回完整内容） */
  unlockPost: (id: string, password: string) =>
    request<{ post: PlazaPost }>(`/api/plaza/posts/${id}/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    }),

  /** 修改自己帖子的可见方式（公开 ⇄ 密码可见） */
  setPostVisibility: (id: string, body: { visibility: 'public' | 'password'; password?: string }) =>
    request<{ post: PlazaPost }>(`/api/plaza/posts/${id}/visibility`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  /** 上传广场附件（图片 / 视频 / 音频 / 文件），一次最多 12 个 */
  uploadPlaza: (files: { blob: Blob; name: string }[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f.blob, f.name);
    return request<{ attachments: PlazaAttachment[]; rejected: string[] }>('/api/plaza/upload', {
      method: 'POST', body: form,
    });
  },

  emojis: (q = '') =>
    request<{ emojis: Sticker[] }>(`/api/plaza/emojis?q=${encodeURIComponent(q)}`),

  addEmoji: (body: { name: string; tags?: string; url: string }) =>
    request<{ emoji: Sticker }>('/api/plaza/emojis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  deleteEmoji: (id: string) => request<{ ok: boolean }>(`/api/plaza/emojis/${id}`, { method: 'DELETE' }),

  /** 在线搜索 GIF 表情包（Tenor） */
  searchGifs: (q: string) =>
    request<{ gifs: { id: string; desc: string; url: string; preview: string }[] }>(
      `/api/plaza/emojis/gif?q=${encodeURIComponent(q)}`,
    ),
  /** 把搜到的 GIF 收录为站内表情包，之后可像普通表情包一样使用 */
  saveGif: (url: string, term: string) =>
    request<{ emoji: Sticker }>('/api/plaza/emojis/gif', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, term }),
    }),

  likePost: (id: string) => request<{ post: PlazaPost }>(`/api/plaza/posts/${id}/like`, { method: 'POST' }),

  comment: (id: string, content: string) =>
    request<{ post: PlazaPost }>(`/api/plaza/posts/${id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    }),

  deleteComment: (postId: string, commentId: string) =>
    request<{ post: PlazaPost }>(`/api/plaza/posts/${postId}/comments/${commentId}`, { method: 'DELETE' }),

  deletePost: (id: string) => request<{ ok: boolean }>(`/api/plaza/posts/${id}`, { method: 'DELETE' }),
};

/* ------------------------------ 在线书源（通用规则化抓取） ------------------------------ */
export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  builtin: boolean;
  hasRules: boolean;
}
export interface SourceSearchItem {
  title: string;
  link: string;
  cover: string;
}
export interface SourceChapterItem {
  title: string;
  url: string;
}
export interface SourceImportResult {
  comicId: string;
  chapterId: string;
  chapterTitle: string;
  coverUrl: string | null;
  total: number;
  stored: number;
  failed: number;
  chaptersDone: number;
}

export const sources = {
  list: () => request<{ sources: SourceInfo[] }>('/api/sources'),

  save: (body: {
    id?: string;
    name: string;
    baseUrl: string;
    rules: Record<string, Record<string, string>>;
    headers?: Record<string, string>;
  }) =>
    request<{ ok: boolean; id: string }>('/api/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  remove: (id: string) => request<{ ok: boolean }>(`/api/sources/${id}`, { method: 'DELETE' }),

  search: (id: string, kw: string, page = 1) =>
    request<{ items: SourceSearchItem[]; url: string }>(
      `/api/sources/${id}/search?kw=${encodeURIComponent(kw)}&page=${page}`,
    ),

  comic: (id: string, url: string) =>
    request<{ title: string; cover: string; chapters: SourceChapterItem[] }>(`/api/sources/${id}/comic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    }),

  importChapter: (body: {
    comicId?: string;
    sourceId: string;
    sourceName: string;
    title?: string;
    cover?: string;
    comicUrl?: string;
    chapterTitle: string;
    chapterUrl: string;
  }) =>
    request<SourceImportResult>('/api/sources/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
};

/* ------------------------------ 发现 / 排行 / 动态 / 公告 / 软件 ------------------------------ */
export const discover = {
  categories: () =>
    request<{ categories: Category[] }>('/api/community/categories'),

  ranking: (type = 'hot', limit = 10) =>
    request<{ ranking: RankingItem[]; type: string; total: number }>(
      `/api/community/ranking?type=${encodeURIComponent(type)}&limit=${limit}`,
    ),

  uploads: (limit = 40) =>
    request<{ uploads: UploadRecord[]; total: number }>(
      `/api/community/uploads?limit=${limit}`,
    ),

  activity: (limit = 40) =>
    request<{ activities: ActivityItem[]; announcements: Announcement[]; canAnnounce: boolean }>(
      `/api/activity?limit=${limit}`,
    ),

  announcements: () =>
    request<{ announcements: Announcement[]; canAnnounce: boolean }>('/api/announcements'),

  createAnnouncement: (body: { title: string; content: string }) =>
    request<{ announcement: Announcement }>('/api/announcements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  deleteAnnouncement: (id: string) =>
    request<{ ok: boolean }>(`/api/announcements/${id}`, { method: 'DELETE' }),

  software: () => request<SoftwareInfo>('/api/software'),

  checkUpdate: (channel: 'desktop' | 'android' | 'web', current = '') =>
    request<UpdateInfo>(
      `/api/software/latest?channel=${channel}&current=${encodeURIComponent(current)}`,
    ),

  view: (comicId: string) =>
    request<{ views: number }>('/api/discovery/view', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comicId }),
    }),

  like: (comicId: string) =>
    request<{ likes: number; liked: boolean }>('/api/discovery/like', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comicId }),
    }),

  setCategory: (comicId: string, category: string) =>
    request<{ category: string }>('/api/discovery/category', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comicId, category }),
    }),

  /** 必须传 confirmRights: true；服务端不会爬取任何第三方站点 */
  importComics: (body: { confirmRights: boolean; items: ImportComicItem[] }) =>
    request<ImportResult>('/api/community/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

export interface PublicComic {
  id: string;
  title: string;
  author: string;
  artist: string;
  description: string;
  tags: string[];
  status: string;
  direction: 'ltr' | 'rtl';
  language: string;
  coverUrl: string | null;
  pageCount: number;
  chapters: Chapter[];
  share: {
    allowDownload: boolean;
    expiresAt: number | null;
    hasPassword: boolean;
    chapterIds?: string[];
    partial?: boolean;
  };
}

export function exportUrl(comicId: string, format: string, chapterIds?: string[]) {
  const params = new URLSearchParams({ format });
  if (chapterIds?.length) params.set('chapters', chapterIds.join(','));
  return withShareCode(`/api/export/${comicId}?${params.toString()}`);
}

export function shareExportUrl(token: string, format: string, chapterIds?: string[], password?: string) {
  const params = new URLSearchParams({ format });
  if (chapterIds?.length) params.set('chapters', chapterIds.join(','));
  if (password) params.set('password', password);
  return withShareCode(`/api/share/${token}/export?${params.toString()}`);
}
