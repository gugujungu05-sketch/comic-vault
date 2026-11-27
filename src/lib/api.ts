import type {
  ActivityItem, Announcement, AnnouncementComment, Category, Chapter, Comic, ComicSummary, CommunityComic,
  ImportComicItem, ImportResult, MetaEntry, PlazaAttachment, PlazaBoard, PlazaPost,
  RankingItem, Settings, ShareLog, SoftwareInfo, Stats, Sticker, TranslateConfig, TranslateResult, UpdateInfo,
  UploadRecord, User,
} from '../types';
import { getShareCode } from './util';

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
const LS_API_CREDENTIAL = 'cv-api-credential';

let apiBase = '';
let apiCredential = '';
try {
  apiBase = localStorage.getItem(LS_API_BASE) || '';
  apiCredential = localStorage.getItem(LS_API_CREDENTIAL) || '';
} catch { /* 忽略 */ }

/**
 * 静态站首屏兜底：GitHub Pages 上页面一加载就要知道后端在哪、带什么凭据。
 *
 * 历史 bug：探测 backend.json 是异步的，首屏的 /api/runtime、/api/auth/status、
 * /api/activity 会先打到 Pages 同源而返回 404；用户在这几秒窗口里点「获取验证码」
 * 就看到「无法连接到服务器」。内置默认值后首屏请求直接命中固定后端，探测只用于故障转移。
 * 凭据本来就在公开可下载的 backend.json 里，内置不增加任何暴露面。
 */
const DEFAULT_API_BASE = 'https://a3375579f1d0038dc.app.workbuddy.host';
const DEFAULT_API_CREDENTIAL = 'HDZTNNHTBW';
try {
  if (typeof location !== 'undefined' && /github\.io$/i.test(location.hostname)) {
    if (!apiBase) apiBase = DEFAULT_API_BASE;
    if (!apiCredential) apiCredential = DEFAULT_API_CREDENTIAL;
  }
} catch { /* 忽略 */ }

/**
 * 固定托管后端（*.app.workbuddy.host）要求每个请求都带 ?sharecode= 访问凭据。
 * 凭据由站点 backend.json 的 credential 字段下发，存进 localStorage 后刷新即可用，
 * 不必等探测完成。注意项目本身也用 sharecode 作为「漫画分享密码」，两者同名：
 * 因此凡 URL 已含 sharecode（业务分享码或服务端注入的凭据）时都不再重复追加。
 */
export function setApiCredential(code: string | null | undefined): void {
  apiCredential = String(code || '');
  try {
    if (apiCredential) localStorage.setItem(LS_API_CREDENTIAL, apiCredential);
    else localStorage.removeItem(LS_API_CREDENTIAL);
  } catch { /* 忽略 */ }
}

function withBackendCredential(url: string): string {
  if (!apiCredential || url.includes('sharecode=')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(apiCredential)}`;
}

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

/**
 * 生成「别人一定能打开」的分享落地页链接。
 *
 * GitHub Pages 是纯静态托管：/comic-vault/s/:token 这类深链必然返回 404（HTTP
 * 状态码层面，404.html 兜底也改不掉，微信/扫码预览会直接判定打不开）；这是平台
 * 限制，前端无法根治。因此分享链接统一指向固定后端同源入口——它是真实 Express
 * 服务，SPA fallback 会返回 200 + 完整分享落地页，并且自带网关访问凭据，任何人
 * 点开/扫码都能直接在线阅读与下载，不需要登录、不需要跨站 cookie。
 */
export function shareLandingUrl(token: string): string {
  const base = (getApiBase() || DEFAULT_API_BASE).replace(/\/+$/, '');
  const cred = apiCredential || DEFAULT_API_CREDENTIAL;
  const url = `${base}/comic-vault/?s=${encodeURIComponent(token)}`;
  return `${url}&sharecode=${encodeURIComponent(cred)}`;
}

/** 探测单个后端；成功返回该 base，失败返回 null */
async function probeBackend(base: string, timeoutMs: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(withBackendCredential(`${base}/api/runtime`), {
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

/** 网络（VPN）诊断：探测后端连通性并测耗时，供设置页「网络检测」使用。
 *  同源部署（桌面内置服务 / 自托管）优先探测本机服务；Pages 部署探测云端后端。 */
export async function networkDiag(): Promise<{ ok: boolean; ms: number; base: string }> {
  const sameOrigin = typeof location !== 'undefined' && !/github\.io$/i.test(location.hostname);
  const list = [apiBase || '', sameOrigin ? '' : DEFAULT_API_BASE]
    .filter((b, i, arr) => arr.indexOf(b) === i && (b || arr.indexOf('') === i));
  const candidates = list.length ? list : [DEFAULT_API_BASE];
  const t0 = Date.now();
  const ok = await detectApiBase(candidates);
  return { ok: ok !== null, ms: Date.now() - t0, base: ok !== null ? (ok || '同源服务') : String(candidates[0] || DEFAULT_API_BASE) };
}

/**
 * 组件里手工构造的媒体地址（如在线来源封面 /api/online/img?...）也必须走这里：
 * 直接写相对路径会在 GitHub Pages 上打到静态站返回 404，且丢失 sharecode 凭据。
 */
export function mediaUrl(url: string | null | undefined): string {
  return absoluteUrl(url);
}

/** 把服务端返回的相对媒体地址补全成可访问的绝对地址（跨域后端时必须） */
export function absoluteUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (!apiBase) return url;
  // 服务端通常会把托管凭据注入响应里的 /api/ 地址；若网关消费掉了该参数，
  // 这里兜底补上，避免头像、封面、页面图等 <img> 请求被网关 403。
  return withBackendCredential(`${apiBase}${url}`);
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
    // 固定托管后端模式下 sharecode 是网关访问凭据，不能让业务分享码占用同名参数，
    // 否则图片等资源请求会丢凭据被 403；凭据由服务端注入 / absoluteUrl 兜底。
    if (code && !apiCredential && !v.includes('sharecode=')) {
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
  onUpload?: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const base = getApiBase();
    xhr.open(init.method || 'GET', base ? withBackendCredential(`${base}${url}`) : url, true);
    xhr.withCredentials = true;
    const headers = init.headers as Record<string, string> | undefined;
    if (headers) for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onUpload && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onUpload(e.loaded, e.total);
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
    xhr.onerror = () => reject(new Error(`网络错误，上传失败。${VPN_HINT}`));
    xhr.ontimeout = () => reject(new Error(`上传超时（网络被代理拦截或过慢）。${VPN_HINT}`));
    xhr.onabort = () => reject(new Error('上传已取消'));
    // VPN 下 TCP 挂起会永远转圈：给上传留 15 分钟兜底
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(init.body as Document | XMLHttpRequestBodyInit | null);
  });
}

/** 请求级网络故障：通知 App 重新探测后端（隧道地址变化后自动切换） */
function notifyBackendLost() {
  try { window.dispatchEvent(new CustomEvent('cv:backend-lost')); } catch { /* 忽略 */ }
}

/** VPN / 代理环境下的可操作提示：后端域名被代理节点拦截是最常见的「开了 VPN 全挂」原因 */
export const VPN_HINT = '若已开启 VPN / 加速器，请先关闭，或在分流规则里把 *.app.workbuddy.host 设为直连（DIRECT）';

/** 给 fetch 加超时；调用方若自带 signal 则两者任一触发即中止。
 *  VPN 下常见「TCP 挂起不报错」——没有超时会一直转圈，用户以为软件死了。 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const isUpload = init.body instanceof FormData || init.body instanceof Blob;
  const limit = timeoutMs ?? (isUpload ? 0 : /^(GET|HEAD)$/i.test(String(init.method || 'GET')) ? 15000 : 45000);
  if (!limit) return fetch(url, init);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limit);
  const onOuter = () => ctl.abort();
  init.signal?.addEventListener('abort', onOuter);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onOuter);
  }
}

async function request<T>(url: string, init?: RequestInit, retried = false): Promise<T> {
  let res: Response;
  try {
    const base = getApiBase();
    res = await fetchWithTimeout(base ? withBackendCredential(`${base}${url}`) : url, {
      ...init,
      // 跨域（GitHub Pages → 固定托管后端）也要带会话 cookie，否则登录态无法保持
      credentials: 'include',
    });
  } catch (err) {
    notifyBackendLost();
    // 网络层故障（网关抖动 / DNS / 临时断网 / VPN 代理拦截）：立刻探活默认后端并重放一次，
    // 不用等 10 秒定时器，用户也不会直接撞上「无法连接到服务器」。
    if (!retried) {
      const revived = await probeBackend(apiBase || DEFAULT_API_BASE, 5000);
      if (revived) {
        apiBase = revived;
        try { localStorage.setItem(LS_API_BASE, apiBase); } catch { /* 忽略 */ }
        return request<T>(url, init, true);
      }
    }
    const raw = String((err as Error)?.message || err);
    // 浏览器原生报错（Failed to fetch / NetworkError / 超时中止）对用户毫无意义，统一转成可操作提示
    if (/failed to fetch|networkerror|load failed|abort|timed?\s?out/i.test(raw)) {
      throw new Error(`无法连接漫画库服务器（${/abort/i.test(raw) && !/signal/i.test(raw) ? '连接超时' : '网络错误'}）。${VPN_HINT}`);
    }
    throw new Error(`网络请求失败：${raw}`);
  }
  // 静态站点把 /api/ 请求当页面返回 HTML（404），或隧道层故障（502/503/530）
  // 时视为后端丢失并触发重探测。注意 502 也可能是业务错误（如邮件发送失败），
  // 因此只在响应不是 JSON 时才判定为网关故障。
  if (res.status === 404 || res.status === 503 || res.status === 530) {
    if (getApiBase()) notifyBackendLost();
  }
  // 静态站把 /api/ 当页面返回 HTML、或网关故障：GET 请求重探测后重放一次。
  // POST 不重放响应层错误，避免验证码 / 注册 / 下单类请求被重复提交。
  if (!retried && !/^(POST|PUT|PATCH|DELETE)$/i.test(String(init?.method || 'GET')) &&
      (res.status === 404 || res.status === 403 || res.status === 502 || res.status === 503)) {
    const peek = await res.clone().text().catch(() => '');
    if (/^\s*</.test(peek) || res.status === 502 || res.status === 503) {
      const revived = await probeBackend(apiBase || DEFAULT_API_BASE, 5000);
      if (revived) {
        apiBase = revived;
        try { localStorage.setItem(LS_API_BASE, apiBase); } catch { /* 忽略 */ }
        return request<T>(url, init, true);
      }
    }
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
    // 批次加大到 8 + XHR 真实字节进度；同章节批次保持串行，
    // 跨章节的并发由上层（多话导入）负责，服务端另有每章节锁保证页序。
    const BATCH = 8;
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
          (loaded, total) => onProgress?.(Math.min(files.length, Math.round(before + (loaded / total) * batch.length)), files.length),
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

  /** 页面编辑撤销：查询可撤销状态 / 恢复上一次编辑（含被删、被覆盖的原图） */
  undoStatus: (comicId: string, chapterId: string) =>
    request<{ canUndo: number; latest: { op: string; label: string; ts: number } | null }>(
      `/api/comics/${comicId}/chapters/${chapterId}/undo/status`,
    ),
  undoPageEdit: (comicId: string, chapterId: string) =>
    request<{ ok: boolean; label?: string; op?: string; remaining: number; pageCount: number; chapter: Chapter }>(
      `/api/comics/${comicId}/chapters/${chapterId}/undo`,
      { method: 'POST' },
    ),

  /** 章节合并：把选中章节按顺序合并进第一章（小说拼正文 / 漫画拼页面），可撤销 */
  mergeChapters: (comicId: string, chapterIds: string[], title?: string) =>
    request<{ ok: boolean; merged: number; comic: Comic }>(`/api/comics/${comicId}/chapters/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterIds, title }),
    }),
  /** 章节合并撤销：查询状态 / 恢复最近一次合并前的完整章节列表 */
  mergeUndoStatus: (comicId: string) =>
    request<{ canUndo: number; latest: { op: string; label: string; ts: number } | null }>(
      `/api/comics/${comicId}/chapters/merge/undo/status`,
    ),
  undoChapterMerge: (comicId: string) =>
    request<{ ok: boolean; label?: string; remaining: number; chapterCount: number; comic: Comic }>(
      `/api/comics/${comicId}/chapters/merge/undo`,
      { method: 'POST' },
    ),
  /** 清理导入失败留下的 0 页空章节 */
  cleanEmptyChapters: (comicId: string) =>
    request<{ ok: boolean; removed: number; chapters: number }>(
      `/api/comics/${comicId}/clean-empty`,
      { method: 'POST' },
    ),

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

  /** TXT / EPUB 文字书：一次上传，服务端自动分章入库；带真实上传进度（大文件不再像卡死） */
  importNovelFile: (file: File, onProgress?: (loaded: number, total: number) => void) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return requestXHR<{ kind: 'novel' | 'image'; comic?: Comic }>('/api/import/novel-file', {
      method: 'POST', body: form,
    }, onProgress);
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

  getShared: (token: string, password?: string, visitorId?: string) => {
    const q = visitorId ? `?visitorId=${encodeURIComponent(visitorId)}` : '';
    return request<PublicComic>(`/api/share/${token}${q}`, {
      headers: password ? { 'x-share-password': password } : undefined,
    });
  },

  /** 访客上报阅读位置（同一访客重开链接可续读，访问记录里也会显示读到哪） */
  reportShareProgress: (
    token: string,
    body: { visitorId: string; chapterId: string; pageIndex: number },
    password?: string,
  ) =>
    request<{ ok: boolean }>(`/api/share/${token}/progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(password ? { 'x-share-password': password } : {}),
      },
      body: JSON.stringify(body),
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

/* ------------------------------ 在线书源（通用规则化抓取 + JS 脚本源） ------------------------------ */
export interface SourceHealth {
  ok: boolean;
  ms?: number;
  items?: number;
  stale?: boolean;
  err?: string;
  at?: number;
}
export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  builtin: boolean;
  hasRules: boolean;
  kind?: 'js' | 'rules';
  mediaType?: 'comic' | 'novel';
  version?: string;
  /** 后台自动探测的健康状态（每 20 分钟复检） */
  health?: SourceHealth | null;
}
export interface SourceSearchItem {
  title: string;
  link: string;
  cover: string;
  author?: string;
  latestChapter?: string | null;
  /** 书籍标签题材，用于屏蔽过滤 */
  tags?: string[];
  /** 前端「全部漫画 / 合并搜索」聚合时注入，标识结果来自哪个书源 */
  sourceId?: string;
  sourceName?: string;
}

/** 标签题材统计项：tag=原文（展示用），count=出现次数，sources=出现的源名 */
export interface SourceTagStat {
  tag: string;
  count: number;
  sources?: string[];
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
export interface SourceComicDetail {
  title: string;
  cover: string;
  url: string;
  author?: string;
  description?: string;
  tags?: string[];
  kind?: 'comic' | 'novel';
  bookId?: string;
  chapters: SourceChapterItem[] | null; // null = 小说整本（EPUB）下载
}

/* 在线书架（收藏在线来源的漫画/小说） */
export interface OnlineShelfItem {
  id: string;
  key: string;
  sourceKey: string;
  sourceName: string;
  bookId: string;
  title: string;
  cover: string;
  coverProxy: string;
  author: string;
  kind: 'comic' | 'novel';
  chaptersTotal: number;
  progress: { chapterUrl: string; chapterTitle: string; pageIndex: number; updatedAt: number } | null;
  /** 是否主动收藏：true=书架收藏，false=仅在线阅读产生的历史记录 */
  favorite: boolean;
  addedAt: number;
}

export const online = {
  shelf: () => request<{ items: OnlineShelfItem[] }>('/api/online/shelf'),
  addToShelf: (body: {
    sourceId: string;
    bookId: string;
    title: string;
    cover?: string;
    author?: string;
    kind?: 'comic' | 'novel';
    chaptersTotal?: number;
    favorite?: boolean;
  }) =>
    request<{ ok: boolean; item: OnlineShelfItem }>('/api/online/shelf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  setFavorite: (id: string, favorite: boolean) =>
    request<{ ok: boolean; item: OnlineShelfItem }>(`/api/online/shelf/${id}/favorite`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite }),
    }),
  removeFromShelf: (id: string) =>
    request<{ ok: boolean }>(`/api/online/shelf/${id}`, { method: 'DELETE' }),
  progress: (id: string, body: { chapterUrl: string; chapterTitle: string; pageIndex: number }) =>
    request<{ ok: boolean }>(`/api/online/shelf/${id}/progress`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  chapterImages: (sourceKey: string, bookId: string, chapterUrl: string) =>
    request<{ images: string[]; count: number }>(`/api/online/${sourceKey}/chapter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId, chapterUrl }),
    }),
  importBook: (sourceKey: string, bookId: string) =>
    request<{ kind: string; comic: { id: string; chapterCount: number; kind?: string } }>(`/api/online/${sourceKey}/import-book`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId }),
    }),
};

/** 抽奖机：跨所有来源抽取的推荐书籍（已跨源去重，可直接 openComic） */
export interface LotteryItem extends SourceSearchItem {
  sourceId: string;
  sourceName: string;
  media?: 'comic' | 'novel';
  tags?: string[];
  coverProxy?: string;
}
export interface LotteryGenre { id: string; label: string }

export const sources = {
  list: () => request<{ sources: SourceInfo[] }>('/api/sources'),

  /** 所有源的健康状态（后台自动探测） */
  healthAll: () => request<{ health: Record<string, SourceHealth> }>('/api/sources/health/all'),

  /** 手动触发重新探测所有源（自动修复：失效源恢复后即时回血） */
  recheckHealth: () => request<{ ok: boolean }>('/api/sources/health/recheck', { method: 'POST' }),

  /** 抽奖机题材清单 */
  lotteryGenres: () => request<{ genres: LotteryGenre[] }>('/api/sources/lottery/genres'),

  /** 抽奖机：按类型/题材从所有源抽取书籍（自动跨源按书名去重） */
  lottery: (body: { media?: 'comic' | 'novel' | 'all'; genres?: string[]; count?: number; refresh?: boolean; blocked?: string[] }) => {
    const q = new URLSearchParams();
    if (body.media) q.set('media', body.media);
    if (body.genres?.length) q.set('genres', body.genres.join(','));
    if (body.count) q.set('count', String(body.count));
    if (body.refresh) q.set('refresh', '1');
    if (body.blocked?.length) q.set('blocked', body.blocked.join(','));
    return request<{
      items: LotteryItem[];
      poolSize: number;
      media: string;
      genres: string[];
      cached: boolean;
    }>(`/api/sources/lottery?${q.toString()}`);
  },

  /** 标签整合：所有源所有书的标签题材（抽奖机屏蔽设置用） */
  allTags: (refresh = false) =>
    request<{ tags: SourceTagStat[]; cached: boolean; sourceCount: number }>(
      `/api/sources/tags/all${refresh ? '?refresh=1' : ''}`,
    ),

  /** 标签整合：某个源所有书的标签（单源屏蔽设置用） */
  sourceTags: (id: string, refresh = false) =>
    request<{ tags: SourceTagStat[]; source: string; cached: boolean; stale?: boolean }>(
      `/api/sources/${id}/tags${refresh ? '?refresh=1' : ''}`,
    ),

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

  /** 书源站点账号：保存/清除登录 Cookie（拷贝/热辣/vomic 等需登录的源） */
  getCookies: (id: string) => request<{
    ok: boolean; source: string; accountHint?: string; website?: string; canPasswordLogin?: boolean;
    loggedIn?: boolean; cookieCount?: number; credentialCount?: number;
  }>(`/api/sources/${id}/cookies`),
  saveCookies: (id: string, cookies: string) =>
    request<{ ok: boolean; count?: number; cleared?: boolean; login?: { loggedIn: boolean; cookieCount: number; credentialCount: number } }>(`/api/sources/${id}/cookies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies }),
    }),
  logoutSource: (id: string) =>
    request<{ ok: boolean; clearedCredentials?: number; hadCookie?: boolean; login?: { loggedIn: boolean; cookieCount: number; credentialCount: number } }>(
      `/api/sources/${id}/logout`, { method: 'POST' },
    ),
  /** 源账号密码登录（可选，用于同步书架/解锁受限内容） */
  accountLogin: (id: string, account: string, password: string) =>
    request<{ ok: boolean; message?: string; error?: string }>(`/api/sources/${id}/account-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }),
    }),

  search: (id: string, kw: string, page = 1, blocked?: string[]) => {
    const q = new URLSearchParams({ kw, page: String(page) });
    if (blocked?.length) q.set('blocked', blocked.join(','));
    return request<{ items: SourceSearchItem[]; url: string }>(
      `/api/sources/${id}/search?${q.toString()}`,
    );
  },

  discover: (id: string, tab = 0, page = 1, blocked?: string[]) => {
    const q = new URLSearchParams({ tab: String(tab), page: String(page) });
    if (blocked?.length) q.set('blocked', blocked.join(','));
    return request<{ tabs: { index: number; title: string; type: string }[]; items: SourceSearchItem[]; maxPage: number; tab: number }>(
      `/api/sources/${id}/discover?${q.toString()}`,
    );
  },

  comic: (id: string, url: string) =>
    request<SourceComicDetail>(`/api/sources/${id}/comic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    }),

  importChapter: (body: {
    comicId?: string;
    taskId?: string;
    sourceId: string;
    sourceName: string;
    title?: string;
    cover?: string;
    comicUrl?: string;
    bookId?: string;
    chapterTitle: string;
    chapterUrl: string;
  }) =>
    request<SourceImportResult>('/api/sources/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  importProgress: (taskId?: string) => request<{
    idle?: boolean; chapterTitle?: string; imageDone?: number; imageTotal?: number;
    done?: number; total?: number; phase?: string;
  }>(`/api/sources/import/progress${taskId ? '?taskId=' + encodeURIComponent(taskId) : ''}`),
};

/** AI 翻译（生肉漫画 → 中文）：多模态模型看图翻译 + 服务端底图修补/原位渲染 */
export const translation = {
  config: () => request<TranslateConfig>('/api/translate/config'),
  saveConfig: (body: Partial<TranslateConfig>) =>
    request<{ ok: boolean }>('/api/translate/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  test: () => request<{ ok: boolean; regions: number; model: string; provider: string }>('/api/translate/test', {
    method: 'POST',
  }),
  page: (url: string) =>
    request<TranslateResult>('/api/translate/page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
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

  updateAnnouncement: (id: string, body: { title: string; content: string }) =>
    request<{ announcement: Announcement }>(`/api/announcements/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),

  announcementDetail: (id: string) =>
    request<{ announcement: Announcement; canAnnounce: boolean; canManage: boolean }>(
      `/api/announcements/${id}`,
    ),

  commentAnnouncement: (id: string, text: string) =>
    request<{ comment: AnnouncementComment }>(`/api/announcements/${id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    }),

  deleteAnnouncementComment: (id: string, cid: string) =>
    request<{ ok: boolean }>(`/api/announcements/${id}/comments/${cid}`, { method: 'DELETE' }),

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
    /** 同一访客上次读到的位置，null 表示没有记录 */
    resume?: {
      chapterId: string;
      chapterTitle: string;
      pageIndex: number;
      chapterIndex: number;
      ts: number;
    } | null;
  };
}

/**
 * 下载链接必须直接指向后端：网站跨域部署在 GitHub Pages 时，相对 /api/ 地址会被
 * 浏览器当成 Pages 静态资源请求而 404，表现为「分享能打开但下载没反应」。
 * absoluteUrl() 会补上后端域名与托管网关凭据；同源部署时行为不变。
 */
export function exportUrl(comicId: string, format: string, chapterIds?: string[]) {
  const params = new URLSearchParams({ format });
  if (chapterIds?.length) params.set('chapters', chapterIds.join(','));
  return absoluteUrl(`/api/export/${comicId}?${params.toString()}`);
}

export function shareExportUrl(token: string, format: string, chapterIds?: string[], password?: string) {
  const params = new URLSearchParams({ format });
  if (chapterIds?.length) params.set('chapters', chapterIds.join(','));
  if (password) params.set('password', password);
  return absoluteUrl(`/api/share/${token}/export?${params.toString()}`);
}
