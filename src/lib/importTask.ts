/**
 * 全局「导入任务」状态：在线来源导入漫画/小说时，把进度写到这里，
 * 让悬浮任务栏在任何页面（含阅读器返回后）都能继续看到进度与结果。
 * 采用模块级 store + useSyncExternalStore，避免引入额外状态库。
 *
 * 进度与暂停状态持久化到 localStorage：刷新 / 切页 / 退出后仍能看到任务，
 * 用户还能点「暂停 / 继续」控制导入循环（循环每话前读取 paused 标志）。
 */
export interface ImportTask {
  active: boolean;
  done: number;
  total: number;
  failed: number;
  label: string;
  /** 成功导入后的书库漫画 id，导入完成可点「查看」跳转 */
  comicId: string;
  /** 完成态：true=全部成功/部分成功，false=失败 */
  finished: boolean;
  /** 暂停标志：导入循环在每个章节前读取，true 时等待 */
  paused: boolean;
  /** 导入上下文（用于刷新后恢复 / 续导） */
  ctx?: {
    sourceId: string; sourceName: string; title: string; cover: string;
    comicUrl: string; bookId: string; kind: string;
    picked: { title: string; url: string }[];
  };
}

const EMPTY: ImportTask = {
  active: false, done: 0, total: 0, failed: 0, label: '', comicId: '', finished: false, paused: false,
};

const LS_KEY = 'cv-import-task';
function load(): ImportTask {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return { ...EMPTY, ...JSON.parse(s) };
  } catch { /* 忽略 */ }
  return EMPTY;
}
function persist(t: ImportTask) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(t)); } catch { /* 忽略 */ }
}

let state: ImportTask = typeof localStorage !== 'undefined' ? load() : EMPTY;
const listeners = new Set<() => void>();

function emit() {
  persist(state);
  listeners.forEach((fn) => fn());
}

export const importTaskStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot(): ImportTask { return state; },
  /** 开始/更新导入进度；ctx 保存导入上下文供暂停/续导使用 */
  start(label = '正在导入', ctx?: ImportTask['ctx']) {
    state = { active: true, done: 0, total: 0, failed: 0, label, comicId: '', finished: false, paused: false, ctx };
    emit();
  },
  progress(patch: Partial<ImportTask>) {
    state = { ...state, ...patch, active: true, finished: false };
    emit();
  },
  /** 暂停 / 继续 */
  setPaused(paused: boolean) {
    state = { ...state, paused };
    emit();
  },
  /** 导入完成（comicId 可用于「查看」跳转） */
  finish(done: number, total: number, failed: number, comicId = '') {
    state = { ...state, active: false, done, total, failed, comicId, finished: true, label: '', paused: false };
    emit();
  },
  /** 全部失败 / 取消 / 关闭 */
  clear() {
    state = EMPTY;
    emit();
  },
  /** 当前是否暂停（供导入循环读取） */
  isPaused(): boolean { return state.paused; },
};
