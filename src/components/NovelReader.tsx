import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Comic } from '../types';

/**
 * 小说阅读器：上下滑动连续阅读，像主流小说 App 一样
 * - 章节正文按需加载（只拉当前章，秒开）
 * - 连续阅读：把相邻章节拼起来滚动、滚动到底自动续下一章，章节间只用小标题分隔（不再每话一个大标题/封面）
 * - 自动分好的目录可随时跳转
 * - 进度条可拖动定位，滚动进度自动记忆
 * - 字号 / 行距 / 阅读背景可调并记住
 */
const PREFS_KEY = 'cv-novel-prefs';
type Theme = 'dark' | 'sepia' | 'green' | 'light';
interface Prefs { fontSize: number; lineHeight: number; theme: Theme; continuous: boolean }
interface Segment { idx: number; text: string }
/** 把正文拆成「文字段 / 插图」：后端把 EPUB <img> 落成 [[IMG:url]] 占位符 */
type Block = { t: 'p'; v: string } | { t: 'img'; v: string };
function textBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /\[\[IMG:([^\]]+)\]\]/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const p of before) out.push({ t: 'p', v: p });
    out.push({ t: 'img', v: m[1] });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (const p of tail) out.push({ t: 'p', v: p });
  return out;
}

const DEFAULT_PREFS: Prefs = { fontSize: 19, lineHeight: 1.9, theme: 'dark', continuous: false };
const THEMES: Record<Theme, { bg: string; fg: string; sub: string; bar: string; label: string }> = {
  dark: { bg: '#15181e', fg: '#d9dee8', sub: '#8b93a5', bar: '#1c212a', label: '夜间' },
  sepia: { bg: '#f5ecd9', fg: '#4a3b28', sub: '#8a7a60', bar: '#eee1c7', label: '羊皮纸' },
  green: { bg: '#dbe9d6', fg: '#2f4532', sub: '#6b8a70', bar: '#cfe0c8', label: '护眼' },
  light: { bg: '#ffffff', fg: '#23272f', sub: '#7a8290', bar: '#f2f4f7', label: '明亮' },
};
const THEME_ORDER: Theme[] = ['dark', 'sepia', 'green', 'light'];

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

export function NovelReader({
  comic, initialChapterId, initialRatio = 0, onProgress, onExit,
}: {
  comic: Comic;
  initialChapterId?: string;
  /** 0~1，从服务端保存的进度还原 */
  initialRatio?: number;
  onProgress?: (chapterId: string, pageIndex: number) => void;
  onExit: () => void;
}) {
  const chapters = comic.chapters;
  const [chapterIndex, setChapterIndex] = useState(() => {
    const i = chapters.findIndex((c) => c.id === initialChapterId);
    return i >= 0 ? i : 0;
  });
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [text, setText] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [ratio, setRatio] = useState(initialRatio);
  const stageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const pendingRatio = useRef(initialRatio);
  const segRefs = useRef<Record<number, HTMLElement | null>>({});
  const segmentsRef = useRef<Segment[]>([]);
  const continuousRef = useRef(prefs.continuous);
  const loadingMoreLock = useRef(false);

  const chapter = chapters[chapterIndex];
  const th = THEMES[prefs.theme] || THEMES.dark;
  const continuous = prefs.continuous;

  continuousRef.current = continuous;
  segmentsRef.current = segments;

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 忽略 */ }
  }, [prefs]);

  // 只拉当前章节正文，换章时才请求，避免整本小说一次性传输
  useEffect(() => {
    if (!chapter) return;
    let alive = true;
    setLoading(true);
    setText('');
    api.novelChapter(comic.id, chapter.id)
      .then((r) => {
        if (!alive) return;
        setText(r.text || '');
        if (continuousRef.current) setSegments([{ idx: chapterIndex, text: r.text || '' }]);
      })
      .catch(() => { if (alive) setText('（正文加载失败，请返回重试）'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [comic.id, chapter?.id]);

  // 正文渲染完成后定位到记忆的进度（或回到顶部）。连续模式每次只挂载首章，按顶部定位即可。
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !text) return;
    const r = pendingRatio.current;
    requestAnimationFrame(() => {
      el.scrollTop = r > 0 ? r * Math.max(1, el.scrollHeight - el.clientHeight) : 0;
      pendingRatio.current = 0;
    });
  }, [text, chapterIndex]);

  function report(idx: number, r: number) {
    const ch = chapters[idx];
    if (ch) onProgress?.(ch.id, Math.round(r * 1000));
  }

  /** 连续阅读：滚动接近底部时按需加载下一章正文，追加到拼接列表 */
  async function loadMore() {
    if (!continuousRef.current || loadingMoreLock.current) return;
    const cur = segmentsRef.current;
    if (!cur.length) return;
    const last = cur[cur.length - 1].idx;
    if (last >= chapters.length - 1) return;
    const nextIdx = last + 1;
    loadingMoreLock.current = true;
    setLoadingMore(true);
    try {
      const r = await api.novelChapter(comic.id, chapters[nextIdx].id);
      setSegments((c) => c.some((s) => s.idx === nextIdx) ? c : [...c, { idx: nextIdx, text: r.text || '' }]);
    } catch {
      /* 加载失败不中断阅读 */
    } finally {
      loadingMoreLock.current = false;
      setLoadingMore(false);
    }
  }

  function onScroll() {
    const el = stageRef.current;
    if (!el) return;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const r = Math.min(1, Math.max(0, el.scrollTop / max));
    setRatio(r);

    let activeIdx = chapterIndex;
    let segRatio = r;
    if (continuousRef.current && segmentsRef.current.length) {
      // 视口上 1/5 处落在哪一段，就认为正在读哪一章
      const anchor = el.scrollTop + el.clientHeight * 0.2;
      for (const s of segmentsRef.current) {
        const node = segRefs.current[s.idx];
        if (node && node.offsetTop <= anchor) activeIdx = s.idx;
      }
      const node = segRefs.current[activeIdx];
      if (node) {
        segRatio = Math.min(1, Math.max(0,
          (el.scrollTop - node.offsetTop + el.clientHeight * 0.3) / Math.max(1, node.offsetHeight),
        ));
      }
      if (r > 0.98) loadMore();
    }

    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => report(activeIdx, segRatio), 800);
  }

  function goChapter(next: number) {
    if (next < 0 || next >= chapters.length) return;
    pendingRatio.current = 0;
    setRatio(0);
    setSegments([]);
    setChapterIndex(next);
    setTocOpen(false);
    requestAnimationFrame(() => stageRef.current?.scrollTo?.(0, 0));
  }

  function toggleContinuous() {
    const next = !prefs.continuous;
    setPrefs((p) => ({ ...p, continuous: next }));
    if (next) {
      // 用当前已加载正文立即初始化，切换无需重新请求
      setSegments(text ? [{ idx: chapterIndex, text }] : []);
    } else {
      setSegments([]);
    }
    requestAnimationFrame(() => stageRef.current?.scrollTo?.(0, 0));
  }

  function seek(v: number) {
    const el = stageRef.current;
    if (!el) return;
    el.scrollTop = v * Math.max(1, el.scrollHeight - el.clientHeight);
    setRatio(v);
    report(continuousRef.current ? (segmentsRef.current[segmentsRef.current.length - 1]?.idx ?? chapterIndex) : chapterIndex, v);
  }

  // 键盘翻页 / 上下章
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = stageRef.current;
      if (!el) return;
      if (e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); el.scrollBy({ top: el.clientHeight * 0.85, behavior: 'smooth' }); }
      else if (e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); el.scrollBy({ top: -el.clientHeight * 0.85, behavior: 'smooth' }); }
      else if (e.key === '[') goChapter(chapterIndex - 1);
      else if (e.key === ']') goChapter(chapterIndex + 1);
      else if (e.key === 'Escape') { if (tocOpen) setTocOpen(false); else onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const paragraphs = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const shownSegments = segments.length ? segments : (text ? [{ idx: chapterIndex, text }] : []);

  function BodyBlocks({ text: raw }: { text: string }) {
    return <>{textBlocks(raw).map((b, i) => b.t === 'img'
      ? <img key={i} className="novel-illus" src={b.v} alt="插图" loading="lazy"
          onClick={(e) => { const el = e.currentTarget; if (el.style.cursor !== 'zoom-out') { el.style.cursor = 'zoom-out'; el.style.maxWidth = '100%'; } }} />
      : <p key={i}>{b.v}</p>)}</>;
  }

  return (
    <div className="novel-reader" style={{ background: th.bg, color: th.fg }}>
      <header className="novel-bar" style={{ background: th.bar }}>
        <button className="nv-btn" onClick={onExit} title="返回书架">← 返回</button>
        <div className="nv-title" title={comic.title}>{comic.title}</div>
        <button className={`nv-btn ${continuous ? 'on' : ''}`} onClick={toggleContinuous}
          title="把相邻章节连起来读，章节间不再每话一个大标题">
          {continuous ? '连续阅读 ✓' : '单章阅读'}
        </button>
        <button className="nv-btn" onClick={() => setTocOpen((v) => !v)}>目录 {chapters.length}</button>
        <button className="nv-btn" onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.max(14, p.fontSize - 1) }))}>A−</button>
        <button className="nv-btn" onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.min(30, p.fontSize + 1) }))}>A＋</button>
        <button className="nv-btn" onClick={() => setPrefs((p) => ({ ...p, lineHeight: p.lineHeight >= 2.4 ? 1.6 : Math.round((p.lineHeight + 0.2) * 10) / 10 }))}>行距</button>
        <button className="nv-btn" onClick={() => setPrefs((p) => ({
          ...p, theme: THEME_ORDER[(THEME_ORDER.indexOf(p.theme) + 1) % THEME_ORDER.length],
        }))}>{th.label}</button>
      </header>

      {tocOpen && (
        <div className="novel-toc" style={{ background: th.bar }}>
          <div className="nv-toc-head">目录 · 共 {chapters.length} 章</div>
          <div className="nv-toc-list">
            {chapters.map((c, i) => (
              <button key={c.id} className={`nv-toc-item ${i === chapterIndex ? 'on' : ''}`}
                onClick={() => goChapter(i)}>
                <span>{i + 1}.</span> {c.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={stageRef} className="novel-stage" onScroll={onScroll}>
        <article className="novel-body" style={{ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight }}>
          {continuous ? (
            <>
              {shownSegments.map((seg, si) => {
                const c = chapters[seg.idx];
                return (
                  <section key={seg.idx} className="novel-seg"
                    ref={(el) => { segRefs.current[seg.idx] = el; }}>
                    {si === 0
                      ? <h1 className="novel-h1">{c?.title || '正文'}</h1>
                      : <h2 className="novel-seg-title">{c?.title || '继续'}</h2>}
                    <BodyBlocks text={seg.text} />
                  </section>
                );
              })}
              {loading && shownSegments.length === 0 && (
                <div style={{ color: th.sub, padding: '40px 0' }}>正在加载本章…</div>
              )}
              {loadingMore && <div className="novel-end" style={{ color: th.sub }}>正在加载下一章…</div>}
              {!loadingMore && shownSegments.length > 0 && shownSegments[shownSegments.length - 1].idx >= chapters.length - 1 && (
                <div className="novel-end" style={{ color: th.sub }}>— 全文完 —</div>
              )}
            </>
          ) : (
            <>
              <h1 className="novel-h1">{chapter?.title || '正文'}</h1>
              {loading && <div style={{ color: th.sub, padding: '40px 0' }}>正在加载本章…</div>}
              {!loading && <BodyBlocks text={text} />}
              {!loading && paragraphs.length > 0 && (
                <>
                  <div className="novel-end" style={{ color: th.sub }}>— 本章完 —</div>
                  <div className="novel-chapter-nav">
                    <button onClick={() => goChapter(chapterIndex - 1)} disabled={chapterIndex === 0}>← 上一章</button>
                    <button onClick={() => goChapter(chapterIndex + 1)} disabled={chapterIndex === chapters.length - 1}>下一章 →</button>
                  </div>
                </>
              )}
            </>
          )}
        </article>
      </div>

      <footer className="novel-foot" style={{ background: th.bar, color: th.sub }}>
        {!continuous && (
          <button className="nv-btn" onClick={() => goChapter(chapterIndex - 1)} disabled={chapterIndex === 0}>上一章</button>
        )}
        <span className="nv-chapter">{chapterIndex + 1} / {chapters.length}</span>
        <input
          className="nv-range" type="range" min={0} max={1000}
          value={Math.round(ratio * 1000)}
          onChange={(e) => seek(Number(e.target.value) / 1000)}
          title="拖动定位阅读进度"
        />
        <span className="nv-percent">{Math.round(ratio * 100)}%</span>
        {!continuous && (
          <button className="nv-btn" onClick={() => goChapter(chapterIndex + 1)} disabled={chapterIndex === chapters.length - 1}>下一章</button>
        )}
      </footer>
    </div>
  );
}
