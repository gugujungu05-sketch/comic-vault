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
/**
 * API 基址（域名直达方案的核心）：
 * - 网站从任何域名打开（GitHub Pages / 自有域名 / 直连本机），前端都是同一份；
 * - 页面加载时异步探测可用后端（本机服务 127.0.0.1:8787 → 用户在设置里填的地址 → 同源），
 *   探测成功前请求先按同源发（本机部署时立即成功）；
 * - 跨域后端（如 Pages 域名连本机服务）由服务端 CORS 放行。
 * 媒体地址（封面 / 页面 / 附件）同样通过 absoluteUrl() 补全成绝对地址。
 */
const LS_API_BASE = 'cv-api-base';

let apiBase = '';
try {
  apiBase = localStorage.getItem(LS_API_BASE) || '';
} catch { /* 忽略 */ }

export function getApiBase(): string {
  return apiBase;
}

export function setApiBase(url: string): void {
  apiBase = String(url || '').replace(/\/+$/, '');
  try {
    if (apiBase) localStorage.setItem(LS_API_BASE, apiBase);
    else localStorage.removeItem(LS_API_BASE);
  } catch { /* 忽略 */ }
}

/** 探测单个后端；成功返回该 base，失败返回 null */
async function probeBackend(base: string, timeoutMs: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/api/runtime`, {
      cache: 'no-store', signal: ctrl.signal, credentials: 'include',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' && 'app' in data ? base : null;
  } catch { return null; }
}

/**
 * 探测可用后端：所有候选**并行竞速**，谁先返回可用就立即锁定。
 *
 * 历史 bug：原来是串行 for 循环，每个候选最多等 8 秒。backend.json 里累积了多个
 * 已失效的临时隧道地址，加上浏览器缓存的旧地址，隧道一换就要等 40+ 秒才轮到新地址，
 * 期间用户点「获取验证码」等请求全部打向死地址，表现为「发送失败 / 一直转圈」。
 * 并行后耗时恒等于最快可用后端的响应时间，失效地址不再拖慢整体。
 */
export async function detectApiBase(candidates: string[] = ['']): Promise<string | null> {
  const list = candidates.filter((c, i) => candidates.indexOf(c) === i);
  if (!list.length) return null;
  const TIMEOUT = 7000;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let pending = list.length;
    for (const base of list) {
      probeBackend(base, TIMEOUT)
        .then((okBase) => {
          if (!settled && okBase !== null) {
            settled = true;
            apiBase = okBase;
            try { localStorage.setItem(LS_API_BASE, apiBase); } catch { /* 忽略 */ }
            resolve(okBase);
          }
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0 && !settled) resolve(null);
        });
    }
  });
}

/** 把服务端返回的相对媒体地址补全成可访问的绝对地址（跨域后端时必须） */
export function absoluteUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (!apiBase) return url;
  return `${apiBase}${url}`;
}

/**
 * 统一处理响应里的资源地址：
 * 1) 绝对化（无条件）：跨域后端（GitHub Pages → 本机/隧道服务）时，服务端返回的
 *    /api/... 相对地址必须补上 apiBase，否则 <img src> / 下载链接会打到 Pages 静态站，
 *    表现为「头像、封面、页面、附件加载失败或一直转圈」。
 * 2) 分享码注入（有条件）：仅托管环境需要，且不能影响第 1 步。
 *
 * 历史 bug：这里原本写成 `if (!code) return value;`，绝大多数用户没有 sharecode，
 * 导致整段绝对化被跳过，网站跨域部署时所有媒体地址全部失效。两者必须解耦。
 */
function transformResponse<T>(value: T, code: string | null, depth = 0): T {
  if (value == null || depth > 12) return value;
  if (typeof value === 'string') {
    if (!value.startsWith('/api/')) return value;
    let v: string = value;
    if (code && !v.includes('sharecode=')) {
      v = `${v}${v.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(code)}`;
    }
    // apiBase 为空（同源 / 桌面端）时 absoluteUrl 原样返回，行为不变
    return absoluteUrl(v) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => transformResponse(v, code, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    for (const k of Object.keys(rec)) rec[k] = transformResponse(rec[k], code, depth + 1);
    return value;
  }
  return value;
}

/**
 * 带真实上传进度的请求。fetch() 没有上传进度事件，批量上传时进度条会长时间
 * 停在 0%（用户看到「一直不动」）；导入改用本函数逐批上报字节进度。
 */
function requestXHR<T>(
  url: string,
  init: RequestInit,
  onUpload?: (ratio: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method || 'GET', `${getApiBase()}${url}`, true);
    xhr.withCredentials = true;
    const headers = init.headers as Record<string, string> | undefined;
    if (headers) for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onUpload && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onUpload(Math.min(1, e.loaded / e.total));
      };
    }
    xhr.onload = () => {
      let data: unknown = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; }
      catch { data = xhr.responseText; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error((data as { error?: string })?.error || xhr.statusText || '请求失败'));
        return;
      }
      resolve(transformResponse(data as T, getShareCode()));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(init.body as Document | XMLHttpRequestBodyInit | null);
  });
}

/** 请求级网络故障：通知 App 重新探测后端（隧道地址变化后自动切换） */
function notifyBackendLost() {
  try { window.dispatchEvent(new CustomEvent('cv:backend-lost')); } catch { /* 忽略 */ }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${url}`, {
      ...init,
      // 跨域（GitHub Pages → 隧道）也要带会话 cookie，否则登录态无法保持
      credentials: 'include',
    });
  } catch (err) {
    notifyBackendLost();
    const raw = String((err as Error)?.message || err);
    // 浏览器原生报错（Failed to fetch / NetworkError）对用户毫无意义，统一转成可操作提示
    if (/failed to fetch|networkerror|load failed|abort/i.test(raw)) {
      throw new Error('无法连接漫画库服务器，正在自动重连，请稍后重试');
    }
    throw new Error(`网络请求失败：${raw}`);
  }
  // 静态站点把 /api/ 请求当页面返回 HTML（404），或隧道层故障（502/503/530）
  // 时视为后端丢失并触发重探测。注意 502 也可能是业务错误（如邮件发送失败），
  // 因此只在响应不是 JSON 时才判定为网关故障。
  if (res.status === 404 || res.status === 503 || res.status === 530) {
    if (getApiBase()) notifyBackendLost();
  }
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
  return transformResponse(data as T, getShareCode());
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
    // 小批量 + 真实字节进度：批次调小让进度更早、更细地推进；
    // 用 XHR 上报每批上传比例，避免整批传完才跳进度（表现为卡在 0%）。
    const BATCH = 6;
    let last: Chapter = { id: chapterId, title: '', number: 0, pages: [] };
    return (async () => {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const form = new FormData();
        for (const f of batch) form.append('files', f.blob, f.name);
        if (typeof index === 'number') form.append('index', String(index + i));
        const before = i;
        const result = await requestXHR<{ chapter: Chapter; added: number }>(
          `/api/comics/${comicId}/chapters/${chapterId}/pages`,
          { method: 'POST', body: form },
          (ratio) => onProgress?.(Math.min(files.length, before + ratio * batch.length), files.length),
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

  /** TXT / EPUB 文字书：一次上传，服务端自动分章入库，速度接近本地阅读器 */
  importNovelFile: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ kind: 'novel' | 'image'; comic?: Comic }>('/api/import/novel-file', {
      method: 'POST', body: form,
    });
  },

  /** 前端已分好章时直接提交（无需上传原文件） */
  importNovel: (body: {
    title: string; author?: string; description?: string;
    chapters: { title: string; text: string }[];
  }) =>
    request<{ kind: 'novel'; comic: Comic }>('/api/import/novel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  /** 小说单章正文按需加载 */
  novelChapter: (comicId: string, chapterId: string) =>
    request<{ title: string; text: string }>(`/api/novel/${comicId}/${chapterId}`),

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
