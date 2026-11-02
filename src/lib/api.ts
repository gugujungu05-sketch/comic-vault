import type {
  Chapter, Comic, ComicSummary, CommunityComic, MetaEntry,
  PlazaPost, Settings, ShareLog, Stats, User,
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
      codeLogin: { emailEnabled: boolean; devMode: boolean };
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
    request<{ ok: boolean; sent: boolean; devCode: string | null; hint: string }>('/api/auth/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    }),

  loginCode: (email: string, code: string) =>
    request<{ user: User; created: boolean }>('/api/auth/login-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User; comics: ComicSummary[]; postCount: number }>('/api/me'),

  updateMe: (body: { name?: string; bio?: string; avatar?: string; password?: string }) =>
    request<{ user: User }>('/api/me', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  userPage: (id: string) =>
    request<{ user: User; comics: ComicSummary[]; posts: PlazaPost[] }>(`/api/users/${id}`),

  community: () => request<{ comics: CommunityComic[] }>('/api/community/comics'),

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

  posts: () => request<{ posts: PlazaPost[] }>('/api/plaza/posts'),

  createPost: (body: { content: string; comicId?: string; shareUrl?: string }) =>
    request<{ post: PlazaPost }>('/api/plaza/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
