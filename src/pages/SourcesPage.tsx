import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ReaderView } from '../components/ReaderView';
import { useErrorToast, useToast } from '../components/Toasts';
import { useSession } from '../lib/session';
import { online as onlineApi, sources as sourcesApi, mediaUrl } from '../lib/api';
import { importTaskStore } from '../lib/importTask';
import { onlineShelfLocal } from '../lib/onlineShelfLocal';
import type {
  OnlineShelfItem,
  SourceChapterItem,
  SourceComicDetail,
  SourceInfo,
  SourceSearchItem,
} from '../lib/api';
import type { Chapter, Page } from '../types';

type MediaTab = 'comic' | 'novel';

/** 「全部漫画 / 全部小说」虚拟聚合源 */
const ALL_SOURCES = '__all__';

/** 在线来源封面统一走服务端代理：绕过跨域 / 防盗链 / 浏览器无法直连源站域名的问题 */
function coverUrl(sid: string | undefined, url: string | undefined): string {
  if (!url) return '';
  if (!sid) return mediaUrl(url);
  return mediaUrl(`/api/online/img?sid=${encodeURIComponent(sid.replace(/^js:/, ''))}&u=${encodeURIComponent(url)}`);
}

/** 合并云端+本地书架，并为本地项补上封面代理地址，保证未登录收藏也有封面 */
function mergedShelf(remote: OnlineShelfItem[]): OnlineShelfItem[] {
  return onlineShelfLocal.merge(remote).map((it) => ({
    ...it,
    coverProxy: it.coverProxy || coverUrl(it.sourceKey, it.cover),
  }));
}

export default function SourcesPage() {
  const { user: sessionUser } = useSession();
  const [list, setList] = useState<SourceInfo[]>([]);
  const [loadError, setLoadError] = useState<string>('');
  const [tab, setTab] = useState<MediaTab>('comic');
  const [activeId, setActiveId] = useState('');
  const [kw, setKw] = useState('');
  const [searchMode, setSearchMode] = useState<'fuzzy' | 'exact'>('fuzzy');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SourceSearchItem[]>([]);
  const [discoverTabs, setDiscoverTabs] = useState<{ index: number; title: string }[]>([]);
  const [discoverTab, setDiscoverTab] = useState(0);
  const [discoverPage, setDiscoverPage] = useState(1);
  const [discoverMaxPage, setDiscoverMaxPage] = useState(1);
  const [discovering, setDiscovering] = useState(false);
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<(SourceComicDetail & { checked: Set<number>; sourceId?: string; sourceName?: string }) | null>(null);
  const [importing, setImporting] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [importProgressLabel, setImportProgressLabel] = useState('');
  const [importedComicId, setImportedComicId] = useState('');
  const [shelf, setShelf] = useState<OnlineShelfItem[]>([]);
  const [bookmarked, setBookmarked] = useState(false);
  const [novelImporting, setNovelImporting] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [accountCookie, setAccountCookie] = useState('');
  const [accountInfo, setAccountInfo] = useState<{ website: string; canPasswordLogin: boolean }>({ website: '', canPasswordLogin: false });
  const [accountUser, setAccountUser] = useState('');
  const [accountPwd, setAccountPwd] = useState('');
  const [onlineReader, setOnlineReader] = useState<OnlineReaderState | null>(null);
  const toast = useToast();
  const errorToast = useErrorToast();

  const active = list.find((s) => s.id === activeId) || null;
  const tabSources = useMemo(() => list.filter((s) => (s.mediaType || 'comic') === tab), [list, tab]);
  /** 聚合模式：跨当前分类的所有书源搜索/发现，结果去重 */
  const isAll = activeId === ALL_SOURCES;
  // 详情可能来自「全部」聚合结果，必须用结果自带的来源，而不是当前选中的虚拟源
  const detailSourceId = detail?.sourceId || activeId;
  const detailSourceName = detail?.sourceName || active?.name || '';

  async function load() {
    try {
      const [r, s] = await Promise.all([sourcesApi.list(), onlineApi.shelf().catch(() => ({ items: [] }))]);
      setList(r.sources);
      setLoadError('');
      // 未登录云端书架为空时，本地兜底书架仍要显示，保证收藏/阅读历史不丢
      setShelf(mergedShelf(s.items || []));
      const first = r.sources.find((x) => (x.mediaType || 'comic') === tab)?.id || ALL_SOURCES;
      setActiveId((cur) => cur || first);
      if (first) loadDiscover(first, 0, 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '网络异常');
      errorToast(err, '加载书源失败');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId && tabSources.length) setActiveId(tabSources[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tabSources.length]);

  async function refreshShelf() {
    try {
      const s = await onlineApi.shelf();
      setShelf(mergedShelf(s.items || []));
    } catch {
      // 未登录时云端 401，仍显示本地兜底书架
      setShelf(mergedShelf([]));
    }
  }

  async function loadDiscover(sid: string, tab = 0, page = 1) {
    if (!sid) return;
    setDiscovering(true);
    try {
      if (sid === ALL_SOURCES) {
        // 聚合发现：并发拉所有同类书源，按标题去重。
        // 单个源加 8 秒超时（Promise.race），慢源/失效源不拖垮整屏——以前要等最慢的源。
        type Disco = Awaited<ReturnType<typeof sourcesApi.discover>>;
        const withTimeout = (p: Promise<Disco | null>) => Promise.race([
          p,
          new Promise<null>((r) => setTimeout(() => r(null), 8000)),
        ]);
        const rs = await Promise.all(tabSources.map((s) => withTimeout(sourcesApi.discover(s.id, tab, page).catch(() => null))));
        const seen = new Set<string>();
        const merged: SourceSearchItem[] = [];
        for (let i = 0; i < rs.length; i++) {
          const r = rs[i]; if (!r) continue;
          for (const it of r.items || []) {
            const key = it.title.trim();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ ...it, sourceId: tabSources[i].id, sourceName: tabSources[i].name });
          }
        }
        setDiscoverTabs(rs.find((r) => r?.tabs?.length)?.tabs || []);
        setResults(merged);
        setDiscoverMaxPage(Math.max(1, ...rs.map((r) => r?.maxPage || 1)));
        setDiscoverTab(tab);
        setDiscoverPage(page);
        setSearched(false);
      } else {
        const r = await sourcesApi.discover(sid, tab, page);
        setDiscoverTabs(r.tabs || []);
        setResults(r.items || []);
        setDiscoverMaxPage(r.maxPage || 1);
        setDiscoverTab(r.tab ?? tab);
        setDiscoverPage(page);
        setSearched(false);
      }
    } catch { setResults([]); setDiscoverTabs([]); }
    finally { setDiscovering(false); }
  }

  async function doSearch(modeOverride?: 'fuzzy' | 'exact') {
    if (!kw.trim()) return;
    const mode = modeOverride || searchMode;
    const targets = isAll ? tabSources : (active ? [active] : []);
    if (!targets.length) return;
    setSearching(true);
    // 从书籍详情里再次搜索时，先退出详情，否则结果被详情面板遮住，看起来像「搜索没反应」
    setDetail(null);
    setResults([]);
    try {
      const rs = await Promise.all(targets.map((s) => sourcesApi.search(s.id, kw.trim()).catch(() => ({ items: [] as SourceSearchItem[] }))));
      const seen = new Set<string>();
      const merged: SourceSearchItem[] = [];
      for (let i = 0; i < rs.length; i++) {
        for (const it of rs[i].items || []) {
          const key = `${it.title.trim()}|${it.author || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...it, sourceId: targets[i].id, sourceName: targets[i].name });
        }
      }
      // 精准模式：只保留标题与关键词完全一致（忽略大小写/空白）的结果；
      // 模糊模式：保留源站返回的全部结果（默认，包含匹配）。
      const q = kw.trim().toLowerCase().replace(/\s+/g, '');
      const finalResults = mode === 'exact'
        ? merged.filter((it) => String(it.title || '').toLowerCase().replace(/\s+/g, '') === q)
        : merged;
      setResults(finalResults);
      setSearched(true);
      if (!finalResults.length) toast(mode === 'exact' ? '精准搜索无完全匹配，试试模糊搜索' : '没有搜到结果，试试别的关键词或换个书源');
      else if (isAll) toast(`合并 ${targets.length} 个来源，找到 ${finalResults.length} 个结果`);
    } catch (err) {
      errorToast(err, '搜索失败');
    } finally {
      setSearching(false);
    }
  }

  async function openComic(item: SourceSearchItem) {
    // 聚合结果自带 sourceId，不依赖当前选中的 active（「全部」模式下 active 为空）
    const sid = item.sourceId || activeId;
    if (!sid) return;
    setSearching(true);
    try {
      const r = await sourcesApi.comic(sid, item.link);
      setDetail({
        ...r,
        sourceId: sid,
        sourceName: item.sourceName || active?.name || '',
        bookId: r.bookId || item.link,
        checked: new Set((r.chapters || []).map((_, i) => i)),
      });
      const s = await onlineApi.shelf().catch(() => ({ items: [] as OnlineShelfItem[] }));
      const allShelf = onlineShelfLocal.merge(s.items || []);
      setBookmarked(!!allShelf.find((x) => x.key === `${sid.replace(/^js:/, '')}:${r.bookId || item.link}`));
    } catch (err) {
      errorToast(err, '读取章节失败');
    } finally {
      setSearching(false);
    }
  }

  async function openShelfItem(item: OnlineShelfItem) {
    const sourceId = `js:${item.sourceKey}`;
    try {
      const r = await sourcesApi.comic(sourceId, item.bookId);
      setDetail({
        ...r,
        bookId: r.bookId || item.bookId,
        checked: new Set((r.chapters || []).map((_, i) => i)),
      });
      setActiveId(sourceId);
      setTab(item.kind);
      setBookmarked(true);
      setKw('');
      setResults([]);
      if (item.progress && r.chapters?.length) {
        const i = r.chapters.findIndex((c) => c.url === item.progress!.chapterUrl);
        if (i >= 0) startOnlineRead(item.bookId, r.chapters, i, item);
      }
    } catch (err) {
      errorToast(err, '读取收藏失败（源站可能失效）');
    }
  }

  async function bookmark(detail2: SourceComicDetail & { checked: Set<number>; sourceId?: string; sourceName?: string }) {
    const sid = detail2.sourceId || detailSourceId;
    if (!sid) return;
    const sourceKey = sid.replace(/^js:/, '');
    const key = `${sourceKey}:${detail2.bookId}`;
    const addInput = {
      sourceKey,
      sourceName: detail2.sourceName || detailSourceName,
      bookId: detail2.bookId || '',
      title: detail2.title,
      cover: detail2.cover,
      author: detail2.author || '',
      kind: (detail2.kind || tab) as 'comic' | 'novel',
      chaptersTotal: detail2.chapters?.length || 0,
    };
    try {
      if (bookmarked) {
        const it = shelf.find((x) => x.key === key);
        if (it && !sessionUser && it.id.startsWith('local_')) onlineShelfLocal.remove(it.id);
        else if (it) await onlineApi.removeFromShelf(it.id);
        setBookmarked(false);
        toast('已从书架移除');
      } else {
        if (sessionUser) {
          await onlineApi.addToShelf({ sourceId: sid, ...addInput });
        } else {
          // 未登录：写本地兜底书架，收藏与阅读历史照样记录
          onlineShelfLocal.add(addInput);
        }
        setBookmarked(true);
        toast('已收藏到书架');
      }
      refreshShelf();
    } catch (err) {
      // 云端写入失败（如登录态失效）时降级为本地，避免收藏丢失
      if (!bookmarked) {
        onlineShelfLocal.add(addInput);
        setBookmarked(true);
        toast('已收藏到书架（本地）');
        refreshShelf();
      } else {
        errorToast(err, '书架操作失败');
      }
    }
  }

  async function importChapters() {
    if (!detail) return;
    const chapters = detail.chapters || [];
    const picked = chapters.filter((_, i) => detail.checked.has(i));
    if (!picked.length) return toast('请先勾选要导入的章节');
    setImporting({ done: 0, total: picked.length, failed: 0 });
    importTaskStore.start(`正在导入 ${detail.title} · 0/${picked.length} 话`, {
      sourceId: detailSourceId, sourceName: detailSourceName, title: detail.title,
      cover: detail.cover, comicUrl: detail.bookId || detail.url,
      bookId: detail.bookId || detail.url, kind: detail.kind || 'comic',
      picked: picked.map((c) => ({ title: c.title, url: c.url })),
    });
    // 轮询后端图片级进度：显示「第 N 话 · 第 x/y 张」，不再长时间卡在 0/N
    // 进度同时写入全局任务栏，返回/切到任何页面都继续可见。
    let progAlive = true;
    let curChapter = 1;
    (async () => {
      while (progAlive) {
        try {
          const pg = await sourcesApi.importProgress();
          if (!pg.idle && pg.imageTotal) {
            const label = `第 ${curChapter}/${picked.length} 话 · ${pg.chapterTitle || ''} ${pg.imageDone}/${pg.imageTotal} 张`;
            setImportProgressLabel(label);
            importTaskStore.progress({ label, done: curChapter - 1, total: picked.length });
          }
        } catch { /* 忽略轮询错误 */ }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
    let comicId = '';
    let failed = 0;
    let done = 0;
    for (const ch of picked) {
      // 暂停：任务栏点「暂停」后，导入循环在每话开始前等待，点「继续」再往下走。
      while (importTaskStore.isPaused()) {
        await new Promise((r) => setTimeout(r, 300));
      }
      curChapter = done + 1;
      try {
        const r = await sourcesApi.importChapter({
          comicId: comicId || undefined,
          sourceId: detailSourceId,
          sourceName: detailSourceName,
          title: detail.title,
          cover: detail.cover,
          comicUrl: detail.bookId || detail.url,
          bookId: detail.bookId || detail.url,
          chapterTitle: ch.title,
          chapterUrl: ch.url,
        });
        if (!comicId) {
          comicId = r.comicId;
          setImportedComicId(r.comicId);
        }
        done++;
      } catch (err) {
        failed++;
        if (failed === 1) errorToast(err, '导入失败');
      }
      setImporting({ done, total: picked.length, failed });
      importTaskStore.progress({ done, total: picked.length, failed, label: `正在导入 ${detail.title} · ${done}/${picked.length} 话` });
    }
    progAlive = false;
    setImportProgressLabel('');
    setImporting(null);
    if (done) {
      importTaskStore.finish(done, picked.length, failed, comicId);
      toast(`导入完成：成功 ${done} 话${failed ? `，失败 ${failed} 话` : ''}`);
    } else {
      importTaskStore.clear();
    }
  }

  async function importNovelBook() {
    if (!detailSourceId || !detail?.bookId) return;
    setNovelImporting(true);
    importTaskStore.start(`正在整本导入《${detail.title}》…`);
    try {
      const r = await onlineApi.importBook(detailSourceId, detail.bookId);
      toast(`已加入书库：《${detail.title}》共 ${r.comic.chapterCount} 章，可在书库里编辑`);
      importTaskStore.finish(r.comic.chapterCount || 1, r.comic.chapterCount || 1, 0, r.comic.id);
      onImportedNavigate(r.comic.id);
    } catch (err) {
      importTaskStore.clear();
      errorToast(err, '整本导入失败');
    } finally {
      setNovelImporting(false);
    }
  }

  function onImportedNavigate(comicId: string) {
    setImportedComicId(comicId);
  }

  async function startOnlineRead(bookId: string, chapters: SourceChapterItem[], index: number, shelfItem?: OnlineShelfItem | null) {
    if (!detailSourceId) return;
    // 在线阅读的每一本都自动进书架，确保翻页进度能落库、回来能「继续阅读」。
    // 以前只有先手动收藏的书才有 shelfId，直接点章节播放的书进度完全不保存。
    let sid = shelfItem?.id || '';
    const sourceKey = detailSourceId.replace(/^js:/, '');
    const key = `${sourceKey}:${bookId}`;
    const addInput = {
      sourceKey,
      sourceName: detail?.sourceName || detailSourceName,
      bookId,
      title: detail?.title || shelfItem?.title || '在线阅读',
      cover: detail?.cover || '',
      author: detail?.author || '',
      kind: (detail?.kind || 'comic') as 'comic' | 'novel',
      chaptersTotal: chapters.length,
    };
    if (!sid) {
      const existing = shelf.find((x) => x.key === key);
      if (existing) {
        sid = existing.id;
      } else if (sessionUser) {
        try {
          const r = await onlineApi.addToShelf({ sourceId: detailSourceId, ...addInput });
          sid = r?.item?.id || '';
          refreshShelf();
        } catch { /* 云端失败降级为本地 */ }
      }
      // 未登录或云端失败：写入本地兜底书架，保证进度能记录
      if (!sid) {
        sid = onlineShelfLocal.add(addInput).id;
        refreshShelf();
      }
    }
    setOnlineReader({
      sourceKey: detailSourceId.replace(/^js:/, ''),
      sourceId: detailSourceId,
      bookId,
      title: detail?.title || shelfItem?.title || '在线阅读',
      chapters: chapters.map((c, i) => ({
        id: c.url,
        title: c.title,
        number: i + 1,
        pages: [] as Page[],
      })) as Chapter[],
      index,
      shelfId: sid,
    });
  }

  return (
    <main className="page">
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1>在线来源</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            内置多来源：搜到即可收藏到书架在线看，也能一键加入自己的书库离读、编辑
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <button className="btn" onClick={async () => {
            setAccountCookie(''); setAccountUser(''); setAccountPwd('');
            if (activeId) {
              try {
                const info = await sourcesApi.getCookies(activeId);
                setAccountInfo({ website: info.website || '', canPasswordLogin: !!info.canPasswordLogin });
              } catch { setAccountInfo({ website: '', canPasswordLogin: false }); }
            }
            setShowAccount(true);
          }} title="可选：登录站点以同步书架 / 解锁受限内容">
            <Icon name="book" size={16} /> 站点账号
          </button>
          <button className="btn" onClick={() => setShowManage(true)}>
            <Icon name="settings" size={16} /> 书源管理
          </button>
        </div>
      </div>

      {/* 我的在线书架 */}
      {!!shelf.length && !onlineReader && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>我的在线书架</h2>
            <span className="muted">{shelf.length} 本 · 在线阅读，进度自动保存</span>
          </div>
          <div className="comic-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
            {shelf.map((it) => (
              <div key={it.id} className="comic-card" style={{ cursor: 'pointer' }} onClick={() => openShelfItem(it)}>
                <div className="cover">
                  {it.coverProxy ? (
                    <img src={it.coverProxy} alt={it.title} loading="lazy" />
                  ) : (
                    <div className="cover-empty"><Icon name="book" size={26} /></div>
                  )}
                  <span className="wide-tag" style={{ position: 'absolute', top: 6, left: 6 }}>
                    {it.kind === 'novel' ? '小说' : '漫画'}
                  </span>
                </div>
                <div className="card-body">
                  <div className="card-title" title={it.title}>{it.title}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {it.progress ? (
                      <span className="shelf-continue" title="点击继续阅读">
                        <Icon name="play" size={11} /> 继续阅读 · {it.progress.chapterTitle || `第 ${it.progress.pageIndex + 1} 页`}
                      </span>
                    ) : (`开始阅读 · ${it.sourceName}`)}
                  </div>
                </div>
                <button
                  className="btn sm ghost"
                  style={{ position: 'absolute', top: 6, right: 6, opacity: 0.85 }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      if (it.id.startsWith('local_')) onlineShelfLocal.remove(it.id);
                      else await onlineApi.removeFromShelf(it.id);
                      refreshShelf();
                    } catch (err) { errorToast(err, '移除失败'); }
                  }}
                  title="从书架移除"
                >×</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 漫画 / 小说 分类 */}
      {!onlineReader && (
        <div className="row" style={{ gap: 10, marginBottom: 12 }}>
          {([['comic', '漫画'], ['novel', '小说']] as [MediaTab, string][]).map(([k, label]) => (
            <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => {
              setTab(k); setResults([]); setDetail(null); setKw(''); setSearched(false);
      const first = list.find((s) => (s.mediaType || 'comic') === k)?.id || ALL_SOURCES;
      setActiveId(first);
      if (first) loadDiscover(first, 0, 1);
            }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {!onlineReader && (
        <>
          {/* 书源选择 */}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <button
              className={`btn sm ${isAll ? 'primary' : ''}`}
              onClick={() => { setActiveId(ALL_SOURCES); setDetail(null); setKw(''); setSearched(false); loadDiscover(ALL_SOURCES, 0, 1); }}
              title="跨所有来源聚合搜索与发现，按标题去重"
            >
              <Icon name="grid" size={14} /> 全部{tab === 'comic' ? '漫画' : '小说'}（{tabSources.length} 源）
            </button>
            {tabSources.map((s) => (
              <button
                key={s.id}
                className={`btn sm ${s.id === activeId ? 'primary' : ''}`}
                onClick={() => { setActiveId(s.id); setDetail(null); setKw(''); loadDiscover(s.id, 0, 1); }}
              >
                <Icon name="globe" size={14} /> {s.name}
              </button>
            ))}
            {!tabSources.length && (
              loadError ? (
                <span className="muted" style={{ color: 'var(--danger, #e5484d)' }}>
                  书源加载失败：{loadError}
                  <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { setLoadError(''); load(); }}>重试</button>
                </span>
              ) : <span className="muted">这个分类还没有来源</span>
            )}
          </div>

          {/* 搜索 */}
          <div className="row" style={{ gap: 8, marginBottom: 18 }}>
            <input
              className="input"
              style={{ maxWidth: 420 }}
              placeholder={tab === 'novel' ? '输入小说名搜索…' : '输入漫画名搜索…'}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button className="btn primary" onClick={() => doSearch()} disabled={searching || (!active && !isAll)}>
              {searching ? <Icon name="spinner" size={16} className="spin" /> : <Icon name="search" size={16} />}
              搜索
            </button>
            <button
              className={`btn sm ${searchMode === 'exact' ? 'primary' : ''}`}
              onClick={() => {
                const next = searchMode === 'fuzzy' ? 'exact' : 'fuzzy';
                setSearchMode(next);
                if (kw.trim() && searched) doSearch(next);
              }}
              title="模糊：包含关键词；精准：标题完全一致"
            >
              {searchMode === 'exact' ? '🎯 精准' : '🔍 模糊'}
            </button>
          </div>

          {/* 发现分类（未搜索时显示） */}
          {!searched && !detail && !!discoverTabs.length && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {discoverTabs.map((t) => (
                <button key={t.index} className={`chip ${discoverTab === t.index ? 'active' : ''}`}
                  onClick={() => loadDiscover(activeId, t.index, 1)}>{t.title}</button>
              ))}
            </div>
          )}
          {!searched && !detail && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15, marginTop: 4 }}>发现 · {isAll ? `全部${tab === 'comic' ? '漫画' : '小说'}` : (active?.name || '')}</h2>
              {!searched && discoverMaxPage > 1 && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" disabled={discovering || discoverPage <= 1}
                    onClick={() => loadDiscover(activeId, discoverTab, discoverPage - 1)}>← 上一页</button>
                  <span className="muted">{discoverPage} / {discoverMaxPage}</span>
                  <button className="btn sm" disabled={discovering || discoverPage >= discoverMaxPage}
                    onClick={() => loadDiscover(activeId, discoverTab, discoverPage + 1)}>下一页 →</button>
                </div>
              )}
            </div>
          )}

          {/* 搜索/发现结果 */}
          {!!results.length && !detail && (
            <div className="comic-grid">
              {results.map((r, i) => (
                <div key={i} className="comic-card" style={{ cursor: 'pointer' }} onClick={() => openComic(r)}>
                  <div className="cover">
                    {r.cover ? <img src={coverUrl(r.sourceId || activeId, r.cover)} alt={r.title} loading="lazy" /> : (
                      <div className="cover-empty"><Icon name="book" size={30} /></div>
                    )}
                  </div>
                  <div className="card-body">
                    <div className="card-title">{r.title}</div>
                    {r.author && <div className="muted" style={{ fontSize: 12 }}>{r.author}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 详情 */}
          {detail && (
            <div className="panel" style={{ marginTop: 4 }}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                {detail.cover && (
                  <img src={coverUrl(detailSourceId, detail.cover)} alt="" style={{ width: 120, borderRadius: 10, flex: 'none' }} />
                )}
                <div style={{ flex: 1, minWidth: 220 }}>
                  <h2 style={{ margin: '0 0 8px' }}>{detail.title}</h2>
                  {!!detail.author && <div className="muted" style={{ marginBottom: 6 }}>{detail.author}</div>}
                  {!!detail.description && (
                    <p className="muted" style={{ fontSize: 13, marginTop: 0, maxHeight: 84, overflow: 'hidden' }}>
                      {detail.description}
                    </p>
                  )}
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn sm" onClick={() => setDetail(null)}>← 返回</button>
                    <button className={`btn sm ${bookmarked ? 'primary' : ''}`} onClick={() => bookmark(detail)}>
                      <Icon name="star" size={14} /> {bookmarked ? '已在书架' : '收藏到书架'}
                    </button>
                    {detail.chapters && (
                      <>
                        <button className="btn sm" onClick={() => setDetail((d) => (d ? { ...d, checked: new Set(d.chapters!.map((_, i) => i)) } : d))}>全选</button>
                        <button className="btn sm" onClick={() => setDetail((d) => (d ? { ...d, checked: new Set() } : d))}>清空</button>
                        <span className="muted">已选 {detail.checked.size} / {detail.chapters.length} 话</span>
                      </>
                    )}
                  </div>
                  <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                    {detail.chapters ? (
                      <button className="btn primary" onClick={importChapters} disabled={!!importing || !detail.checked.size}>
                        <Icon name="download" size={16} />
                        {importing ? `导入中 ${importing.done}/${importing.total}…` : '导入选中章节到书库'}
                      </button>
                    ) : (
                      <button className="btn primary" onClick={importNovelBook} disabled={novelImporting}>
                        <Icon name="download" size={16} />
                        {novelImporting ? '正在整本导入…' : '整本加入书库（自动分章，可编辑）'}
                      </button>
                    )}
                    {importedComicId && (
                      <Link className="btn" to={`/comic/${importedComicId}`}>查看已入库的{detail.kind === 'novel' ? '小说' : '漫画'}</Link>
                    )}
                  </div>
                  {importing && (
                    <div style={{ marginTop: 10, maxWidth: 420 }}>
                      <div className="progress-mini">
                        <i style={{ width: `${Math.round((importing.done / importing.total) * 100)}%` }} />
                      </div>
                      {importProgressLabel && <div className="muted sm-text" style={{ marginTop: 4 }}>{importProgressLabel}</div>}
                    </div>
                  )}
                </div>
              </div>

              {/* 章节列表（漫画）：勾选导入 + 单话在线阅读 */}
              {detail.chapters && (
                <div
                  className="chapter-list"
                  style={{ marginTop: 16, maxHeight: 380, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 }}
                >
                  {detail.chapters.map((ch, i) => (
                    <label
                      key={i}
                      className="chapter-item"
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}
                    >
                      <input
                        type="checkbox"
                        checked={detail.checked.has(i)}
                        onChange={() =>
                          setDetail((d) => {
                            if (!d) return d;
                            const next = new Set(d.checked);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return { ...d, checked: next };
                          })
                        }
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{ch.title}</span>
                      <button
                        className="btn sm ghost"
                        title="在线阅读（不下载）"
                        onClick={(e) => {
                          e.preventDefault();
                          startOnlineRead(detail.bookId || '', detail.chapters || [], i, shelf.find((x) => x.key === `${detailSourceId.replace(/^js:/, '')}:${detail.bookId}`));
                        }}
                      >▶</button>
                    </label>
                  ))}
                </div>
              )}
              {!detail.chapters && (
                <p className="muted" style={{ marginTop: 14 }}>
                  小说整本下载后自动分章入书库；也可以先收藏到书架，随时回来导入。
                </p>
              )}
            </div>
          )}

          {!results.length && !detail && !searching && !discovering && (
            <div className="empty">
              <h3>{searched ? '没有找到结果' : '这个来源暂时没有可浏览的内容'}</h3>
              <p>{searched ? '换个关键词或书源试试。' : '可以在上方搜索框输入名称，或换一个来源。'}</p>
            </div>
          )}
          {discovering && !results.length && (
            <div className="empty"><p>正在加载…</p></div>
          )}
        </>
      )}

      {onlineReader && (
        <OnlineReader
          state={onlineReader}
          onExit={() => { setOnlineReader(null); refreshShelf(); }}
          onStateChange={(next) => setOnlineReader((prev) => {
            if (!prev) return prev;
            return typeof next === 'function' ? next(prev) : { ...next };
          })}
        />
      )}

      {showAccount && (
        <Modal title="站点账号（可选）" onClose={() => setShowAccount(false)} width={560}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.8, marginBottom: 12 }}>
            当前来源：<b>{active?.name || '未选择'}</b><br />
            登录<b>不是必须</b>的——不登录也能浏览、搜索、免费内容。登录只用于<b>同步个人书架 / 收藏</b>或<b>解锁会员/受限内容</b>（和 kira / ciallo reader 一样）。
          </div>
          {!sessionUser && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
              💡 浏览和打开官网无需登录；但若要用「账号密码登录」或「保存 Cookie」把登录态同步到书架，需先登录本站账号（右上角「登录 / 注册」）。
            </div>
          )}

          {/* 方式一：打开官网直接登录（推荐，和 kira / ciallo reader 一致） */}
          {accountInfo.website && (
            <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>① 打开官网登录（推荐）</div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                点下面按钮在新窗口打开该站点，登录你的账号。登录后回到这里，用「方式二」一键粘贴 Cookie 即可（多数浏览器已自动复制）。
              </div>
              <a className="btn primary" href={accountInfo.website} target="_blank" rel="noopener noreferrer">
                <Icon name="globe" size={15} /> 打开官网登录
              </a>
            </div>
          )}

          {/* 方式二：账号密码直接登录（源支持时） */}
          {accountInfo.canPasswordLogin && (
            <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>② 账号密码登录</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="账号 / 手机号"
                  value={accountUser} onChange={(e) => setAccountUser(e.target.value)} />
                <input className="input" type="password" style={{ flex: 1, minWidth: 140 }} placeholder="密码"
                  value={accountPwd} onChange={(e) => setAccountPwd(e.target.value)} />
                <button className="btn" onClick={async () => {
                  if (!activeId || !accountUser.trim() || !accountPwd) { errorToast(new Error('请填写账号和密码'), '登录失败'); return; }
                  try {
                    const r = await sourcesApi.accountLogin(activeId, accountUser.trim(), accountPwd);
                    if (!r.ok) throw new Error(r.error || '登录失败');
                    toast(r.message || '登录成功');
                    setAccountPwd('');
                  } catch (err) { errorToast(err, '登录失败'); }
                }}>登录</button>
              </div>
            </div>
          )}

          {/* 方式三：粘贴 Cookie（兜底，所有源通用） */}
          <div className="panel" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>③ 粘贴 Cookie（通用兜底）</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              在官网登录后的页面按 F12 → Network → 任选请求 → 复制请求头 Cookie，粘贴到下面。留空保存 = 清除登录态。
            </div>
            <textarea
              className="textarea" rows={3} value={accountCookie}
              onChange={(e) => setAccountCookie(e.target.value)}
              placeholder="key1=value1; key2=value2"
              style={{ fontFamily: 'monospace', fontSize: 11, width: '100%' }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn sm primary" onClick={async () => {
                if (!activeId) { errorToast(new Error('请先选择一个来源'), '保存失败'); return; }
                try {
                  const r = await sourcesApi.saveCookies(activeId, accountCookie.trim());
                  toast(r.cleared ? '已清除该站点登录态' : `已保存登录态（${r.count || 0} 项）`);
                  setShowAccount(false);
                } catch (err) { errorToast(err, '保存失败'); }
              }}>保存 Cookie</button>
            </div>
          </div>
        </Modal>
      )}

      {showManage && (
        <SourceManager
          list={list}
          onClose={() => setShowManage(false)}
          onChanged={() => {
            setList([]);
            setActiveId('');
            load();
          }}
        />
      )}
    </main>
  );
}

/* ------------------------------ 在线阅读器（复用 ReaderView，按话拉取） ------------------------------ */

interface OnlineReaderState {
  sourceKey: string;
  sourceId: string;
  bookId: string;
  title: string;
  chapters: Chapter[];
  index: number;
  shelfId: string;
}

function OnlineReader({
  state,
  onExit,
  onStateChange,
}: {
  state: OnlineReaderState;
  onExit: () => void;
  onStateChange: (s: OnlineReaderState | ((prev: OnlineReaderState) => OnlineReaderState)) => void;
}) {
  const errorToast = useErrorToast();

  async function ensurePages(ch: Chapter) {
    try {
      const r = await onlineApi.chapterImages(state.sourceKey, state.bookId, ch.id);
      const pages: Page[] = (r.images || []).map((u, i) => ({ id: `${ch.id}_${i}`, url: u, file: '', width: 0, height: 0 }));
      // 用函数式更新基于最新 state 追加，避免链式多章并发加载时旧闭包互相覆盖，
      // 导致刚加载好的章节 pages 被后来的空 state 清掉（表现为"一话只显示几张就没了"）。
      onStateChange((prev) => ({
        ...prev,
        chapters: prev.chapters.map((c) => (c.id === ch.id && !c.pages.length ? { ...c, pages } : c)),
      }));
    } catch (err) {
      errorToast(err, '本章加载失败');
    }
  }

  const saveProgress = (chapterId: string, pageIndex: number) => {
    if (!state.shelfId) return;
    const ch = state.chapters.find((c) => c.id === chapterId);
    const payload = { chapterUrl: chapterId, chapterTitle: ch?.title || '', pageIndex };
    if (state.shelfId.startsWith('local_')) {
      // 未登录的本地兜底项：进度写 localStorage
      onlineShelfLocal.progress(state.shelfId, payload);
    } else {
      onlineApi.progress(state.shelfId, payload).catch(() => {
        // 云端写入失败（登录态失效）时降级为本地，按 key 找到对应本地/远程项
        const key = `${state.sourceKey}:${state.bookId}`;
        const local = onlineShelfLocal.find(key);
        if (local) onlineShelfLocal.progress(local.id, payload);
        else {
          const added = onlineShelfLocal.add({
            sourceKey: state.sourceKey,
            sourceName: '',
            bookId: state.bookId,
            title: state.title,
            kind: 'comic',
          });
          onlineShelfLocal.progress(added.id, payload);
        }
      });
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'var(--bg-1, #0b0f14)' }}>
      <ReaderView
        title={`[在线] ${state.title}`}
        chapters={state.chapters}
        direction="ltr"
        initialChapterId={state.chapters[state.index]?.id}
        onExit={onExit}
        ensurePages={ensurePages}
        onProgress={saveProgress}
      />
    </div>
  );
}

/* ------------------------------ 书源管理弹窗 ------------------------------ */
function SourceManager({
  list,
  onClose,
  onChanged,
}: {
  list: SourceInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [rulesText, setRulesText] = useState(
    JSON.stringify(
      {
        search: { url: '/search?q={kw}', item: '.item', title: '.title@text', link: 'a@href', cover: 'img@src|data-src' },
        comic: { title: 'h1@text', cover: '.cover img@src|data-src', chapterItem: '.chapter a', chapterTitle: '@text', chapterLink: '@href' },
        chapter: { image: '.content img@src|data-src|data-original', nextPage: 'a:contains("下一页")@href' },
      },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const errorToast = useErrorToast();

  async function save() {
    let rules: Record<string, Record<string, string>>;
    try {
      rules = JSON.parse(rulesText);
    } catch {
      return toast('规则不是合法 JSON', 'err');
    }
    setBusy(true);
    try {
      await sourcesApi.save({ name, baseUrl, rules });
      toast('书源已保存');
      setName('');
      setBaseUrl('');
      onChanged();
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="书源管理" icon={<Icon name="globe" />} onClose={onClose} width={640}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !baseUrl.trim()}>
            保存书源
          </button>
        </>
      }>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        内置 JS 来源来自开源项目 Ciallo-Reader（MIT），随软件更新维护。
        你也可以添加自己的规则书源（选择器写法：<code>.thumb img@data-src</code> 取属性，<code>@text</code> 取文本，<code>|</code> 列多个兜底）。
      </p>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>内置 JS 来源</label>
        {list.filter((s) => s.kind === 'js').map((s) => (
          <div key={s.id} className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span style={{ flex: 1 }}>{s.name} <span className="muted">（{(s.mediaType || 'comic') === 'novel' ? '小说' : '漫画'} · {s.baseUrl}）</span></span>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>自定义书源名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：某漫画站" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>站点地址</label>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com" />
        </div>
      </div>
      <div className="field">
        <label>解析规则（JSON）</label>
        <textarea className="input" rows={12} value={rulesText} onChange={(e) => setRulesText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </div>
      {!!list.filter((s) => !s.builtin).length && (
        <div className="field">
          <label>自定义书源</label>
          {list
            .filter((s) => !s.builtin)
            .map((s) => (
              <div key={s.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
                <span style={{ flex: 1 }}>{s.name} <span className="muted">（{s.baseUrl}）</span></span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await sourcesApi.remove(s.id);
                      toast('已删除');
                      onChanged();
                    } catch (err) {
                      errorToast(err, '删除失败');
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
