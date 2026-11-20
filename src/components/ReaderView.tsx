import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Chapter, Page, ReaderFilter, ReaderPrefs } from '../types';
import { Icon } from './Icon';
import { PageEditor } from './PageEditor';
import { saveImageToDevice } from '../lib/util';
import { translation } from '../lib/api';
import { THEMES, normalizeTheme } from '../lib/themes';
import { useToast } from './Toasts';

type Mode = ReaderPrefs['mode'];
type Fit = ReaderPrefs['fit'];
type Scope = 'all' | 'comic' | 'chapter';

const PREFS_KEY = 'cv-reader-prefs';
const SCOPE_KEY = 'cv-reader-scope';

const BASE_PREFS: ReaderPrefs = {
  mode: 'single',
  fit: 'contain',
  direction: 'ltr',
  filter: 'none',
  brightness: 1,
  contrast: 1,
  smartDouble: true,
  keepPageOrder: true,
  scrollCols: 1,
  hideWide: false,
  splitWide: false,
  linkChapters: true,
};

/** 跨页大图判定：优先用服务端标记，缺失/未刷新时按真实宽高比兜底。
    合并后的跨页图若后端没来得及标记 wide，仍能正确识别为跨页（独占一行 / 被隐藏）。 */
function isWide(p: { wide?: boolean; width?: number; height?: number } | undefined | null): boolean {
  if (!p) return false;
  if (p.wide) return true;
  if (p.width && p.height && p.width / p.height >= 1.15) return true;
  return false;
}

/** 一个"逻辑显示页"。half=full 为原页；l/r 为把跨页大图按左右半拆出的单页（同一张图，背景裁剪）。
    origIdx 指回 chapter.pages 下标，保证进度/存图/存档仍落在原页上。 */
type MediaPage = { p: Page; half: 'full' | 'l' | 'r'; key: string; origIdx: number };

/** 把原页列表按 splitWide 展开成逻辑显示页：跨页→左右两半，普通页不变。 */
function buildViewPages(pages: Page[], split: boolean): MediaPage[] {
  const out: MediaPage[] = [];
  pages.forEach((p, i) => {
    if (split && isWide(p)) {
      out.push({ p, half: 'l', key: `${p.id}-sl`, origIdx: i });
      out.push({ p, half: 'r', key: `${p.id}-sr`, origIdx: i });
    } else {
      out.push({ p, half: 'full', key: p.id, origIdx: i });
    }
  });
  return out;
}

/** 半图宽高比：跨页约 2:1，拆出的单页约 1:1；用真实尺寸精确计算，缺失时按 0.78 兜底。 */
function halfAspect(p: Page): string {
  if (p.width && p.height && p.width > 0 && p.height > 0) {
    return `${(p.width / 2).toFixed(2)} / ${p.height.toFixed(2)}`;
  }
  return '0.78';
}

/** 只有"完整页"才可能是跨页；拆出来的左右半不是跨页，可正常参与配对/并排。 */
function mediaIsWide(m: MediaPage | undefined): boolean {
  return !!m && m.half === 'full' && isWide(m.p);
}

/** 统一渲染一页媒体：完整页→img；拆出的左/右半→同一张图按背景定位裁一半。 */
function PageMedia({ m, className, style, alt, loading, onLoad, draggable, overrideUrl }: {
  m: MediaPage;
  className: string;
  style?: CSSProperties;
  alt?: string;
  loading?: 'eager' | 'lazy';
  onLoad?: () => void;
  draggable?: boolean;
  overrideUrl?: string;
}) {
  const src = overrideUrl || m.p.url;
  if (m.half === 'full') {
    return (
      <img
        className={className}
        src={src}
        alt={alt}
        loading={loading}
        onLoad={onLoad}
        draggable={draggable}
        style={style}
      />
    );
  }
  return (
    <div
      className={`${className} media-half media-half-${m.half}`}
      role="img"
      aria-label={alt}
      style={{
        aspectRatio: halfAspect(m.p),
        backgroundImage: src ? `url("${src}")` : undefined,
        ...style,
      }}
    />
  );
}

/** 按与 doubleScreens 相同的规则，求一章分屏后「最后一屏」的第一页索引（用于跨章回退对齐） */
function lastScreenStart(ch: { pages: { wide?: boolean; width?: number; height?: number }[] }, smartDouble: boolean): number {
  const pages = ch.pages || [];
  if (!pages.length) return 0;
  if (!smartDouble) return pages.length - 1;
  const last = pages.length - 1;
  // 末页是跨页 → 它自己独占最后一屏
  if (isWide(pages[last])) return last;
  // 末页是普通页：若倒数第二页存在且二者都非跨页，则它们成对，最后一屏从 last-1 开始；
  // 若倒数第二页是跨页（已独占前一屏），则末页自己单独成屏。
  if (last >= 1 && !isWide(pages[last - 1])) return last - 1;
  return last;
}

/** 兼容旧键：老版本存了 scrollDouble，新版本读 scrollCols */
function scrollColsOf(p: Partial<ReaderPrefs>): number {
  if (typeof p.scrollCols === 'number') return Math.min(4, Math.max(1, p.scrollCols));
  return p.scrollDouble ? 2 : 1;
}

function readPart(key: string): Partial<ReaderPrefs> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<ReaderPrefs>) : {};
  } catch {
    return {};
  }
}

function comicKeyOf(comicId?: string, title?: string) {
  return comicId || `share:${title || ''}`;
}

function prefKey(scope: Scope, comicKey: string, chapterId: string) {
  if (scope === 'chapter') return `${PREFS_KEY}:chapter:${chapterId}`;
  if (scope === 'comic') return `${PREFS_KEY}:comic:${comicKey}`;
  return PREFS_KEY;
}

/** 记忆优先级：本话 > 整本 > 全部；方向没被显式存过时沿用漫画自身方向 */
function loadEffective(comicKey: string, chapterId: string, fallbackDirection: 'ltr' | 'rtl'): ReaderPrefs {
  const g = readPart(PREFS_KEY);
  const c = readPart(`${PREFS_KEY}:comic:${comicKey}`);
  const ch = readPart(`${PREFS_KEY}:chapter:${chapterId}`);
  const merged = { ...BASE_PREFS, ...g, ...c, ...ch };
  const direction = ch.direction ?? c.direction ?? g.direction ?? fallbackDirection;
  return { ...merged, direction };
}

const FILTER_LABEL: Record<ReaderFilter, string> = {
  none: '原图',
  warm: '护眼',
  invert: '反色',
  gray: '黑白',
};

const MODE_LABEL: Record<Mode, string> = {
  single: '单页',
  double: '双页',
  continuous: '上下滚动',
  webtoon: '条漫',
};

export function ReaderView({
  title,
  chapters,
  direction: initialDirection,
  initialChapterId,
  initialPageIndex = 0,
  onProgress,
  onExit,
  headerExtra,
  readOnly = false,
  comicId,
  onPagesChanged,
  ensurePages,
}: {
  title: string;
  chapters: Chapter[];
  direction: 'ltr' | 'rtl';
  initialChapterId?: string;
  initialPageIndex?: number;
  onProgress?: (chapterId: string, pageIndex: number) => void;
  onExit: () => void;
  headerExtra?: ReactNode;
  readOnly?: boolean;
  /** 传入后可启用页面编辑（旋转/裁剪） */
  comicId?: string;
  onPagesChanged?: (chapter: Chapter) => void;
  /** 在线阅读：切到没有页面的章节时按需拉取页面（父组件负责回填 chapters） */
  ensurePages?: (chapter: Chapter) => Promise<unknown>;
}) {
  const toast = useToast();
  const comicKey = comicKeyOf(comicId, title);
  const [chapterIndex, setChapterIndex] = useState(() => {
    const i = chapters.findIndex((c) => c.id === initialChapterId);
    return i >= 0 ? i : 0;
  });
  const [pageIndex, setPageIndex] = useState(initialPageIndex);

  /* 阅读偏好：支持「全部漫画 / 仅这本 / 仅本话」三种记忆范围 */
  const [prefScope, setPrefScope] = useState<Scope>(() => {
    try {
      const s = localStorage.getItem(SCOPE_KEY);
      return s === 'comic' || s === 'chapter' ? s : 'all';
    } catch {
      return 'all';
    }
  });
  const initialPrefs = useRef(
    loadEffective(comicKey, chapters[chapterIndex]?.id || '', initialDirection),
  ).current;
  const [mode, setMode] = useState<Mode>(initialPrefs.mode);
  const [fit, setFit] = useState<Fit>(initialPrefs.fit);
  const [direction, setDirection] = useState<'ltr' | 'rtl'>(initialPrefs.direction);
  const [filter, setFilter] = useState<ReaderFilter>(initialPrefs.filter);
  const [brightness, setBrightness] = useState(initialPrefs.brightness);
  const [contrast, setContrast] = useState(initialPrefs.contrast);
  const [smartDouble, setSmartDouble] = useState(initialPrefs.smartDouble);
  const [keepPageOrder, setKeepPageOrder] = useState(initialPrefs.keepPageOrder !== false);
  const [scrollCols, setScrollCols] = useState(scrollColsOf(initialPrefs));
  const [splitWide, setSplitWide] = useState(!!initialPrefs.splitWide);
  const [linkChapters, setLinkChapters] = useState(!!initialPrefs.linkChapters);
  /* AI 翻译：origIdx → 译文图 URL（服务端缓存），以及正在翻译的原页集合 */
  const [translated, setTranslated] = useState<Record<number, string>>({});
  const [translating, setTranslating] = useState<Set<number>>(new Set());
  const [translateOn, setTranslateOn] = useState(false);
  /* 连续跨章：链式渲染的章节窗口。初始只含当前章，滚动到边界时向前/向后扩展。 */
  const [chainStart, setChainStart] = useState(chapterIndex);
  const [chainEnd, setChainEnd] = useState(chapterIndex);
  const [zoom, setZoom] = useState(1);

  /* 沉浸式：默认隐藏工具栏。只有「轻点画面正中间」或角落菜单按钮才切换 */
  const [uiVisible, setUiVisible] = useState(false);
  const uiRef = useRef(false);
  const [panel, setPanel] = useState<'toc' | 'pages' | 'filter' | 'settings' | null>(null);
  const [help, setHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  /* 阅读器内直接换主题：分享阅读器没有主界面设置页，也在这里换 */
  const [uiTheme, setUiTheme] = useState<string>(() => normalizeTheme(
    typeof document !== 'undefined' ? document.documentElement.dataset.theme : null,
  ));
  function changeTheme(id: string) {
    setUiTheme(id);
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('cv-theme', id); } catch { /* 忽略 */ }
  }
  const [saveChoice, setSaveChoice] = useState(false);
  const [swipeHint, setSwipeHint] = useState(false);
  const [scrollRatio, setScrollRatio] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressUntil = useRef(0);
  /* 本次触摸是否落在按键 / 面板等 UI 上：是则完全交给按键自己的 onClick，绝不翻页或关面板 */
  const touchOnUi = useRef(false);
  const touchStart = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const saveFirst = useRef(true);
  /* 链式跨章：向前扩展（prepend 上一话）后需要把滚动位置补偿回来，保持视觉连续 */
  const pendingScrollComp = useRef<{ heightBefore: number; topBefore: number } | null>(null);
  const chainTip = useRef({ start: chapterIndex, end: chapterIndex });
  const chapter = chapters[chapterIndex];
  /* 逻辑显示页：splitWide 开启时把跨页大图拆成左右两张单页，其余不变。
     pageIndex/进度/存档仍按逻辑页索引推进，origIdx 指回原页用于存图。 */
  const viewPages = useMemo<MediaPage[]>(
    () => buildViewPages(chapter?.pages || [], splitWide),
    [chapter, splitWide],
  );
  const total = viewPages.length;
  const rtl = direction === 'rtl';

  /* 双页模式：把整话预先划分成「屏」。跨页大图永远独占一屏，且它前面那张落单的普通页
     也单独成屏——这样跨页绝不会和相邻页并排。翻页在「屏」之间移动，无论从前往后翻，
     还是从下一话往回翻，同一张跨页的排版都完全一致（根治「滑回去才独占、再翻又并排」）。
     splitWide 开启后，拆出的左右半不再是跨页，会自然两两配对成"原样两页"。 */
  const doubleScreens = useMemo<number[][]>(() => {
    const pages = viewPages;
    const screens: number[][] = [];
    for (let i = 0; i < pages.length; ) {
      if (smartDouble && mediaIsWide(pages[i])) { screens.push([i]); i += 1; continue; }
      /* 拆分出的左右半（同一原跨页）强制配成独占一屏，恢复"原样两页对开" */
      if (pages[i].half === 'l' && i + 1 < pages.length && pages[i + 1].half === 'r'
          && pages[i + 1].origIdx === pages[i].origIdx) {
        screens.push([i, i + 1]); i += 2; continue;
      }
      /* 下一项是拆分出的左半：当前页落单独占，避免和半图配对把它拆散 */
      if (i + 1 < pages.length && pages[i + 1].half === 'l') { screens.push([i]); i += 1; continue; }
      if (i + 1 < pages.length && mediaIsWide(pages[i + 1])) { screens.push([i]); i += 1; continue; }
      if (i + 1 < pages.length) { screens.push([i, i + 1]); i += 2; }
      else { screens.push([i]); i += 1; }
    }
    return screens;
  }, [viewPages, smartDouble]);

  /* pageIndex 仍是「页索引」（供进度 / slider 用）；找到它所在的屏。
     拖动 slider 落在某屏的第二页时，归到该屏，避免把跨页拆开。 */
  const screenIndex = useMemo(() => {
    if (mode !== 'double') return 0;
    let k = doubleScreens.findIndex((s) => s[0] === pageIndex);
    if (k < 0) k = doubleScreens.findIndex((s) => s.includes(pageIndex));
    return k < 0 ? 0 : k;
  }, [doubleScreens, pageIndex, mode]);

  const activeScreen = mode === 'double' ? (doubleScreens[screenIndex] || [pageIndex]) : [pageIndex];
  const currentWide = mode === 'double' && smartDouble && mediaIsWide(viewPages[activeScreen[0]]);
  const step = mode === 'double' ? Math.max(1, activeScreen.length) : 1;

  const currentPages = useMemo<MediaPage[]>(() => {
    const idxs = mode === 'double' ? (doubleScreens[screenIndex] || [pageIndex]) : [pageIndex];
    const arr = idxs.map((i) => viewPages[i]).filter(Boolean);
    /* 保持单页自然顺序 1→2（默认）：双页显示不被 LTR/RTL 观看方向镜像打乱。
       只有显式关掉 keepPageOrder 时，才按方向镜像（日漫从右往左的传统排法）。 */
    return rtl && !keepPageOrder ? [...arr].reverse() : arr;
  }, [viewPages, pageIndex, mode, doubleScreens, screenIndex, rtl, keepPageOrder]);

  /* 滚动模式（上下滚动 / 条漫）：按 viewPages（可能已拆开跨页）和 scrollCols 把每 N 页并成一行。
     页序始终是自然顺序 1→2→3，不受 LTR/RTL 观看方向镜像——合并只改变排版，不改变单页顺序。
     跨页大图自动独占一行；每行元素仍引用原始 Page 对象，进度/存图逻辑不变。
     连续跨章开启时：把 [chainStart..chainEnd] 多章拼成一个连续滚动区，章与章之间插入标题分隔。 */
  const isScroll = mode === 'continuous' || mode === 'webtoon';
  type ScrollRow = { row: MediaPage[]; ci: number; pi: number; chapterStart?: boolean };

  /** 把一章的"逻辑显示页"按 scrollCols 分组。splitWide 关闭时跨页大图仍独占一行；
     开启时跨页已在 buildViewPages 拆成左右两张单页，会自然参与并排。页序始终为自然顺序，
     不受 LTR/RTL 镜像——合并/拆分只改变排版，不改变页序。 */
  function rowsForChapter(ch: Chapter, ci: number): ScrollRow[] {
    const pages = ch.id === chapter?.id ? viewPages : buildViewPages(ch.pages, splitWide);
    const base = pages.length ? pages[0].origIdx : -1;
    const out: ScrollRow[] = [];
    if (scrollCols <= 1) {
      pages.forEach((p, i) => out.push({ row: [p], ci, pi: p.origIdx, chapterStart: i === 0 && base === 0 }));
      return out;
    }
    for (let i = 0; i < pages.length; ) {
      const a = pages[i];
      const start = i === 0 && base === 0;
      if (mediaIsWide(a)) { out.push({ row: [a], ci, pi: a.origIdx, chapterStart: start }); i += 1; continue; }
      const row: MediaPage[] = [];
      let j = i;
      for (let c = 0; c < scrollCols && j < pages.length; c++, j++) {
        if (mediaIsWide(pages[j])) break;
        row.push(pages[j]);
      }
      if (!row.length) { row.push(pages[i]); j = i + 1; }
      out.push({ row, ci, pi: row[0].origIdx, chapterStart: start });
      i = j;
    }
    return out;
  }

  const chained = isScroll && linkChapters && chapters.length > 1;
  const scrollRows = useMemo<ScrollRow[]>(() => {
    if (!chapter) return [];
    if (!chained) return rowsForChapter(chapter, chapterIndex);
    const rows: ScrollRow[] = [];
    for (let ci = chainStart; ci <= chainEnd && ci < chapters.length; ci++) {
      const ch = chapters[ci];
      if (!ch) continue;
      rows.push(...rowsForChapter(ch, ci));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, chapterIndex, chapters, chained, chainStart, chainEnd, scrollCols, splitWide, viewPages]);

  /* 向前扩展链式窗口后，把滚动位置补上新增内容的高度，保持视觉不跳动 */
  useLayoutEffect(() => {
    const comp = pendingScrollComp.current;
    if (!comp) return;
    const el = stageRef.current;
    if (el) el.scrollTop = comp.topBefore + Math.max(0, el.scrollHeight - comp.heightBefore);
    pendingScrollComp.current = null;
  }, [chainStart]);

  /* 在线阅读：切到空章节时按需拉取页面（ensurePages 由父组件提供并回填 chapters） */
  const [lazyLoading, setLazyLoading] = useState(false);
  const lazyKey = useRef('');
  useEffect(() => {
    if (!ensurePages) return;
    const ch = chapters[chapterIndex];
    if (!ch || ch.pages.length) {
      setLazyLoading(false);
      return;
    }
    if (lazyKey.current === ch.id) return;
    lazyKey.current = ch.id;
    setLazyLoading(true);
    Promise.resolve(ensurePages(ch))
      .catch(() => {})
      .finally(() => setLazyLoading(false));
  }, [chapters, chapterIndex, ensurePages]);

  const filterCss = useMemo(() => {
    const parts = [`brightness(${brightness.toFixed(2)})`, `contrast(${contrast.toFixed(2)})`];
    if (filter === 'warm') parts.push('sepia(0.42)', 'saturate(0.86)', 'hue-rotate(-10deg)');
    if (filter === 'invert') parts.push('invert(1)', 'hue-rotate(180deg)');
    if (filter === 'gray') parts.push('grayscale(1)');
    return parts.join(' ');
  }, [filter, brightness, contrast]);

  /* ---------- 工具栏显隐：只由明确点击驱动 ---------- */
  const clearHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);
  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => {
      uiRef.current = false;
      setUiVisible(false);
    }, 4200);
  }, [clearHide]);
  const showUi = useCallback(() => {
    uiRef.current = true;
    setUiVisible(true);
    clearHide();
    if (!panel) scheduleHide();
  }, [clearHide, scheduleHide, panel]);
  const hideUi = useCallback(() => {
    uiRef.current = false;
    setUiVisible(false);
    clearHide();
  }, [clearHide]);
  const toggleUi = useCallback(() => {
    if (uiRef.current) hideUi();
    else showUi();
  }, [hideUi, showUi]);

  useEffect(() => {
    return () => clearHide();
  }, [clearHide]);

  /* 面板打开时不要自动收起，避免操作到一半菜单消失 */
  useEffect(() => {
    if (panel) clearHide();
    else if (uiRef.current) scheduleHide();
  }, [panel, clearHide, scheduleHide]);

  /* ---------- 偏好持久化：只在设置真的变化时按当前作用范围写入 ---------- */
  const lastSaved = useRef('');
  useEffect(() => {
    if (saveFirst.current) {
      saveFirst.current = false;
      /* 记录初始值，切话时不再重复写入 */
      lastSaved.current = JSON.stringify({ prefScope, mode, fit, direction, filter, brightness, contrast, smartDouble, keepPageOrder, scrollCols, splitWide, linkChapters });
      return;
    }
    const snapshot: ReaderPrefs = { mode, fit, direction, filter, brightness, contrast, smartDouble, keepPageOrder, scrollCols, splitWide, linkChapters };
    const sig = JSON.stringify({ prefScope, ...snapshot });
    if (sig === lastSaved.current) return;   /* 切话 / 无关渲染不写 */
    lastSaved.current = sig;
    try {
      localStorage.setItem(SCOPE_KEY, prefScope);
      localStorage.setItem(prefKey(prefScope, comicKey, chapter?.id || ''), JSON.stringify(snapshot));
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [prefScope, mode, fit, direction, filter, brightness, contrast, smartDouble, keepPageOrder, scrollCols, splitWide, linkChapters, comicKey, chapter?.id]);

  /* 「仅本话」范围：切到另一话时，载入那一话自己的记忆 */
  const lastChapterId = useRef(chapter?.id || '');
  useEffect(() => {
    const id = chapter?.id || '';
    if (id === lastChapterId.current) return;
    lastChapterId.current = id;
    if (prefScope !== 'chapter') return;
    const p = loadEffective(comicKey, id, initialDirection);
    setMode(p.mode); setFit(p.fit); setDirection(p.direction);
    setFilter(p.filter); setBrightness(p.brightness); setContrast(p.contrast);
    setSmartDouble(p.smartDouble); setKeepPageOrder(p.keepPageOrder !== false);
    setScrollCols(scrollColsOf(p)); setSplitWide(!!p.splitWide); setLinkChapters(!!p.linkChapters);
  }, [chapter?.id, prefScope, comicKey, initialDirection]);

  /** 切换作用范围：清掉更细粒度的旧覆盖，让新范围立即生效 */
  function changeScope(next: Scope) {
    try {
      localStorage.removeItem(`${PREFS_KEY}:chapter:${chapter?.id || ''}`);
      localStorage.removeItem(`${PREFS_KEY}:comic:${comicKey}`);
      if (next === 'all') localStorage.removeItem(SCOPE_KEY);
    } catch {
      /* 忽略 */
    }
    setPrefScope(next);
    toast(
      next === 'all' ? '设置已应用到全部漫画' : next === 'comic' ? '设置已应用到这本漫画' : '设置已应用到当前这一话',
      'ok',
    );
  }

  const chapterProgress = total ? Math.min(100, Math.round(((pageIndex + 1) / total) * 100)) : 0;

  useEffect(() => {
    if (!chapter || !onProgress) return;
    const orig = viewPages[pageIndex]?.origIdx ?? pageIndex;
    const t = setTimeout(() => onProgress(chapter.id, orig), 400);
    return () => clearTimeout(t);
  }, [chapter, pageIndex, onProgress, viewPages]);

  /* 手机端首次进入提示：点中间唤出菜单、左右滑动翻页 */
  useEffect(() => {
    const isTouch = 'ontouchstart' in window || window.matchMedia('(max-width: 720px)').matches;
    if (!isTouch) return;
    try {
      if (localStorage.getItem('cv-tap-hint')) return;
    } catch {
      return;
    }
    setSwipeHint(true);
    const t = setTimeout(() => {
      setSwipeHint(false);
      try {
        localStorage.setItem('cv-tap-hint', '1');
      } catch {
        /* 忽略 */
      }
    }, 3800);
    return () => clearTimeout(t);
  }, []);

  /* 预加载后续页面 */
  useEffect(() => {
    if (!chapter) return;
    for (let i = 1; i <= 3; i++) {
      const m = viewPages[pageIndex + i];
      if (m?.p.url) {
        const img = new Image();
        img.src = m.p.url;
      }
    }
  }, [viewPages, pageIndex]);

  /** AI 翻译当前屏：对每个原页调用服务端翻译（看图翻译+原位渲染），结果按 origIdx 缓存。
      只有非中文生肉才需要；译文图是服务端生成的 PNG，直接替换 img 源，不改原始数据。 */
  async function translateCurrent() {
    const pages = uniqueSourcePages().filter((x) => x.p.url);
    if (!pages.length) { toast('这一页还没有图片', 'err'); return; }
    setTranslateOn(true);
    const todo = pages.filter((x) => !translated[x.idx]);
    if (!todo.length) { toast('本页已翻译'); return; }
    setTranslating(new Set(todo.map((x) => x.idx)));
    let ok = 0;
    for (const { p, idx } of todo) {
      try {
        const r = await translation.page(p.url!);
        setTranslated((m) => ({ ...m, [idx]: r.url.startsWith('/') ? new URL(r.url, location.origin).href : r.url }));
        ok += 1;
      } catch (err) {
        toast(`第 ${idx + 1} 页翻译失败：${(err as Error)?.message || '请检查翻译设置'}`, 'err');
      }
    }
    setTranslating(new Set());
    if (ok) toast(`已翻译 ${ok} 页（译文在原位显示）`);
  }

  /** 当前屏涉及的"原页"去重列表（拆分后的左右半指向同一原页，只算一次） */
  function uniqueSourcePages(): { p: Page; idx: number }[] {
    const seen = new Set<number>();
    const out: { p: Page; idx: number }[] = [];
    for (const m of currentPages) {
      if (seen.has(m.origIdx)) continue;
      seen.add(m.origIdx);
      out.push({ p: m.p, idx: m.origIdx });
    }
    if (!out.length && chapter?.pages[pageIndex]) out.push({ p: chapter.pages[pageIndex], idx: pageIndex });
    return out;
  }

  async function saveCurrentPage() {
    /* 双页对开且当前是两页：先问用户要合并下载还是单页下载，避免只存到一张 */
    if (mode === 'double' && uniqueSourcePages().length === 2) {
      setSaveChoice(true);
      return;
    }
    const first = uniqueSourcePages()[0];
    if (!first?.p.url) {
      toast('这一页还没有图片', 'err');
      return;
    }
    const name = `${title}-${chapter?.title || '漫画'}-第${first.idx + 1}页`;
    const ok = await saveImageToDevice(first.p.url, name);
    toast(ok ? '本页图片已保存' : '已打开图片，可长按保存', ok ? 'ok' : 'err');
  }

  /** 单页下载：把对开的原页分别保存为两张原图 */
  async function saveSpreadAsSingle() {
    setSaveChoice(false);
    const pages = uniqueSourcePages();
    let okAll = true;
    for (const { p, idx } of pages) {
      if (!p?.url) continue;
      const name = `${title}-${chapter?.title || '漫画'}-第${idx + 1}页`;
      const ok = await saveImageToDevice(p.url, name);
      if (!ok) okAll = false;
    }
    toast(okAll ? `已分别保存 ${pages.length} 张单页` : '部分图片未保存，可长按保存', okAll ? 'ok' : 'err');
  }

  /** 合并下载：按当前双页对开的顺序把两页横向拼成一张长图 */
  async function saveSpreadAsMerged() {
    setSaveChoice(false);
    try {
      const sources = uniqueSourcePages().map((x) => x.p);
      const imgs = await Promise.all(sources.map((p) => new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = p.url || '';
      })));
      const h = Math.max(...imgs.map((im) => im.height));
      const canvas = document.createElement('canvas');
      canvas.width = imgs.reduce((n, im) => n + im.width, 0);
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 不可用');
      let x = 0;
      for (const im of imgs) {
        ctx.drawImage(im, x, Math.floor((h - im.height) / 2));
        x += im.width;
      }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const name = `${title}-${chapter?.title || '漫画'}-第${pageIndex + 1}至${pageIndex + currentPages.length}页-双页合并`;
      const ok = await saveImageToDevice(dataUrl, name);
      toast(ok ? '双页合并图已保存' : '已打开图片，可长按保存', ok ? 'ok' : 'err');
    } catch {
      toast('合并保存失败，已改为分别保存两张', 'err');
      await saveSpreadAsSingle();
    }
  }

  /** 切换上一话 / 下一话。翻页绝不弹出工具栏 */
  const goChapter = useCallback((delta: number) => {
    const next = chapterIndex + delta;
    if (next < 0 || next >= chapters.length) return;
    setLoaded(false);
    setScrollRatio(0);
    setChapterIndex(next);
    setPageIndex(0);
    chainTip.current = { start: next, end: next };
    setChainStart(next); setChainEnd(next);
    requestAnimationFrame(() => stageRef.current?.scrollTo?.(0, 0));
  }, [chapterIndex, chapters.length]);

  const goNext = useCallback(() => {
    if (!chapter) return;
    setLoaded(false);
    if (mode === 'double') {
      // 跨页独占一屏：直接跳到下一屏的第一页，保证对齐一致（不会因跨页落在奇数位而并排）
      const nextStart = (doubleScreens[screenIndex + 1] || [])[0];
      if (nextStart !== undefined) { setPageIndex(nextStart); return; }
      if (linkChapters && chapterIndex < chapters.length - 1) {
        setChapterIndex(chapterIndex + 1); setPageIndex(0);
      }
      return;
    }
    if (pageIndex + step <= total - 1) {
      setPageIndex(pageIndex + step);
    } else if (linkChapters && chapterIndex < chapters.length - 1) {
      setChapterIndex(chapterIndex + 1);
      setPageIndex(0);
    }
  }, [chapter, pageIndex, step, total, chapterIndex, chapters.length, linkChapters, mode, doubleScreens, screenIndex]);

  const goPrev = useCallback(() => {
    if (!chapter) return;
    setLoaded(false);
    if (mode === 'double') {
      const prevStart = (doubleScreens[screenIndex - 1] || [])[0];
      if (prevStart !== undefined) { setPageIndex(prevStart); return; }
      if (screenIndex <= 0 && pageIndex > 0) { setPageIndex(doubleScreens[0]?.[0] ?? 0); return; }
      if (chapterIndex > 0) {
        const prev = chapters[chapterIndex - 1];
        // 跳到上一话的「最后一屏」：跨页独占时落在跨页本身，普通双页落在成对的第一页
        const lastScreen = smartDouble ? lastScreenStart(prev, true) : prev.pages.length - 1;
        setChapterIndex(chapterIndex - 1);
        setPageIndex(Math.max(0, mode !== 'double' ? prev.pages.length - 1 : lastScreen));
      }
      return;
    }
    let back = step;
    if (pageIndex - back >= 0) {
      setPageIndex(pageIndex - back);
    } else if (pageIndex > 0) {
      setPageIndex(0);
    } else if (chapterIndex > 0) {
      const prev = chapters[chapterIndex - 1];
      setChapterIndex(chapterIndex - 1);
      setPageIndex(Math.max(0, prev.pages.length - 1));
    }
  }, [chapter, pageIndex, step, chapterIndex, chapters, mode, doubleScreens, screenIndex, smartDouble]);

  /* 键盘操作：翻页不会弹出工具栏 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key;
      if (k === 'ArrowRight' || k === 'PageDown') {
        rtl ? goPrev() : goNext();
      } else if (k === 'ArrowLeft' || k === 'PageUp') {
        rtl ? goNext() : goPrev();
      } else if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        goNext();
      } else if (k === 'f' || k === 'F') {
        toggleFullscreen();
      } else if (k === 'm' || k === 'M') {
        setPanel((p) => (p === 'toc' ? null : 'toc'));
      } else if (k === 'p' || k === 'P') {
        setPanel((p) => (p === 'pages' ? null : 'pages'));
      } else if (k === 'd' || k === 'D') {
        setMode((m) => (m === 'double' ? 'single' : 'double'));
      } else if (k === 'r' || k === 'R') {
        setDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'));
      } else if (k === 'w' || k === 'W') {
        setFilter((f) => (f === 'none' ? 'warm' : f === 'warm' ? 'invert' : f === 'invert' ? 'gray' : 'none'));
      } else if (k === '+') {
        setZoom((z) => Math.min(4, z + 0.2));
      } else if (k === '-' || k === '_') {
        setZoom((z) => Math.max(0.4, z - 0.2));
      } else if (k === '[') {
        goChapter(-1);
      } else if (k === ']') {
        goChapter(1);
      } else if (k === '?' || k === '/') {
        setHelp((h) => !h);
      } else if (k === 'Escape') {
        if (panel || help) {
          setPanel(null);
          setHelp(false);
        } else onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goChapter, rtl, panel, help, onExit]);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  /** 明确的一次轻点：面板打开时点面板外画面只收起面板（不翻页）；正中间矩形才切换工具栏 */
  function handleTap(clientX: number, clientY: number, el: HTMLElement) {
    if (panel || help) {
      setPanel(null);
      setHelp(false);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);
    if (x > 0.32 && x < 0.68 && y > 0.2 && y < 0.8) {
      toggleUi();
      return;
    }
    if (mode === 'continuous' || mode === 'webtoon') return;
    const leftSide = x < 0.5;
    if (rtl) leftSide ? goNext() : goPrev();
    else leftSide ? goPrev() : goNext();
  }

  function onStageClick(e: React.MouseEvent) {
    if (Date.now() < suppressUntil.current) return;
    handleTap(e.clientX, e.clientY, e.currentTarget as HTMLElement);
  }

  /* 手机端：滑动只翻页/滚动，绝不唤出工具栏；轻点才走 handleTap。
     触摸起点在按键 / 面板 / 弹窗等 UI 上时直接放行——之前面板里的 chip、
     底部翻页键都会被这里抢先处理成「关面板 + 翻页」，导致模式切不动。 */
  /* 浏览器（尤其手机 Chrome / 平板）会把横向滑动识别成「侧滑返回 / 前进」导航手势，
     表现为翻页时突然退出阅读器。React 的 onTouchMove 是 passive 监听，preventDefault
     无效，必须挂原生非 passive 监听。只在阅读画面内、明显横向手势时拦截；
     纵向滚动（连续 / 条漫）与双指缩放完全放行。 */
  useEffect(() => {
    let sx = 0;
    let sy = 0;
    let onStage = false;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      onStage = !!t && !!(e.target as HTMLElement | null)?.closest?.('.reader-stage');
      if (t) { sx = t.clientX; sy = t.clientY; }
    };
    const move = (e: TouchEvent) => {
      if (!onStage || !e.cancelable) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) e.preventDefault();
    };
    const end = () => { onStage = false; };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, []);

  function onTouchBegin(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    touchOnUi.current = !!(e.target as HTMLElement)?.closest?.(
      'button, .reader-panel, .reader-top, .reader-bottom, .modal, select, input, .webtoon-edge, .swipe-hint',
    );
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = touchStart.current;
    if (!s) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) s.moved = true;
  }

  function onTouchFinish(e: React.TouchEvent) {
    const onUi = touchOnUi.current;
    touchOnUi.current = false;
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || onUi) return; /* UI 上的触摸：按键自己的 onClick 全权处理 */
    const t = e.changedTouches[0];
    if (!t) return;
    /* 触摸产生的合成 click 一律屏蔽，改由这里精确判定，避免滑动后双击 */
    suppressUntil.current = Date.now() + 500;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dist = Math.hypot(dx, dy);
    const dur = Date.now() - start.t;
    const horizontalSwipe = Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && dur <= 900;
    if (start.moved || horizontalSwipe) {
      if (horizontalSwipe && mode !== 'continuous' && mode !== 'webtoon') {
        if (dx < 0) rtl ? goNext() : goPrev();
        else rtl ? goPrev() : goNext();
      }
      return; /* 滑动 / 滚动：不弹按键 */
    }
    if (dist <= 14 && dur <= 500) {
      handleTap(t.clientX, t.clientY, stageRef.current || (e.currentTarget as HTMLElement));
    }
  }

  function onContinuousScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (!total) return;
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    setScrollRatio(ratio);
    /* 链式连续跨章：滚动到窗口下沿追加下一话，滚动到上沿追加上一话，全程不跳变。 */
    if (chained) {
      if (ratio >= 0.985 && chainTip.current.end < chapters.length - 1) {
        const next = chainTip.current.end + 1;
        chainTip.current.end = next;
        setChainEnd(next);
      } else if (ratio <= 0.015 && chainTip.current.start > 0) {
        const prev = chainTip.current.start - 1;
        chainTip.current.start = prev;
        pendingScrollComp.current = { heightBefore: el.scrollHeight, topBefore: el.scrollTop };
        setChainStart(prev);
      }
      return;
    }
    setPageIndex(Math.min(total - 1, Math.floor(ratio * total)));
  }

  if (!chapter) {
    return (
      <div className="reader">
        <div className="empty" style={{ margin: 'auto', color: '#999' }}>
          没有可阅读的内容
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={onExit}>返回</button>
          </div>
        </div>
      </div>
    );
  }

  const fitClass = fit === 'width' ? 'fit-width' : fit === 'height' ? 'fit-height' : fit === 'original' ? 'original' : '';
  const editingMedia = currentPages[rtl ? currentPages.length - 1 : 0];
  const editingPage = editingMedia ? chapter?.pages[editingMedia.origIdx] : undefined;

  return (
    <div
      className={`reader${readOnly ? ' reader-readonly' : ''}`}
      onTouchStart={onTouchBegin}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchFinish}
      onTouchCancel={() => { touchStart.current = null; }}
    >
      {/* 沉浸态角落只留一个明确的菜单按钮：点它才显示按键 */}
      {!uiVisible && (
        <button className="reader-peek" onClick={showUi} title="显示阅读菜单" aria-label="显示阅读菜单">
          <Icon name="menu" size={16} />
        </button>
      )}

      <div className={`reader-top ${uiVisible ? '' : 'hidden'}`}>
        <button className="btn sm ghost" onClick={onExit} title="返回">
          <Icon name="left" size={16} /> 返回
        </button>
        <div className="reader-info" style={{ maxWidth: 260 }}>
          {title}
          <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {chapter.title}</span>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button className="btn sm ghost" onClick={saveCurrentPage} title="保存当前这一页图片">
            <Icon name="download" size={15} /> 存本页
          </button>
          <button
            className={`btn sm ${translateOn ? 'primary' : 'ghost'}`}
            onClick={translateCurrent}
            disabled={translating.size > 0}
            title="AI 翻译当前页（生肉→中文，译文排回原位）"
          >
            <Icon name="globe" size={15} /> {translating.size > 0 ? '翻译中…' : translateOn ? '重新翻译' : 'AI 翻译'}
          </button>
          {translateOn && (
            <button className="btn sm ghost" onClick={() => setTranslateOn(false)} title="还原为原图">
              <Icon name="refresh" size={15} /> 还原
            </button>
          )}
          <button
            className={`btn sm ${panel === 'settings' ? 'primary' : 'ghost'}`}
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            title="阅读设置"
          >
            <Icon name="menu" size={15} /> 设置
          </button>
        </div>
        {headerExtra}
      </div>

      {swipeHint && (
        <div className="swipe-hint">
          轻点画面正中唤出菜单 · 左右滑动翻页
        </div>
      )}

      <div
        ref={stageRef}
        className={`reader-stage ${mode} ${fitClass}`}
        onClick={onStageClick}
        onScroll={mode === 'continuous' || mode === 'webtoon' ? onContinuousScroll : undefined}
        style={{ filter: filterCss }}
      >
        {isScroll ? (
          <>
            {!chained && chapterIndex > 0 && (
              <button className="webtoon-edge" onClick={() => goChapter(-1)}>
                ↑ 上一话 · {chapters[chapterIndex - 1].title}
              </button>
            )}
            {scrollRows.map((srow, ri) => (
              <Fragment key={`r-${srow.ci}-${srow.pi}`}>
                {chained && srow.chapterStart && (
                  <div className="chain-chapter-title">
                    {chapters[srow.ci]?.title || `第 ${srow.ci + 1} 话`}
                  </div>
                )}
                <div
                  className={`cont-row ${srow.row.length > 1 ? 'dual' : ''} ${mode === 'webtoon' ? 'wt-row' : ''}`}
                  data-cols={srow.row.length}
                >
                  {srow.row.map((m) => (
                    <PageMedia
                      key={m.key}
                      m={m}
                      className={mode === 'webtoon' ? 'webtoon-page' : 'cont-page'}
                      overrideUrl={translateOn ? translated[m.origIdx] : undefined}
                      alt={mediaIsWide(m) ? '跨页大图' : `${chapters[srow.ci]?.title || ''} 第 ${srow.pi + 1} 页${m.half === 'l' ? '（左）' : m.half === 'r' ? '（右）' : ''}`}
                      loading={ri < 3 ? 'eager' : 'lazy'}
                      style={{ maxWidth: fit === 'original' ? `${zoom * 100}%` : undefined }}
                      draggable={false}
                    />
                  ))}
                </div>
              </Fragment>
            ))}
            {chained && (
              chainEnd >= chapters.length - 1
                ? <div className="webtoon-edge done">— 已经是最后一话 —</div>
                : <div className="webtoon-edge done">继续向下滑动，自动接下一话 ↓</div>
            )}
            {!chained && (
              chapterIndex < chapters.length - 1 ? (
                <button className="webtoon-edge" onClick={() => goChapter(1)}>
                  ↓ 继续下一话 · {chapters[chapterIndex + 1].title}
                </button>
              ) : (
                <div className="webtoon-edge done">— 已经是最后一话 —</div>
              )
            )}
          </>
        ) : (
          currentPages.length ? currentPages.map((m, i) => (
            <PageMedia
              key={m.key}
              m={m}
              className=""
              overrideUrl={translateOn ? translated[m.origIdx] : undefined}
              alt={`第 ${pageIndex + i + 1} 页${m.half === 'l' ? '（左）' : m.half === 'r' ? '（右）' : ''}`}
              draggable={false}
              onLoad={() => setLoaded(true)}
              style={{ opacity: translating.has(m.origIdx) ? 0.5 : loaded ? 1 : 0.6, width: fit === 'original' ? `${zoom * 100}%` : undefined }}
            />
          )) : (
            <div className="reader-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', color: 'var(--text-2, #8899aa)' }}>
              {lazyLoading ? '正在加载本章…' : '这一话还没有页面'}
            </div>
          )
        )}
      </div>

      <div className={`reader-bottom ${uiVisible ? '' : 'hidden'} ${rtl ? 'rtl' : ''}`}>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn sm ghost" onClick={() => goChapter(-1)} disabled={chapterIndex === 0} title="上一话">
            <Icon name={rtl ? 'right' : 'left'} size={15} /> 上一话
          </button>
          {mode !== 'webtoon' && (
            <>
              <button className="btn sm ghost" onClick={goPrev} title="上一页">
                <Icon name={rtl ? 'right' : 'left'} size={15} />
              </button>
              <span className="reader-pageno">
                {pageIndex + 1}
                {mode === 'double' && !currentWide && pageIndex + 1 < total ? `–${pageIndex + 2}` : ''} / {total}
              </span>
              <button className="btn sm ghost" onClick={goNext} title="下一页">
                <Icon name={rtl ? 'left' : 'right'} size={15} />
              </button>
              <input
                className="slider"
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={pageIndex}
                onChange={(e) => setPageIndex(Number(e.target.value))}
              />
            </>
          )}
          {(mode === 'webtoon' || mode === 'continuous') && (
            <>
              <input
                type="range" min={0} max={1000}
                value={Math.round(scrollRatio * 1000)}
                onChange={(e) => {
                  const el = stageRef.current;
                  if (!el) return;
                  const r = Number(e.target.value) / 1000;
                  el.scrollTop = r * Math.max(1, el.scrollHeight - el.clientHeight);
                  setScrollRatio(r);
                }}
                style={{ width: 130 }}
                title="拖动定位阅读进度"
              />
              <span className="reader-pageno">{mode === 'webtoon' ? '条漫' : '上下滚动'} {Math.round(scrollRatio * 100)}%</span>
            </>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={() => goChapter(1)} disabled={chapterIndex === chapters.length - 1} title="下一话">
            下一话 <Icon name={rtl ? 'left' : 'right'} size={15} />
          </button>
          <select
            className="select"
            style={{ width: 150 }}
            value={chapterIndex}
            onChange={(e) => {
              const ci = Number(e.target.value);
              setChapterIndex(ci); setPageIndex(0);
              chainTip.current = { start: ci, end: ci }; setChainStart(ci); setChainEnd(ci);
            }}
          >
            {chapters.map((c, i) => (
              <option key={c.id} value={i}>{c.title}</option>
            ))}
          </select>
          <span className="reader-pageno">{chapterProgress}%</span>
        </div>
      </div>

      {panel && (
        <div className="reader-panel">
          <header>
            <Icon name={panel === 'toc' ? 'list' : panel === 'pages' ? 'grid' : panel === 'settings' ? 'menu' : 'eye'} size={16} />
            {panel === 'toc' ? '目录' : panel === 'pages' ? '页面' : panel === 'settings' ? '阅读设置' : '画面'}
            <button className="btn icon ghost" style={{ marginLeft: 'auto' }} onClick={() => setPanel(null)}>
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="body">
            {panel === 'toc' ? (
              <div className="chapter-list">
                {chapters.map((c, i) => (
                  <div
                    key={c.id}
                    className="chapter-item"
                    style={{ cursor: 'pointer', borderColor: i === chapterIndex ? 'var(--accent)' : undefined }}
                    onClick={() => {
                      setChapterIndex(i); setPageIndex(0);
                      chainTip.current = { start: i, end: i }; setChainStart(i); setChainEnd(i);
                      setPanel(null);
                    }}
                  >
                    <div className="chapter-main">
                      <div className="chapter-title">{c.title}</div>
                      <div className="chapter-sub">{c.pages.length} 页</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : panel === 'pages' ? (
              <div className="thumb-grid">
                {chapter.pages.map((p, i) => (
                  <button key={p.id} className={i === pageIndex ? 'active' : ''}
                    onClick={() => { setPageIndex(i); setPanel(null); }}
                    title={isWide(p) ? '跨页大图' : `第 ${i + 1} 页`}>
                    <img src={p.thumbUrl || p.url} alt="" loading="lazy" />
                    <span className="n">{i + 1}</span>
                    {isWide(p) && <span className="wide-tag">跨页</span>}
                  </button>
                ))}
              </div>
            ) : panel === 'settings' ? (
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <div className="rp-label">翻页模式</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {(['single', 'double'] as Mode[]).map((k) => (
                      <button key={k} className={`chip ${mode === k ? 'active' : ''}`} type="button"
                        onClick={() => { setMode(k); }}>
                        {MODE_LABEL[k]}
                      </button>
                    ))}
                  </div>
                  <div className="rp-note">一屏一页，或左右对开两页；跨页大图会自动独占一屏。</div>
                  <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>保持单页顺序</div>
                      <div className="rp-note">双页对开按 1→2→3 自然顺序显示，不被左右翻页方向镜像打乱</div>
                    </div>
                    <button className={`switch ${keepPageOrder ? 'on' : ''}`} onClick={() => setKeepPageOrder(!keepPageOrder)} aria-label="保持单页顺序">
                      <span className="knob" />
                    </button>
                  </div>
                </div>

                <div>
                  <div className="rp-label">滚动模式（不翻页）</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {(['continuous', 'webtoon'] as Mode[]).map((k) => (
                      <button key={k} className={`chip ${mode === k ? 'active' : ''}`} type="button"
                        onClick={() => { setMode(k); if (k === 'webtoon') setFit('width'); }}>
                        {MODE_LABEL[k]}
                      </button>
                    ))}
                  </div>
                  <div className="rp-note">上下滚动：一页一页往下滚，页与页之间有空隙；条漫：零间隙连成长条，适合条漫作品。</div>
                  <div style={{ marginTop: 10 }}>
                    <div className="rp-label" style={{ marginBottom: 6 }}>滚动并排页数（合并显示）</div>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {[1, 2, 3, 4].map((n) => (
                        <button key={n} className={`chip ${scrollCols === n ? 'active' : ''}`} type="button"
                          onClick={() => setScrollCols(n)}>
                          {n === 1 ? '单列不合并' : `${n} 页并排`}
                        </button>
                      ))}
                    </div>
                    <div className="rp-note">滚动 / 条漫下把每 N 页并成一行；跨页大图自动独占一行。页序始终按 1→2→3，不受翻页方向影响。</div>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>连续跨章</div>
                      <div className="rp-note">滚动时下一话无缝接在后面、往上滑回到上一话；关闭则一次只看一话</div>
                    </div>
                    <button className={`switch ${linkChapters ? 'on' : ''}`} onClick={() => {
                      const v = !linkChapters;
                      setLinkChapters(v);
                      if (v) { chainTip.current = { start: chapterIndex, end: chapterIndex }; setChainStart(chapterIndex); setChainEnd(chapterIndex); }
                    }} aria-label="连续跨章">
                      <span className="knob" />
                    </button>
                  </div>
                </div>

                <div>
                  <div className="rp-label">翻页方向</div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className={`btn sm ${rtl ? 'ghost' : 'primary'}`} onClick={() => setDirection('ltr')}>
                      ← 从左往右
                    </button>
                    <button className={`btn sm ${rtl ? 'primary' : 'ghost'}`} onClick={() => setDirection('rtl')}>
                      从右往左 →
                    </button>
                  </div>
                  <div className="rp-note">从右往左时，底部按键与箭头会跟着镜像调换；滚动模式下方向不参与。</div>
                </div>

                <div>
                  <div className="rp-label">设置应用范围（会记住）</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {([
                      ['all', '全部漫画'],
                      ['comic', '仅这本'],
                      ['chapter', '仅本话'],
                    ] as [Scope, string][]).map(([k, label]) => (
                      <button key={k} className={`chip ${prefScope === k ? 'active' : ''}`} type="button"
                        onClick={() => changeScope(k)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="rp-note">
                    {prefScope === 'all'
                      ? '当前设置会记住并应用到所有漫画。'
                      : prefScope === 'comic'
                        ? '当前设置只记住并应用到这本漫画的所有话。'
                        : '当前设置只记住并应用到当前这一话。'}
                  </div>
                </div>

                <div>
                  <div className="rp-label">界面主题（分享阅读同样生效）</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {THEMES.map((t) => (
                      <button key={t.id} className={`chip ${uiTheme === t.id ? 'active' : ''}`} type="button"
                        onClick={() => changeTheme(t.id)} title={t.label}>
                        <span className="theme-dot" style={{ background: t.swatch[1] }} /> {t.label}
                      </button>
                    ))}
                  </div>
                  <div className="rp-note">阅读器背景、按键与面板都会跟着主题变化；分享页的访客也能自己选。</div>
                </div>

                <div>
                  <div className="rp-label">页面适配</div>
                  <select className="select" value={fit} onChange={(e) => setFit(e.target.value as Fit)}>
                    <option value="contain">适应屏幕</option>
                    <option value="width">适应宽度</option>
                    <option value="height">适应高度</option>
                    <option value="original">原始尺寸</option>
                  </select>
                  {fit === 'original' && (
                    <div className="row" style={{ gap: 4, marginTop: 8 }}>
                      <button className="btn sm ghost" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
                        <Icon name="zoom" size={14} /> 缩小
                      </button>
                      <span style={{ fontSize: 12, width: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                      <button className="btn sm ghost" onClick={() => setZoom((z) => Math.min(4, z + 0.2))}>
                        <Icon name="plus" size={14} /> 放大
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <div className="rp-label">更多功能</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn sm ghost" onClick={() => setPanel('filter')}>
                      <Icon name="eye" size={15} /> 画面滤镜
                    </button>
                    <button className="btn sm ghost" onClick={() => setPanel('toc')}>
                      <Icon name="list" size={15} /> 章节目录
                    </button>
                    <button className="btn sm ghost" onClick={() => setPanel('pages')}>
                      <Icon name="grid" size={15} /> 页面导航
                    </button>
                    <button className="btn sm ghost" onClick={toggleFullscreen}>
                      <Icon name="fullscreen" size={15} /> 全屏
                    </button>
                    {!readOnly && comicId && (
                      <button className="btn sm ghost" onClick={() => { setEditing(true); setPanel(null); }}>
                        <Icon name="edit" size={15} /> 旋转 / 裁剪
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={saveCurrentPage}>
                      <Icon name="download" size={15} /> 存本页
                    </button>
                  </div>
                </div>

                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>智能双页</div>
                    <div className="rp-note">识别跨页大图并让它独占一屏</div>
                  </div>
                  <button className={`switch ${smartDouble ? 'on' : ''}`} onClick={() => setSmartDouble(!smartDouble)} aria-label="智能双页">
                    <span className="knob" />
                  </button>
                </div>

                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>跨页拆成单页</div>
                    <div className="rp-note">观看时把合并的跨页还原成左右两张单页，随时可关掉复原</div>
                  </div>
                  <button className={`switch ${splitWide ? 'on' : ''}`} onClick={() => setSplitWide(!splitWide)} aria-label="跨页拆成单页">
                    <span className="knob" />
                  </button>
                </div>

                <div className="rp-tip">
                  轻点画面<strong>正中间</strong>显示 / 收起菜单；左右区域点击翻页；滑动、滚轮、翻页都不会弹出按键。
                </div>

                <div className="help-grid">
                  <div><span className="kbd">← →</span> 翻页</div>
                  <div><span className="kbd">空格</span> 下一页</div>
                  <div><span className="kbd">D</span> 单页 / 双页</div>
                  <div><span className="kbd">R</span> 切换方向</div>
                  <div><span className="kbd">W</span> 切换滤镜</div>
                  <div><span className="kbd">M</span> 目录</div>
                  <div><span className="kbd">P</span> 页面</div>
                  <div><span className="kbd">[ ]</span> 上一话 / 下一话</div>
                  <div><span className="kbd">F</span> 全屏</div>
                  <div><span className="kbd">?</span> 快捷键</div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                <div>
                  <div className="rp-label">画面滤镜（W 键循环）</div>
                  <div className="row" style={{ gap: 8 }}>
                    {(Object.keys(FILTER_LABEL) as ReaderFilter[]).map((f) => (
                      <button key={f} className={`chip ${filter === f ? 'active' : ''}`}
                        onClick={() => setFilter(f)} type="button">
                        {FILTER_LABEL[f]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>亮度 {Math.round(brightness * 100)}%</label>
                  <input className="slider" type="range" min={50} max={150} step={5}
                    value={Math.round(brightness * 100)} onChange={(e) => setBrightness(Number(e.target.value) / 100)} />
                </div>
                <div className="field">
                  <label>对比度 {Math.round(contrast * 100)}%</label>
                  <input className="slider" type="range" min={50} max={180} step={5}
                    value={Math.round(contrast * 100)} onChange={(e) => setContrast(Number(e.target.value) / 100)} />
                </div>
                <button className="btn sm ghost" onClick={() => { setFilter('none'); setBrightness(1); setContrast(1); }}>
                  <Icon name="refresh" size={14} /> 恢复默认画面
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {editing && comicId && editingPage && (
        <PageEditor
          comicId={comicId}
          chapter={chapter}
          page={editingPage}
          direction={direction}
          onClose={() => setEditing(false)}
          onDone={(updated) => { setEditing(false); onPagesChanged?.(updated); }}
        />
      )}

      {saveChoice && (
        <div className="backdrop" onClick={() => setSaveChoice(false)}>
          <div className="modal" style={{ width: 'min(400px, 92vw)' }}>
            <div className="modal-head"><Icon name="download" /><h3>保存本页</h3></div>
            <div className="modal-body">
              <div className="rp-note" style={{ marginTop: 0 }}>
                当前是双页对开显示（第 {pageIndex + 1}、{pageIndex + 2} 页），想怎么保存？
              </div>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button className="btn primary" onClick={saveSpreadAsMerged}>
                  <Icon name="download" size={15} /> 合并下载（拼成一张）
                </button>
                <button className="btn" onClick={saveSpreadAsSingle}>
                  <Icon name="download" size={15} /> 单页下载（存两张）
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {help && (
        <div className="backdrop" onClick={() => setHelp(false)}>
          <div className="modal" style={{ width: 'min(520px, 92vw)' }}>
            <div className="modal-head"><Icon name="menu" /><h3>快捷键</h3></div>
            <div className="modal-body">
              <div className="help-grid">
                <div><span className="kbd">← →</span> 上一页 / 下一页</div>
                <div><span className="kbd">空格</span> 下一页</div>
                <div><span className="kbd">D</span> 单页 / 双页切换</div>
                <div><span className="kbd">R</span> 阅读方向 LTR / RTL</div>
                <div><span className="kbd">W</span> 护眼 / 反色 / 黑白</div>
                <div><span className="kbd">M</span> 章节目录</div>
                <div><span className="kbd">P</span> 页面缩略图</div>
                <div><span className="kbd">[ ]</span> 上一话 / 下一话</div>
                <div><span className="kbd">F</span> 全屏</div>
                <div><span className="kbd">+/−</span> 缩放</div>
                <div><span className="kbd">Esc</span> 关闭面板 / 退出</div>
                <div><span className="kbd">?</span> 显示本帮助</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
