/** 自然排序：ch2 < ch10，001 < 002 */
export function naturalCompare(a: string, b: string): number {
  const ax: (string | number)[] = [];
  const bx: (string | number)[] = [];
  const tokenize = (s: string) => s.match(/\d+|\D+/g) || [s];
  for (const part of tokenize(a)) {
    const n = Number(part);
    ax.push(Number.isNaN(n) ? part.toLowerCase() : n);
  }
  for (const part of tokenize(b)) {
    const n = Number(part);
    bx.push(Number.isNaN(n) ? part.toLowerCase() : n);
  }
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    if (ax[i] === undefined) return -1;
    if (bx[i] === undefined) return 1;
    if (ax[i] === bx[i]) continue;
    const bothNum = typeof ax[i] === 'number' && typeof bx[i] === 'number';
    if (bothNum) return (ax[i] as number) - (bx[i] as number);
    return String(ax[i]) < String(bx[i]) ? -1 : 1;
  }
  return 0;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** 从文件名解析话数：'第03话' / 'ch03' / '003' -> 3 */
export function guessChapterNumber(name: string): number | null {
  const m = name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 从文件名解析话标题：去掉扩展名与前导序号 */
export function cleanTitle(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/^[_\-\s]*\d+[_\-\s]*/, '')
    .replace(/[_\-]+/g, ' ')
    .trim();
}

export function debounce<F extends (...args: never[]) => void>(fn: F, wait = 300) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export const SHARE_CODE_KEY = 'cv-sharecode';

/** 取当前凭据：地址栏 > localStorage > sessionStorage */
export function getShareCode(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('sharecode');
    if (fromUrl) return fromUrl;
  } catch {
    /* 忽略 */
  }
  try {
    return localStorage.getItem(SHARE_CODE_KEY) || sessionStorage.getItem(SHARE_CODE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * 托管环境下（如 workbuddy.host），访问需要 ?sharecode= 凭据。
 * 该函数把凭据附加到要对外打开的链接（分享链接、二维码、下载地址）上，
 * 并在会话内记忆，避免 SPA 内部跳转后刷新丢失。
 */
export function withShareCode(url: string): string {
  if (!url) return url;
  const code = getShareCode();
  if (!code) return url;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return url;
    if (!u.searchParams.get('sharecode')) u.searchParams.set('sharecode', code);
    return u.toString();
  } catch {
    return url;
  }
}

/** 记住当前地址里的 sharecode，供后续跳转/刷新时补回 */
export function rememberShareCode(): void {
  try {
    const code = new URLSearchParams(window.location.search).get('sharecode');
    if (!code) return;
    try {
      localStorage.setItem(SHARE_CODE_KEY, code);
    } catch {
      /* 隐私模式忽略 */
    }
    try {
      sessionStorage.setItem(SHARE_CODE_KEY, code);
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 忽略 */
  }
}

/** 给同源 URL 补上凭据；非同源或已带凭据则原样返回 */
export function withCredential(url: string): string {
  const code = getShareCode();
  if (!code || !url) return url;
  try {
    const u = new URL(url, window.location.href);
    if (u.origin !== window.location.origin) return url;
    if (u.searchParams.get('sharecode')) return url;
    u.searchParams.set('sharecode', code);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 兜底：即使 Service Worker 不可用（老浏览器 / 非安全上下文），
 * 也让所有 fetch / XHR 请求自动带上凭据，避免 API 被网关拦截返回 403。
 * 同时注册并唤醒 Service Worker，由它接管 <img>、动态 chunk 等其余请求。
 */
export function installNetworkCredential(): void {
  const code = getShareCode();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (typeof input === 'string') return nativeFetch(withCredential(input), init);
      if (input instanceof Request) {
        const u = new URL(input.url, window.location.href);
        if (u.origin === window.location.origin && !u.searchParams.get('sharecode') && code) {
          u.searchParams.set('sharecode', code);
          return nativeFetch(new Request(u.toString(), input));
        }
      }
    } catch {
      /* 出错则退回原始请求 */
    }
    return nativeFetch(input as RequestInfo, init);
  }) as typeof window.fetch;

  const nativeOpen = XMLHttpRequest.prototype.open;
  function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      (nativeOpen as (...a: unknown[]) => void).call(
        this,
        method,
        withCredential(String(url)),
        ...rest,
      );
    } catch {
      (nativeOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    }
  }
  XMLHttpRequest.prototype.open = patchedOpen as typeof XMLHttpRequest.prototype.open;

  if (!code || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(`/sw.js?sharecode=${encodeURIComponent(code)}`, { scope: '/' })
    .then((reg) => {
      const send = () => {
        reg.active?.postMessage({ type: 'cv-sharecode', code });
        navigator.serviceWorker.controller?.postMessage({ type: 'cv-sharecode', code });
      };
      send();
      // Service Worker 被回收重启后会丢失凭据，页面可见/恢复时重新告知
      window.addEventListener('pageshow', send);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) send();
      });
    })
    .catch(() => {
      /* 不支持则忽略，已有 fetch/XHR 兜底 */
    });
}
