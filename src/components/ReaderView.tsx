import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Chapter } from '../types';
import { Icon } from './Icon';

type Mode = 'single' | 'double' | 'continuous';
type Fit = 'contain' | 'width' | 'height' | 'original';

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
}) {
  const [chapterIndex, setChapterIndex] = useState(() => {
    const i = chapters.findIndex((c) => c.id === initialChapterId);
    return i >= 0 ? i : 0;
  });
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [direction, setDirection] = useState<'ltr' | 'rtl'>(initialDirection);
  const [mode, setMode] = useState<Mode>('single');
  const [fit, setFit] = useState<Fit>('contain');
  const [zoom, setZoom] = useState(1);
  const [uiVisible, setUiVisible] = useState(true);
  const [panel, setPanel] = useState<'toc' | 'pages' | null>(null);
  const [help, setHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chapter = chapters[chapterIndex];
  const total = chapter?.pages.length || 0;
  const rtl = direction === 'rtl';
  const step = mode === 'double' ? 2 : 1;

  const currentPages = useMemo(() => {
    if (!chapter) return [];
    if (mode !== 'double') return [chapter.pages[pageIndex]].filter(Boolean);
    const a = chapter.pages[pageIndex];
    const b = chapter.pages[pageIndex + 1];
    const pair = [a, b].filter(Boolean);
    return rtl ? [...pair].reverse() : pair;
  }, [chapter, pageIndex, mode, rtl]);

  const chapterProgress = total ? Math.min(100, Math.round(((pageIndex + 1) / total) * 100)) : 0;

  /* 保存阅读进度 */
  useEffect(() => {
    if (!chapter || !onProgress) return;
    const t = setTimeout(() => onProgress(chapter.id, pageIndex), 400);
    return () => clearTimeout(t);
  }, [chapter, pageIndex, onProgress]);

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

  /* UI 自动隐藏 */
  const poke = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUiVisible(false), 2600);
  }, []);

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [poke]);

  const goNext = useCallback(() => {
    if (!chapter) return;
    poke();
    setLoaded(false);
    if (pageIndex + step <= total - 1) {
      setPageIndex(pageIndex + step);
    } else if (chapterIndex < chapters.length - 1) {
      setChapterIndex(chapterIndex + 1);
      setPageIndex(0);
    }
  }, [chapter, pageIndex, step, total, chapterIndex, chapters.length, poke]);

  const goPrev = useCallback(() => {
    if (!chapter) return;
    poke();
    setLoaded(false);
    if (pageIndex - step >= 0) {
      setPageIndex(pageIndex - step);
    } else if (pageIndex > 0) {
      setPageIndex(0);
    } else if (chapterIndex > 0) {
      const prev = chapters[chapterIndex - 1];
      setChapterIndex(chapterIndex - 1);
      setPageIndex(Math.max(0, prev.pages.length - (mode === 'double' ? 2 : 1)));
    }
  }, [chapter, pageIndex, step, chapterIndex, chapters, mode, poke]);

  /* 键盘操作 */
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
      } else if (k === '+' || k === '=') {
        setZoom((z) => Math.min(4, z + 0.2));
      } else if (k === '-' || k === '_') {
        setZoom((z) => Math.max(0.4, z - 0.2));
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
  }, [goNext, goPrev, rtl, panel, help, onExit]);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function onStageClick(e: React.MouseEvent) {
    if (mode === 'continuous') return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const leftSide = e.clientX - rect.left < rect.width / 2;
    if (rtl) leftSide ? goNext() : goPrev();
    else leftSide ? goPrev() : goNext();
  }

  function onContinuousScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (!total) return;
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    setPageIndex(Math.min(total - 1, Math.floor(ratio * total)));
  }

  if (!chapter) {
    return (
      <div className="reader">
        <div className="empty" style={{ margin: 'auto', color: '#999' }}>
          没有可阅读的内容
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={onExit}>
              返回
            </button>
          </div>
        </div>
      </div>
    );
  }

  const fitClass = fit === 'width' ? 'fit-width' : fit === 'height' ? 'fit-height' : fit === 'original' ? 'original' : '';

  return (
    <div className="reader" onMouseMove={poke} onTouchStart={poke}>
      <div className={`reader-top ${uiVisible ? '' : 'hidden'}`}>
        <button className="btn sm ghost" onClick={onExit} title="返回">
          <Icon name="left" size={16} />
        </button>
        <div className="reader-info" style={{ maxWidth: 260 }}>
          {title}
          <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {chapter.title}</span>
        </div>

        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button
            className={`btn sm ${mode === 'single' ? 'primary' : 'ghost'}`}
            onClick={() => setMode('single')}
            title="单页"
          >
            单页
          </button>
          <button
            className={`btn sm ${mode === 'double' ? 'primary' : 'ghost'}`}
            onClick={() => setMode('double')}
            title="双页对开"
          >
            双页
          </button>
          <button
            className={`btn sm ${mode === 'continuous' ? 'primary' : 'ghost'}`}
            onClick={() => setMode('continuous')}
            title="连续滚动（条漫）"
          >
            连读
          </button>
          <button className="btn sm ghost" onClick={() => setDirection(rtl ? 'ltr' : 'rtl')} title="切换阅读方向">
            <Icon name={rtl ? 'left' : 'right'} size={15} /> {rtl ? 'RTL' : 'LTR'}
          </button>
          <select
            className="select"
            style={{ width: 110 }}
            value={fit}
            onChange={(e) => setFit(e.target.value as Fit)}
            title="页面适配"
          >
            <option value="contain">适应屏幕</option>
            <option value="width">适应宽度</option>
            <option value="height">适应高度</option>
            <option value="original">原始尺寸</option>
          </select>
          {fit === 'original' && (
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
                <Icon name="zoom" size={14} />
              </button>
              <span style={{ fontSize: 12, width: 40 }}>{Math.round(zoom * 100)}%</span>
              <button className="btn sm ghost" onClick={() => setZoom((z) => Math.min(4, z + 0.2))}>
                <Icon name="plus" size={14} />
              </button>
            </div>
          )}
          <button className="btn sm ghost" onClick={() => setPanel(panel === 'toc' ? null : 'toc')} title="目录 (M)">
            <Icon name="list" size={15} />
          </button>
          <button className="btn sm ghost" onClick={() => setPanel(panel === 'pages' ? null : 'pages')} title="页面导航 (P)">
            <Icon name="grid" size={15} />
          </button>
          <button className="btn sm ghost" onClick={toggleFullscreen} title="全屏 (F)">
            <Icon name="fullscreen" size={15} />
          </button>
          {headerExtra}
        </div>
      </div>

      <div
        ref={stageRef}
        className={`reader-stage ${mode} ${fitClass}`}
        onClick={onStageClick}
        onScroll={mode === 'continuous' ? onContinuousScroll : undefined}
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

      {mode !== 'continuous' && (
        <>
          <button className="reader-nav prev" onClick={goPrev} aria-label="上一页" />
          <button className="reader-nav next" onClick={goNext} aria-label="下一页" />
        </>
      )}

      <div className={`reader-bottom ${uiVisible ? '' : 'hidden'}`}>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn sm ghost" onClick={goPrev}>
            <Icon name="left" size={15} />
          </button>
          <span style={{ fontSize: 13, fontWeight: 700, minWidth: 92, textAlign: 'center' }}>
            {pageIndex + 1}
            {mode === 'double' && pageIndex + 1 < total ? `–${pageIndex + 2}` : ''} / {total}
          </span>
          <button className="btn sm ghost" onClick={goNext}>
            <Icon name="right" size={15} />
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={pageIndex}
            onChange={(e) => setPageIndex(Number(e.target.value))}
          />
          <select
            className="select"
            style={{ width: 150 }}
            value={chapterIndex}
            onChange={(e) => {
              setChapterIndex(Number(e.target.value));
              setPageIndex(0);
            }}
          >
            {chapters.map((c, i) => (
              <option key={c.id} value={i}>
                {c.title}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{chapterProgress}%</span>
        </div>
      </div>

      {panel && (
        <div className="reader-panel">
          <header>
            <Icon name={panel === 'toc' ? 'list' : 'grid'} size={16} />
            {panel === 'toc' ? '目录' : '页面'}
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
                      setChapterIndex(i);
                      setPageIndex(0);
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
            ) : (
              <>
                <div className="thumb-grid">
                  {chapter.pages.map((p, i) => (
                    <button
                      key={p.id}
                      className={i === pageIndex ? 'active' : ''}
                      onClick={() => {
                        setPageIndex(i);
                        setPanel(null);
                      }}
                    >
                      <img src={p.thumbUrl || p.url} alt="" loading="lazy" />
                      <span className="n">{i + 1}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {!readOnly && (
              <div style={{ marginTop: 14 }}>
                <div className="help-grid">
                  <div><span className="kbd">← →</span> 翻页</div>
                  <div><span className="kbd">空格</span> 下一页</div>
                  <div><span className="kbd">D</span> 单页 / 双页</div>
                  <div><span className="kbd">R</span> 切换方向</div>
                  <div><span className="kbd">M</span> 目录</div>
                  <div><span className="kbd">P</span> 页面</div>
                  <div><span className="kbd">F</span> 全屏</div>
                  <div><span className="kbd">+/−</span> 缩放</div>
                  <div><span className="kbd">Esc</span> 返回</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {help && (
        <div className="backdrop" onClick={() => setHelp(false)}>
          <div className="modal" style={{ width: 'min(520px, 92vw)' }}>
            <div className="modal-head">
              <Icon name="menu" />
              <h3>快捷键</h3>
            </div>
            <div className="modal-body">
              <div className="help-grid">
                <div><span className="kbd">← →</span> 上一页 / 下一页</div>
                <div><span className="kbd">空格</span> 下一页</div>
                <div><span className="kbd">D</span> 单页 / 双页切换</div>
                <div><span className="kbd">R</span> 阅读方向 LTR / RTL</div>
                <div><span className="kbd">M</span> 章节目录</div>
                <div><span className="kbd">P</span> 页面缩略图</div>
                <div><span className="kbd">F</span> 全屏</div>
                <div><span className="kbd">+/−</span> 缩放（原始尺寸模式）</div>
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
