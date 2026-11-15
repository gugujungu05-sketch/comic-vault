import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Chapter, ReaderFilter, ReaderPrefs } from '../types';
import { Icon } from './Icon';
import { PageEditor } from './PageEditor';
import { saveImageToDevice } from '../lib/util';
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
};

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
  const [zoom, setZoom] = useState(1);

  /* 沉浸式：默认隐藏工具栏。只有「轻点画面正中间」或角落菜单按钮才切换 */
  const [uiVisible, setUiVisible] = useState(false);
  const uiRef = useRef(false);
  const [panel, setPanel] = useState<'toc' | 'pages' | 'filter' | 'settings' | null>(null);
  const [help, setHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveChoice, setSaveChoice] = useState(false);
  const [swipeHint, setSwipeHint] = useState(false);
  const [scrollRatio, setScrollRatio] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressUntil = useRef(0);
  const touchStart = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const saveFirst = useRef(true);

  const chapter = chapters[chapterIndex];
  const total = chapter?.pages.length || 0;
  const rtl = direction === 'rtl';

  const currentWide = mode === 'double' && smartDouble && !!chapter?.pages[pageIndex]?.wide;
  const step = mode === 'double' ? (currentWide ? 1 : 2) : 1;

  const currentPages = useMemo(() => {
    if (!chapter) return [];
    if (mode !== 'double') return [chapter.pages[pageIndex]].filter(Boolean);
    const a = chapter.pages[pageIndex];
    if (smartDouble && a?.wide) return [a];
    const b = chapter.pages[pageIndex + 1];
    const pair = [a, b].filter(Boolean);
    return rtl ? [...pair].reverse() : pair;
  }, [chapter, pageIndex, mode, rtl, smartDouble]);

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
      lastSaved.current = JSON.stringify({ prefScope, mode, fit, direction, filter, brightness, contrast, smartDouble });
      return;
    }
    const snapshot: ReaderPrefs = { mode, fit, direction, filter, brightness, contrast, smartDouble };
    const sig = JSON.stringify({ prefScope, ...snapshot });
    if (sig === lastSaved.current) return;   /* 切话 / 无关渲染不写 */
    lastSaved.current = sig;
    try {
      localStorage.setItem(SCOPE_KEY, prefScope);
      localStorage.setItem(prefKey(prefScope, comicKey, chapter?.id || ''), JSON.stringify(snapshot));
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [prefScope, mode, fit, direction, filter, brightness, contrast, smartDouble, comicKey, chapter?.id]);

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
    setSmartDouble(p.smartDouble);
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
    const t = setTimeout(() => onProgress(chapter.id, pageIndex), 400);
    return () => clearTimeout(t);
  }, [chapter, pageIndex, onProgress]);

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
      const p = chapter.pages[pageIndex + i];
      if (p?.url) {
        const img = new Image();
        img.src = p.url;
      }
    }
  }, [chapter, pageIndex]);

  async function saveCurrentPage() {
    /* 双页对开且当前是两页：先问用户要合并下载还是单页下载，避免只存到一张 */
    if (mode === 'double' && currentPages.length === 2 && currentPages[1]?.url) {
      setSaveChoice(true);
      return;
    }
    const p = currentPages[0] || chapter?.pages[pageIndex];
    if (!p?.url) {
      toast('这一页还没有图片', 'err');
      return;
    }
    const name = `${title}-${chapter?.title || '漫画'}-第${pageIndex + 1}页`;
    const ok = await saveImageToDevice(p.url, name);
    toast(ok ? '本页图片已保存' : '已打开图片，可长按保存', ok ? 'ok' : 'err');
  }

  /** 单页下载：把对开的两页分别保存为两张原图 */
  async function saveSpreadAsSingle() {
    setSaveChoice(false);
    let okAll = true;
    for (let i = 0; i < currentPages.length; i++) {
      const p = currentPages[i];
      if (!p?.url) continue;
      const name = `${title}-${chapter?.title || '漫画'}-第${pageIndex + i + 1}页`;
      const ok = await saveImageToDevice(p.url, name);
      if (!ok) okAll = false;
    }
    toast(okAll ? `已分别保存 ${currentPages.length} 张单页` : '部分图片未保存，可长按保存', okAll ? 'ok' : 'err');
  }

  /** 合并下载：按当前双页对开的顺序把两页横向拼成一张长图 */
  async function saveSpreadAsMerged() {
    setSaveChoice(false);
    try {
      const imgs = await Promise.all(currentPages.map((p) => new Promise<HTMLImageElement>((resolve, reject) => {
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
    requestAnimationFrame(() => stageRef.current?.scrollTo?.(0, 0));
  }, [chapterIndex, chapters.length]);

  const goNext = useCallback(() => {
    if (!chapter) return;
    setLoaded(false);
    if (pageIndex + step <= total - 1) {
      setPageIndex(pageIndex + step);
    } else if (chapterIndex < chapters.length - 1) {
      setChapterIndex(chapterIndex + 1);
      setPageIndex(0);
    }
  }, [chapter, pageIndex, step, total, chapterIndex, chapters.length]);

  const goPrev = useCallback(() => {
    if (!chapter) return;
    setLoaded(false);
    let back = step;
    if (mode === 'double' && smartDouble && chapter.pages[pageIndex - 1]?.wide) back = 1;
    if (pageIndex - back >= 0) {
      setPageIndex(pageIndex - back);
    } else if (pageIndex > 0) {
      setPageIndex(0);
    } else if (chapterIndex > 0) {
      const prev = chapters[chapterIndex - 1];
      const last = prev.pages.length - 1;
      setChapterIndex(chapterIndex - 1);
      setPageIndex(Math.max(0, prev.pages[last]?.wide || mode !== 'double' ? last : last - 1));
    }
  }, [chapter, pageIndex, step, chapterIndex, chapters, mode, smartDouble]);

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

  /* 手机端：滑动只翻页/滚动，绝不唤出工具栏；轻点才走 handleTap */
  function onTouchBegin(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
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
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
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
  const editingPage = currentPages[rtl ? currentPages.length - 1 : 0];

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
            className={`btn sm ${panel === 'settings' ? 'primary' : 'ghost'}`}
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            title="阅读设置"
          >
            <Icon name="menu" size={15} /> 设置
          </button>
          </div>
          {headerExtra}
        </div>
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
        {mode === 'continuous' ? (
          chapter.pages.map((p, i) => (
            <img
              key={p.id}
              className="cont-page"
              src={p.url}
              alt={`第 ${i + 1} 页`}
              loading={i < 3 ? 'eager' : 'lazy'}
              style={{ maxWidth: fit === 'original' ? `${zoom * 100}%` : undefined }}
              draggable={false}
            />
          ))
        ) : mode === 'webtoon' ? (
          <>
            {chapterIndex > 0 && (
              <button className="webtoon-edge" onClick={() => goChapter(-1)}>
                ↑ 上一话 · {chapters[chapterIndex - 1].title}
              </button>
            )}
            {chapter.pages.map((p, i) => (
              <img key={p.id} className="webtoon-page" src={p.url} alt={`第 ${i + 1} 页`}
                loading={i < 3 ? 'eager' : 'lazy'} draggable={false} />
            ))}
            {chapterIndex < chapters.length - 1 ? (
              <button className="webtoon-edge" onClick={() => goChapter(1)}>
                ↓ 下一话 · {chapters[chapterIndex + 1].title}
              </button>
            ) : (
              <div className="webtoon-edge done">— 已经是最后一话 —</div>
            )}
          </>
        ) : (
          currentPages.map((p, i) => (
            <img
              key={p.id}
              src={p.url}
              alt={`第 ${pageIndex + i + 1} 页`}
              draggable={false}
              onLoad={() => setLoaded(true)}
              style={{ opacity: loaded ? 1 : 0.6, width: fit === 'original' ? `${zoom * 100}%` : undefined }}
            />
          ))
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
              <span className="reader-pageno">上下滚动 {Math.round(scrollRatio * 100)}%</span>
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
            onChange={(e) => { setChapterIndex(Number(e.target.value)); setPageIndex(0); }}
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
                    onClick={() => { setChapterIndex(i); setPageIndex(0); setPanel(null); }}
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
                    title={p.wide ? '跨页大图' : `第 ${i + 1} 页`}>
                    <img src={p.thumbUrl || p.url} alt="" loading="lazy" />
                    <span className="n">{i + 1}</span>
                    {p.wide && <span className="wide-tag">跨页</span>}
                  </button>
                ))}
              </div>
            ) : panel === 'settings' ? (
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <div className="rp-label">阅读模式</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {(['single', 'double', 'continuous', 'webtoon'] as Mode[]).map((k) => (
                      <button key={k} className={`chip ${mode === k ? 'active' : ''}`} type="button"
                        onClick={() => { setMode(k); if (k === 'webtoon') setFit('width'); }}>
                        {MODE_LABEL[k]}
                      </button>
                    ))}
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
                  <div className="rp-note">从右往左时，底部按键与箭头会跟着镜像调换。</div>
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
