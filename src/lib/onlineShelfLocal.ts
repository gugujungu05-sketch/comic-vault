/**
 * 在线来源「本地书架」兜底存储。
 *
 * 后端 /api/online/shelf 系列接口全部 requireUser：未登录本站账号时，
 * 在线收藏与阅读进度会 401 静默丢失。但产品定位是「浏览/阅读无需登录」，
 * 所以这里用 localStorage 为未登录用户保存一份书架 + 阅读进度，
 * 让「收藏书架 / 在线来源」在任何情况下都能记录阅读历史。
 *
 * 数据结构与后端 OnlineShelfItem 保持一致；id 用 local_ 前缀区分，
 * 便于登录后与云端项合并时识别。
 */
import type { OnlineShelfItem } from './api';

const LS_KEY = 'cv-online-shelf-local';

function read(): OnlineShelfItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // 老数据没有 favorite 字段：默认视为收藏，平滑迁移
    return arr.map((x) => ({ ...x, favorite: x.favorite !== false }));
  } catch { return []; }
}

function write(items: OnlineShelfItem[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch { /* 忽略配额/隐私模式 */ }
}

export interface LocalShelfAddInput {
  sourceKey: string;
  sourceName: string;
  bookId: string;
  title: string;
  cover?: string;
  author?: string;
  kind?: 'comic' | 'novel';
  chaptersTotal?: number;
  /** true=主动收藏（默认），false=仅在线阅读产生的历史记录 */
  favorite?: boolean;
}

export const onlineShelfLocal = {
  all(): OnlineShelfItem[] {
    return read();
  },

  find(key: string): OnlineShelfItem | null {
    return read().find((x) => x.key === key) || null;
  },

  add(input: LocalShelfAddInput): OnlineShelfItem {
    const key = `${input.sourceKey}:${input.bookId}`;
    const items = read();
    let item = items.find((x) => x.key === key);
    if (!item) {
      item = {
        id: `local_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        key,
        sourceKey: input.sourceKey,
        sourceName: input.sourceName || '',
        bookId: String(input.bookId),
        title: String(input.title || '在线阅读').slice(0, 120),
        cover: String(input.cover || ''),
        coverProxy: '',
        author: String(input.author || '').slice(0, 60),
        kind: input.kind === 'novel' ? 'novel' : 'comic',
        chaptersTotal: Number(input.chaptersTotal) || 0,
        progress: null,
        favorite: input.favorite !== false,
        addedAt: Date.now(),
      } as OnlineShelfItem;
      items.unshift(item);
    } else {
      item.title = item.title || input.title;
      item.cover = item.cover || input.cover || '';
      item.author = item.author || input.author || '';
      if (input.chaptersTotal) item.chaptersTotal = Number(input.chaptersTotal) || item.chaptersTotal;
      // 显式传入时更新收藏标记（例如从阅读历史再次收藏）
      if (typeof input.favorite === 'boolean') item.favorite = input.favorite;
    }
    write(items);
    return item;
  },

  /** 切换收藏标记（不删除条目，便于历史与收藏互相保留） */
  setFavorite(id: string, favorite: boolean) {
    const items = read();
    const item = items.find((x) => x.id === id);
    if (!item) return;
    item.favorite = !!favorite;
    write(items);
  },

  remove(id: string) {
    write(read().filter((x) => x.id !== id));
  },

  progress(id: string, p: { chapterUrl: string; chapterTitle: string; pageIndex: number }) {
    const items = read();
    const item = items.find((x) => x.id === id);
    if (!item) return;
    item.progress = {
      chapterUrl: String(p.chapterUrl || ''),
      chapterTitle: String(p.chapterTitle || ''),
      pageIndex: Math.max(0, Number(p.pageIndex) || 0),
      updatedAt: Date.now(),
    };
    write(items);
  },

  /** 合并云端与本地书架：按 key 去重，本地项（未登录时创建）保留，云端项优先用云端 id */
  merge(remote: OnlineShelfItem[]): OnlineShelfItem[] {
    const local = read();
    const keys = new Set(remote.map((x) => x.key));
    const onlyLocal = local.filter((x) => !keys.has(x.key));
    return [...remote, ...onlyLocal];
  },
};
