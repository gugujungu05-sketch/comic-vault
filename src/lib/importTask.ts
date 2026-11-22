/**
 * 全局「导入任务」状态：在线来源导入漫画/小说时，把进度写到这里，
 * 让悬浮任务栏在任何页面（含阅读器返回后）都能继续看到进度与结果。
 * 采用模块级 store + useSyncExternalStore，避免引入额外状态库。
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
}

const EMPTY: ImportTask = {
  active: false, done: 0, total: 0, failed: 0, label: '', comicId: '', finished: false,
};

let state: ImportTask = EMPTY;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((fn) => fn()); }

export const importTaskStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot(): ImportTask { return state; },
  /** 开始/更新导入进度 */
  start(label = '正在导入') {
    state = { active: true, done: 0, total: 0, failed: 0, label, comicId: '', finished: false };
    emit();
  },
  progress(patch: Partial<ImportTask>) {
    state = { ...state, ...patch, active: true, finished: false };
    emit();
  },
  /** 导入完成（comicId 可用于「查看」跳转） */
  finish(done: number, total: number, failed: number, comicId = '') {
    state = { ...state, active: false, done, total, failed, comicId, finished: true, label: '' };
    emit();
  },
  /** 全部失败 / 取消 */
  clear() {
    state = EMPTY;
    emit();
  },
};
