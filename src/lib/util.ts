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
