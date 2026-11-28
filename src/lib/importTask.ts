/**
 * 全局「导入任务」状态：在线来源导入漫画/小说时，把进度写到这里，
 * 让悬浮任务栏在任何页面（含阅读器返回后）都能继续看到进度与结果。
 * 采用模块级 store + useSyncExternalStore，避免引入额外状态库。
 *
 * 支持多个任务同时进行：每个任务有唯一 id，独立进度/暂停/结果。
 * 进度与暂停状态持久化到 localStorage：刷新 / 切页 / 退出后仍能看到任务，
 * 用户还能点「暂停 / 继续」控制各自的导入循环（循环每话前读取对应任务的 paused 标志）。
 */
export interface ImportTask {
  /** 任务唯一 id（一次导入一个） */
  id: string;
  active: boolean;
  done: number;
  total: number;
  failed: number;
  label: string;
  /** 成功导入后的书库漫画 id，导入完成可点「查看」跳转 */
  comicId: string;
  /** 完成态：true=全部成功/部分成功 */
  finished: boolean;
  /** 暂停标志：导入循环在每个章节前读取，true 时等待 */
  paused: boolean;
  /** 最近更新时间戳：用于清理刷新后残留的僵尸任务 */
  updatedAt?: number;
  /** 导入上下文（用于刷新后恢复 / 续导） */
  ctx?: {
    sourceId: string; sourceName: string; title: string; cover: string;
    comicUrl: string; bookId: string; kind: string;
    picked: { title: string; url: string }[];
  };
}

const LS_KEY = 'cv-import-tasks';
const LEGACY_KEY = 'cv-import-task'; // 旧版单任务格式，首次读取时迁移

function newId(): string {
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalize(t: Partial<ImportTask>): ImportTask {
  return {
    id: t.id || newId(),
    active: !!t.active,
    done: Number(t.done) || 0,
    total: Number(t.total) || 0,
    failed: Number(t.failed) || 0,
    label: String(t.label || ''),
    comicId: String(t.comicId || ''),
    finished: !!t.finished,
    paused: !!t.paused,
    updatedAt: Number(t.updatedAt) || Date.now(),
    ctx: t.ctx,
  };
}

/** 僵尸任务上限：active 但超过 20 分钟没有任何进度更新，视为中断残留并结束 */
const STALE_MS = 20 * 60 * 1000;

function load(): ImportTask[] {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        const now = Date.now();
        return arr.map(normalize).filter((t) => {
          if (!t.active || t.finished) return true;
          // 页面刷新后导入循环已消失，残留的 active 任务若长时间未更新就结束掉，
          // 避免「导入卡这好久」——其实是上次会话遗留的僵尸任务。
          if (now - (t.updatedAt || 0) > STALE_MS) {
            t.active = false; t.finished = true;
            t.label = '导入已中断（可重新导入）';
          }
          return true;
        });
      }
    }
  } catch { /* 忽略 */ }
  // 迁移旧版单任务
  try {
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      const t = JSON.parse(old);
      if (t && (t.active || t.finished)) return [normalize(t)];
    }
  } catch { /* 忽略 */ }
  return [];
}

let state: ImportTask[] = typeof localStorage !== 'undefined' ? load() : [];
const listeners = new Set<() => void>();

function emit() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* 忽略 */ }
  listeners.forEach((fn) => fn());
}

export const importTaskStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot(): ImportTask[] { return state; },
  /** 新建一个导入任务，返回其 id；ctx 保存导入上下文供暂停/续导使用 */
  start(label = '正在导入', ctx?: ImportTask['ctx']): string {
    const id = newId();
    const task: ImportTask = {
      id, active: true, done: 0, total: 0, failed: 0,
      label, comicId: '', finished: false, paused: false, updatedAt: Date.now(), ctx,
    };
    state = [...state, task];
    emit();
    return id;
  },
  /** 更新某个任务的进度 */
  progress(id: string, patch: Partial<ImportTask>) {
    let changed = false;
    state = state.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...patch, active: true, finished: false, updatedAt: Date.now() };
    });
    if (changed) emit();
  },
  /** 暂停 / 继续某个任务 */
  setPaused(id: string, paused: boolean) {
    state = state.map((t) => (t.id === id ? { ...t, paused, updatedAt: Date.now() } : t));
    emit();
  },
  /** 某个任务完成（comicId 可用于「查看」跳转） */
  finish(id: string, done: number, total: number, failed: number, comicId = '') {
    state = state.map((t) => (t.id === id
      ? { ...t, active: false, done, total, failed, comicId, finished: true, label: '', paused: false, updatedAt: Date.now() }
      : t));
    emit();
  },
  /** 全部失败 / 取消：移除该任务 */
  clear(id: string) {
    state = state.filter((t) => t.id !== id);
    emit();
  },
  /** 清空所有任务 */
  clearAll() {
    state = [];
    emit();
  },
  /** 当前某任务是否暂停（供导入循环读取） */
  isPaused(id: string): boolean {
    const t = state.find((x) => x.id === id);
    return t ? t.paused : false;
  },
};
