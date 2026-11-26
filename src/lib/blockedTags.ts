/**
 * 在线来源「标签屏蔽」本地存储。
 *
 * 每个书源、抽奖机各自维护一份「被屏蔽标签」清单：用户在屏蔽设置里整合该源
 * （或所有源）的标签题材后多选，带这些标签的书在发现/搜索/抽奖结果里都不出现。
 *
 * 屏蔽只影响"展示/抽取"，不改书源脚本、不影响已收藏的书；纯本地偏好，
 * 用 localStorage 持久化，无需登录即可生效。
 *
 * 存储标签「原文」（展示友好），匹配时再归一化（小写、去空格标点），
 * 与后端 normalizeTag 对齐，简繁/标点/空格差异不影响匹配。
 */

const LS_KEY = 'cv-blocked-tags';

/** 抽奖机全局屏蔽使用的固定 key */
export const LOTTERY_SCOPE = '__lottery__';
/** 「全部漫画/全部小说」聚合视图使用的屏蔽 key（按 tab 区分） */
export const allScope = (tab: 'comic' | 'novel') => `__all_${tab}__`;

type BlockMap = Record<string, string[]>;

function read(): BlockMap {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function write(map: BlockMap) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch { /* 忽略配额/隐私模式 */ }
}

/** 与后端 normalizeTag 保持一致：去空白/标点/符号并转小写 */
export function normalizeTag(t: string): string {
  return String(t || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 按归一化 key 去重，保留首个原文 */
function dedupeKeepOriginal(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = normalizeTag(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export const blockedTags = {
  /** 取某个 scope（源 id / __lottery__ / __all_*__）的屏蔽标签原文 */
  get(scope: string): string[] {
    const arr = read()[scope];
    return Array.isArray(arr) ? arr : [];
  },

  /** 设置某个 scope 的屏蔽标签（存原文，按归一化去重）；传空数组即清除 */
  set(scope: string, tags: string[]) {
    const map = read();
    const list = dedupeKeepOriginal(tags);
    if (list.length) map[scope] = list;
    else delete map[scope];
    write(map);
  },

  /** 是否屏蔽了某本书：任一标签归一化后等于/包含屏蔽项即命中 */
  isBlocked(tags: string[] | undefined, blocked: string[]): boolean {
    if (!blocked?.length || !tags?.length) return false;
    const set = new Set(blocked.map(normalizeTag).filter(Boolean));
    return tags.some((t) => {
      const n = normalizeTag(t);
      if (!n) return false;
      for (const b of set) if (b && (n === b || n.includes(b))) return true;
      return false;
    });
  },

  /** 合并多个 scope 的屏蔽清单（聚合视图：各源 + 聚合自身），保留原文 */
  merge(...scopes: string[]): string[] {
    const map = read();
    const all: string[] = [];
    for (const s of scopes) for (const t of (map[s] || [])) all.push(t);
    return dedupeKeepOriginal(all);
  },
};
