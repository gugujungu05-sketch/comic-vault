import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ReaderView } from '../components/ReaderView';
import CoverImage from '../components/CoverImage';
import { useErrorToast, useToast } from '../components/Toasts';
import { useSession } from '../lib/session';
import { online as onlineApi, sources as sourcesApi, mediaUrl } from '../lib/api';
import { importTaskStore } from '../lib/importTask';
import { onlineShelfLocal } from '../lib/onlineShelfLocal';
import { blockedTags, LOTTERY_SCOPE, allScope, normalizeTag } from '../lib/blockedTags';
import type {
  OnlineShelfItem,
  SourceChapterItem,
  SourceComicDetail,
  SourceInfo,
  SourceSearchItem,
  SourceTagStat,
  LotteryItem,
  LotteryGenre,
} from '../lib/api';
import type { Chapter, Page } from '../types';

type MediaTab = 'comic' | 'novel';

/** 「全部漫画 / 全部小说」虚拟聚合源 */
const ALL_SOURCES = '__all__';

/**
 * pstatic.net（Naver/WEBTOON 图片 CDN）在服务器端部署网络被 DNS 污染/封锁，
 * 服务端代理必 502；但用户浏览器通常可直连（韩国 CDN 在多数地区可达）。
 * 这类图片改走浏览器直连原图，<img> 跨域可正常显示；失败由 CoverImage 降级占位。
 */
function isBrowserDirectImage(url: string): boolean {
  return /^https?:\/\/[a-z0-9.-]*pstatic\.net\//i.test(url);
}

/** 在线来源封面：走服务端代理（绕过跨域/防盗链）；pstatic.net 走浏览器直连 */
function coverUrl(sid: string | undefined, url: string | undefined): string {
  if (!url) return '';
  // pstatic.net 服务端不可达，交给浏览器直连原图（mediaUrl 对绝对 URL 原样返回）
  if (isBrowserDirectImage(url)) return mediaUrl(url);
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
  /** 书架视图：收藏（主动加入） / 历史（在线阅读自动记录），彻底分开显示 */
  const [shelfView, setShelfView] = useState<'favorite' | 'history'>('favorite');
  const [bookmarked, setBookmarked] = useState(false);
  const [novelImporting, setNovelImporting] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [accountCookie, setAccountCookie] = useState('');
  const [accountInfo, setAccountInfo] = useState<{ website: string; canPasswordLogin: boolean; loggedIn: boolean; cookieCount: number; credentialCount: number }>({ website: '', canPasswordLogin: false, loggedIn: false, cookieCount: 0, credentialCount: 0 });
  const [accountUser, setAccountUser] = useState('');
  const [accountPwd, setAccountPwd] = useState('');
  // 各源登录态：顶栏「站点账号」按钮显示当前源是否已登录（不依赖弹窗打开）
  const [loginStatus, setLoginStatus] = useState<Record<string, { loggedIn: boolean; cookieCount: number; credentialCount: number }>>({});
  const activeLogin = activeId ? loginStatus[activeId] : undefined;
  const [onlineReader, setOnlineReader] = useState<OnlineReaderState | null>(null);
  /* 抽奖机：按类型/题材从所有源抽取书籍，跨源去重 */
  const [showLottery, setShowLottery] = useState(false);
  const [lotteryGenres, setLotteryGenres] = useState<LotteryGenre[]>([]);
  const [lotteryGenre, setLotteryGenre] = useState('all');
  const [lotteryMedia, setLotteryMedia] = useState<'comic' | 'novel' | 'all'>('all');
  const [lotteryCount, setLotteryCount] = useState(12);
  const [lotteryItems, setLotteryItems] = useState<LotteryItem[]>([]);
  const [lotteryPoolSize, setLotteryPoolSize] = useState(0);
  const [lotteryRolling, setLotteryRolling] = useState(false);
  const [lotteryMsg, setLotteryMsg] = useState('');
  /* 标签屏蔽：每个源 / 抽奖机各自维护一份被屏蔽标签清单 */
  const [blockScope, setBlockScope] = useState('');          // 当前屏蔽设置针对的 scope（源 id / __lottery__ / __all_*__）
  const [blockScopeName, setBlockScopeName] = useState('');  // 展示用名称
  const [showBlock, setShowBlock] = useState(false);
  const [blockTags, setBlockTags] = useState<SourceTagStat[]>([]);
  const [blockLoading, setBlockLoading] = useState(false);
  const [blockSelected, setBlockSelected] = useState<string[]>([]); // 选中的标签原文（提交时归一化）
  const [blockRev, setBlockRev] = useState(0); // 屏蔽变更版本号，驱动已加载结果重新过滤
  /* 浏览器返回键：把「详情(1)/阅读器(2)」当作历史层压入 history.state，
     popstate 时按目标层卸载对应 UI，而不是让浏览器退回主页。 */
  const viewLayerRef = useRef(0);
  const toast = useToast();
  const errorToast = useErrorToast();

  const active = list.find((s) => s.id === activeId) || null;
  const tabSources = useMemo(() => list.filter((s) => (s.mediaType || 'comic') === tab), [list, tab]);
  /** 聚合模式：跨当前分类的所有书源搜索/发现，结果去重 */
  const isAll = activeId === ALL_SOURCES;
  // 详情可能来自「全部」聚合结果，必须用结果自带的来源，而不是当前选中的虚拟源
  const detailSourceId = detail?.sourceId || activeId;
  const detailSourceName = detail?.sourceName || active?.name || '';

  // 收藏 / 阅读历史分开：收藏=主动加入(favorite!==false)；历史=有阅读进度(progress)
  const favShelf = useMemo(() => shelf.filter((x) => x.favorite !== false), [shelf]);
  const historyShelf = useMemo(
    () => shelf.filter((x) => !!x.progress).sort((a, b) => (b.progress!.updatedAt || 0) - (a.progress!.updatedAt || 0)),
    [shelf],
  );
  const shownShelf = shelfView === 'favorite' ? favShelf : historyShelf;

  async function load() {
    try {
      const [r, s] = await Promise.all([sourcesApi.list(), onlineApi.shelf().catch(() => ({ items: [] }))]);
      setList(r.sources);
      setLoadError('');
      // 未登录云端书架为空时，本地兜底书架仍要显示，保证收藏/阅读历史不丢
      setShelf(mergedShelf(s.items || []));
      // 并发拉取每个源的登录态，顶栏按钮据此显示「已登录」角标
      refreshLoginStatus(r.sources);
      const first = r.sources.find((x) => (x.mediaType || 'comic') === tab)?.id || ALL_SOURCES;
      setActiveId((cur) => cur || first);
      if (first) loadDiscover(first, 0, 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '网络异常');
      errorToast(err, '加载书源失败');
    }
  }

  async function refreshLoginStatus(sources = list) {
    const real = sources.filter((s) => s.id !== ALL_SOURCES);
    if (!real.length) return;
    const pairs = await Promise.all(real.map(async (s) => {
      try {
        const r = await sourcesApi.getCookies(s.id);
        return [s.id, { loggedIn: !!r.loggedIn, cookieCount: r.cookieCount || 0, credentialCount: r.credentialCount || 0 }] as const;
      } catch { return [s.id, { loggedIn: false, cookieCount: 0, credentialCount: 0 }] as const; }
    }));
    setLoginStatus(Object.fromEntries(pairs));
  }

  /** 某个 scope 生效的屏蔽标签（归一化 key）。聚合视图会合并该分类下所有源的屏蔽。 */
  function effectiveBlocked(scope: string): string[] {
    if (scope.startsWith('__all_')) {
      const t = tab === 'novel' ? 'novel' : 'comic';
      return blockedTags.merge(allScope(t), ...list.filter((s) => (s.mediaType || 'comic') === t).map((s) => s.id));
    }
    return blockedTags.get(scope);
  }

  /** 打开屏蔽设置：加载 scope 的标签整合清单 + 已选中的标签 */
  async function openBlockSettings(scope: string, name: string) {
    setBlockScope(scope);
    setBlockScopeName(name);
    setBlockSelected(blockedTags.get(scope));
    setShowBlock(true);
    setBlockTags([]);
    setBlockLoading(true);
    try {
      // 抽奖机 / 聚合视图用全局标签整合；单源用该源的标签（scope 保留 js: 前缀，与后端路由一致）
      const isGlobal = scope === LOTTERY_SCOPE || scope.startsWith('__all_');
      const r = isGlobal ? await sourcesApi.allTags() : await sourcesApi.sourceTags(scope);
      setBlockTags(r.tags || []);
    } catch (err) {
      errorToast(err, '标签整合失败');
    } finally {
      setBlockLoading(false);
    }
  }

  /** 保存屏蔽设置并让已加载的结果立即重新过滤 */
  function saveBlockSettings() {
    blockedTags.set(blockScope, blockSelected);
    setBlockRev((v) => v + 1);
    setShowBlock(false);
    toast(blockSelected.length ? `已屏蔽 ${blockSelected.length} 个标签` : '已清空屏蔽设置');
  }

  /** 当前浏览视图（单源 / 聚合）生效的屏蔽清单 */
  const viewBlocked = useMemo(() => {
    const scope = isAll ? allScope(tab) : activeId;
    return scope ? effectiveBlocked(scope) : [];
    // blockRev/list 变化都要重算：list 决定聚合时要合并哪些源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAll, tab, activeId, blockRev, list]);

  /** 结果前端再过一道屏蔽：聚合模式结果在本地合并、抽奖书池在服务端过滤，这里统一兜底 */
  const shownResults = useMemo(() => results.filter((it) => !blockedTags.isBlocked(it.tags, viewBlocked)), [results, viewBlocked]);

  /* ---- 历史层管理：详情=1，阅读器=2，列表=0 ---- */
  const setLayer = (n: number) => { viewLayerRef.current = n; };
  function pushLayer(n: number) {
    if (n <= viewLayerRef.current) return;
    // 合并保留 React Router 自身的 state 字段，避免干扰路由前进/后退
    try { window.history.pushState({ ...(window.history.state || {}), cvSourcesLayer: n }, ''); } catch { /* 忽略 */ }
    setLayer(n);
  }
  function backOneLayer() {
    if (viewLayerRef.current > 0) window.history.back(); // popstate 统一卸载
  }
  function resetToList() {
    // 切 tab/源/搜索时把当前历史条目标记为列表层（不动栈深，避免误跳主页）
    try { window.history.replaceState({ ...(window.history.state || {}), cvSourcesLayer: 0 }, ''); } catch { /* 忽略 */ }
    setLayer(0);
    setDetail(null);
  }

  useEffect(() => {
    // 进入本页时把当前条目标记为列表层 0
    try { window.history.replaceState({ ...(window.history.state || {}), cvSourcesLayer: 0 }, ''); } catch { /* 忽略 */ }
    setLayer(0);
    const onPop = (e: PopStateEvent) => {
      const target = (e.state && e.state.cvSourcesLayer) || 0;
      setLayer(target);
      if (target <= 0) {
        setOnlineReader(null);
        setDetail(null);
        refreshShelf();
      } else if (target === 1) {
        setOnlineReader(null); // 从阅读器退回详情
        refreshShelf();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // 渐进式渲染——每个源返回就立即追加到列表，快的源先显示，慢源不阻塞整屏；
        // 单个源 12s 超时，失效源直接跳过。这样首屏不再等最慢的源（此前 8s 超时会丢慢源）。
        type Disco = Awaited<ReturnType<typeof sourcesApi.discover>>;
        const sources = tabSources;
        const seen = new Set<string>();
        const tabsSeen: NonNullable<Disco['tabs']> = [];
        setResults([]);
        setDiscoverTabs([]);
        setDiscoverMaxPage(1);
        setDiscoverTab(tab);
        setDiscoverPage(page);
        setSearched(false);
        const withTimeout = (p: Promise<Disco | null>) => Promise.race([
          p,
          new Promise<null>((r) => setTimeout(() => r(null), 12000)),
        ]);
        await Promise.all(sources.map(async (s) => {
          const r = await withTimeout(
            sourcesApi.discover(s.id, tab, page, blockedTags.get(s.id)).catch(() => null),
          );
          if (!r) return;
          // 按源批量去重后一次性追加，减少 setState 次数
          const add: SourceSearchItem[] = [];
          for (const it of r.items || []) {
            const key = it.title.trim();
            if (seen.has(key)) continue;
            seen.add(key);
            add.push({ ...it, sourceId: s.id, sourceName: s.name });
          }
          if (add.length) setResults((prev) => [...prev, ...add]);
          if (r.tabs?.length && !tabsSeen.length) { tabsSeen.push(...r.tabs); setDiscoverTabs(r.tabs); }
          if ((r.maxPage || 1) > 1) setDiscoverMaxPage((m) => Math.max(m, r.maxPage || 1));
        }));
      } else {
        const r = await sourcesApi.discover(sid, tab, page, blockedTags.get(sid));
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

  /** 打开抽奖机：题材清单只拉一次 */
  async function openLottery() {
    setShowLottery(true);
    if (!lotteryGenres.length) {
      try { setLotteryGenres((await sourcesApi.lotteryGenres()).genres || []); } catch {}
    }
  }

  /** 抽一次：先显示滚动动画，再落结果（首抽会构建书池，稍慢；之后跨源书池命中缓存秒开） */
  async function drawLottery(refresh = false) {
    if (lotteryRolling) return;
    setLotteryRolling(true);
    setLotteryMsg('');
    try {
      const genres = lotteryGenre === 'all' ? ['all'] : [lotteryGenre];
      const r = await sourcesApi.lottery({
        media: lotteryMedia, genres, count: lotteryCount, refresh,
        blocked: blockedTags.get(LOTTERY_SCOPE),
      });
      // 至少滚一帧动画，避免命中缓存时瞬间跳出、没有抽奖手感
      await new Promise((res) => setTimeout(res, 620));
      // 前端再过一道屏蔽（与服务端规则一致，双保险）
      const lottoBlocked = blockedTags.get(LOTTERY_SCOPE);
      setLotteryItems((r.items || []).filter((it) => !blockedTags.isBlocked(it.tags, lottoBlocked)));
      setLotteryPoolSize(r.poolSize || 0);
      if (!r.items?.length) setLotteryMsg('这个题材暂时没抽到书，换个题材或点「换一批」试试');
    } catch (err) {
      setLotteryMsg('抽奖失败，请稍后重试');
      errorToast(err, '抽奖失败');
    } finally {
      setLotteryRolling(false);
    }
  }

  async function doSearch(modeOverride?: 'fuzzy' | 'exact') {
    if (!kw.trim()) return;
    const mode = modeOverride || searchMode;
    const targets = isAll ? tabSources : (active ? [active] : []);
    if (!targets.length) return;
    setSearching(true);
    // 从书籍详情里再次搜索时，先退出详情，否则结果被详情面板遮住，看起来像「搜索没反应」
    resetToList();
    setResults([]);
    try {
      const rs = await Promise.all(targets.map((s) =>
        sourcesApi.search(s.id, kw.trim(), 1, blockedTags.get(s.id)).catch(() => ({ items: [] as SourceSearchItem[] })),
      ));
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
      // 部分源（如我爱漫画网）详情页只给占位封面，但列表卡片里有真实封面；用列表封面兜底
      const detailCover = /zwfm|\/static\/|logo/i.test(r.cover || '') && item.cover ? item.cover : r.cover;
      setDetail({
        ...r,
        cover: detailCover,
        sourceId: sid,
        sourceName: item.sourceName || active?.name || '',
        bookId: r.bookId || item.link,
        checked: new Set((r.chapters || []).map((_, i) => i)),
      });
      pushLayer(1); // 详情纳入浏览器历史，返回键先关详情
      const s = await onlineApi.shelf().catch(() => ({ items: [] as OnlineShelfItem[] }));
      const allShelf = onlineShelfLocal.merge(s.items || []);
      // 只有主动收藏才算「已在书架」；仅阅读历史的不算，避免收藏按钮状态错乱
      setBookmarked(!!allShelf.find((x) => x.key === `${sid.replace(/^js:/, '')}:${r.bookId || item.link}` && x.favorite !== false));
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
      pushLayer(1); // 详情纳入历史，返回键先回列表而不是跳主页
      setActiveId(sourceId);
      setTab(item.kind);
      // 从历史视图打开的书不一定被收藏，按实际标记显示收藏按钮状态
      setBookmarked(item.favorite !== false);
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
        // 取消收藏：只翻 favorite 标记，不删条目——若这本书有阅读历史要保留在「历史」里
        const it = shelf.find((x) => x.key === key);
        if (it) {
          if (!sessionUser && it.id.startsWith('local_')) onlineShelfLocal.setFavorite(it.id, false);
          else await onlineApi.setFavorite(it.id, false);
        }
        setBookmarked(false);
        toast('已取消收藏（阅读记录仍保留在历史）');
      } else {
        const it = shelf.find((x) => x.key === key);
        if (it) {
          // 已在历史里（自动阅读加入过）：直接翻为收藏，不重复建条目
          if (!sessionUser && it.id.startsWith('local_')) onlineShelfLocal.setFavorite(it.id, true);
          else await onlineApi.setFavorite(it.id, true);
        } else if (sessionUser) {
          await onlineApi.addToShelf({ sourceId: sid, ...addInput, favorite: true });
        } else {
          // 未登录：写本地兜底书架
          onlineShelfLocal.add({ ...addInput, favorite: true });
        }
        setBookmarked(true);
        toast('已收藏到书架');
      }
      refreshShelf();
    } catch (err) {
      // 云端写入失败（如登录态失效）时降级为本地，避免收藏丢失
      if (!bookmarked) {
        const it = shelf.find((x) => x.key === key);
        if (it && it.id.startsWith('local_')) onlineShelfLocal.setFavorite(it.id, true);
        else onlineShelfLocal.add({ ...addInput, favorite: true });
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
          // 仅记录阅读历史，不占用收藏：favorite=false
          const r = await onlineApi.addToShelf({ sourceId: detailSourceId, ...addInput, favorite: false });
          sid = r?.item?.id || '';
          refreshShelf();
        } catch { /* 云端失败降级为本地 */ }
      }
      // 未登录或云端失败：写入本地兜底书架，保证进度能记录（同样标记为历史）
      if (!sid) {
        sid = onlineShelfLocal.add({ ...addInput, favorite: false }).id;
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
    pushLayer(2); // 阅读器纳入历史，返回键退回详情/列表
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
        <div className="row" style={{ marginLeft: 'auto', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={openLottery} title="从所有来源按题材抽取多本书推荐">
            <Icon name="dice" size={16} /> 抽奖机
          </button>
          <button className="btn" onClick={async () => {
            setAccountCookie(''); setAccountUser(''); setAccountPwd('');
            if (activeId) {
              try {
                const info = await sourcesApi.getCookies(activeId);
                setAccountInfo({
                  website: info.website || '', canPasswordLogin: !!info.canPasswordLogin,
                  loggedIn: !!info.loggedIn, cookieCount: info.cookieCount || 0, credentialCount: info.credentialCount || 0,
                });
              } catch { setAccountInfo({ website: '', canPasswordLogin: false, loggedIn: false, cookieCount: 0, credentialCount: 0 }); }
            }
            setShowAccount(true);
          }} title={activeLogin?.loggedIn ? '该源已保存登录态，点击查看 / 清除' : '可选：登录站点以解锁会员或受限章节'}>
            <Icon name="book" size={16} /> 站点账号
            {activeLogin?.loggedIn && <span className="acct-badge" title="当前源已登录">已登录</span>}
          </button>
          <button className="btn" onClick={() => setShowManage(true)}>
            <Icon name="settings" size={16} /> 书源管理
          </button>
        </div>
      </div>

      {/* 我的在线书架：收藏 / 阅读历史 分开 */}
      {!!shelf.length && !onlineReader && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>我的在线书架</h2>
            <div className="row" style={{ gap: 6 }}>
              <button className={`chip ${shelfView === 'favorite' ? 'active' : ''}`} onClick={() => setShelfView('favorite')}>
                <Icon name="star" size={12} /> 我的收藏 <span className="chip-count">{favShelf.length}</span>
              </button>
              <button className={`chip ${shelfView === 'history' ? 'active' : ''}`} onClick={() => setShelfView('history')}>
                <Icon name="clock" size={12} /> 阅读历史 <span className="chip-count">{historyShelf.length}</span>
              </button>
            </div>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              {shelfView === 'favorite' ? '主动收藏，长期保留' : '读过自动记录，进度随时续读'}
            </span>
          </div>
          {shownShelf.length ? (
            <div className="comic-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
              {shownShelf.map((it) => (
                <div key={it.id} className="comic-card" style={{ cursor: 'pointer' }} onClick={() => openShelfItem(it)}>
                  <div className="cover">
                    <CoverImage src={it.coverProxy} title={it.title} />
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
                        const isLocal = it.id.startsWith('local_');
                        if (shelfView === 'favorite') {
                          // 收藏视图：取消收藏，但保留阅读历史条目
                          if (isLocal) onlineShelfLocal.setFavorite(it.id, false);
                          else await onlineApi.setFavorite(it.id, false);
                          toast('已取消收藏，阅读记录保留在历史');
                        } else {
                          // 历史视图：删除这条阅读记录（若同时是收藏会一并移除）
                          if (isLocal) onlineShelfLocal.remove(it.id);
                          else await onlineApi.removeFromShelf(it.id);
                          toast('已删除阅读记录');
                        }
                        refreshShelf();
                      } catch (err) { errorToast(err, '移除失败'); }
                    }}
                    title={shelfView === 'favorite' ? '取消收藏（保留阅读历史）' : '删除这条阅读记录'}
                  >×</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {shelfView === 'favorite'
                ? '还没有收藏。在搜索结果详情里点「收藏到书架」即可添加。'
                : '还没有阅读记录。在线看过书后，这里会自动按最近阅读排序。'}
            </p>
          )}
        </section>
      )}

      {/* 漫画 / 小说 分类 */}
      {!onlineReader && (
        <div className="row" style={{ gap: 10, marginBottom: 12 }}>
          {([['comic', '漫画'], ['novel', '小说']] as [MediaTab, string][]).map(([k, label]) => (
            <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => {
              setTab(k); setResults([]); resetToList(); setKw(''); setSearched(false);
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
              onClick={() => { setActiveId(ALL_SOURCES); resetToList(); setKw(''); setSearched(false); loadDiscover(ALL_SOURCES, 0, 1); }}
              title="跨所有来源聚合搜索与发现，按标题去重"
            >
              <Icon name="grid" size={14} /> 全部{tab === 'comic' ? '漫画' : '小说'}（{tabSources.length} 源）
            </button>
            {tabSources.map((s) => {
              const h = s.health;
              const bad = h && !h.ok && !h.stale;
              const healthTitle = h
                ? `${h.ok ? '正常' : (h.stale ? '曾异常（有缓存可降级）' : '异常')}${h.ms ? ` · ${(h.ms / 1000).toFixed(1)}s` : ''}${h.items ? ` · ${h.items} 本` : ''}${h.err ? ` · ${h.err}` : ''}`
                : '尚未探测';
              return (
                <button
                  key={s.id}
                  className={`btn sm ${s.id === activeId ? 'primary' : ''}`}
                  onClick={() => { setActiveId(s.id); resetToList(); setKw(''); loadDiscover(s.id, 0, 1); }}
                  title={`${s.name} · ${healthTitle}`}
                  style={bad ? { borderColor: 'var(--danger, #e5484d)' } : undefined}
                >
                  <Icon name="globe" size={14} /> {s.name}
                  {bad && <span title="源异常，点此可尝试重新检测" style={{ color: 'var(--danger, #e5484d)', marginLeft: 4 }}>●</span>}
                </button>
              );
            })}
            <button
              className="btn sm ghost"
              title="重新探测所有源的健康状态（失效源恢复后即时回血）"
              onClick={async () => {
                try {
                  await sourcesApi.recheckHealth();
                  toast('正在重新检测所有源…');
                  // 稍后刷新列表以拿到最新健康状态
                  setTimeout(() => load(), 4000);
                } catch { toast('重新检测失败', 'err'); }
              }}
            >
              <Icon name="refresh" size={14} /> 重新检测
            </button>
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
              <div className="row" style={{ gap: 6 }}>
                <button
                  className={`btn sm ${viewBlocked.length ? 'primary' : ''}`}
                  onClick={() => openBlockSettings(isAll ? allScope(tab) : activeId, isAll ? `全部${tab === 'comic' ? '漫画' : '小说'}` : (active?.name || '当前源'))}
                  title="整合本源所有标签，选择要屏蔽的题材，带这些标签的书将不再出现"
                >
                  <Icon name="eye" size={14} /> 屏蔽标签
                  {viewBlocked.length > 0 && <span className="chip-count">{viewBlocked.length}</span>}
                </button>
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
            </div>
          )}

          {/* 搜索/发现结果 */}
          {!!shownResults.length && !detail && (
            <div className="comic-grid">
              {shownResults.map((r, i) => (
                <div key={i} className="comic-card" style={{ cursor: 'pointer' }} onClick={() => openComic(r)}>
                  <div className="cover">
                    <CoverImage src={r.cover ? coverUrl(r.sourceId || activeId, r.cover) : ''} title={r.title} />
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
                  <CoverImage src={coverUrl(detailSourceId, detail.cover)} title={detail.title} style={{ width: 120, borderRadius: 10, flex: 'none' }} />
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
                    <button className="btn sm" onClick={() => backOneLayer()}>← 返回</button>
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

          {!shownResults.length && !detail && !searching && !discovering && (
            <div className="empty">
              <h3>{viewBlocked.length && results.length ? '结果都被屏蔽了' : (searched ? '没有找到结果' : '这个来源暂时没有可浏览的内容')}</h3>
              <p>
                {viewBlocked.length && results.length
                  ? `当前有 ${viewBlocked.length} 个标签被屏蔽，点上方「屏蔽标签」可查看或调整。`
                  : (searched ? '换个关键词或书源试试。' : '可以在上方搜索框输入名称，或换一个来源。')}
              </p>
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
          onExit={() => backOneLayer()}
          onStateChange={(next) => setOnlineReader((prev) => {
            if (!prev) return prev;
            return typeof next === 'function' ? next(prev) : { ...next };
          })}
        />
      )}

      {/* 抽奖机：跨所有来源按类型/题材抽书，自动去重 */}
      {showLottery && (
        <Modal title="书籍抽奖机" icon={<Icon name="dice" />} onClose={() => setShowLottery(false)} width={720}>
          <p className="muted" style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.7 }}>
            从<b>所有来源</b>按类型与题材抽取书籍，自动<b>跨源去重</b>（同一本书只出现一次）。抽到后点封面即可查看详情、在线观看或加入书库。
          </p>

          {/* 类型 */}
          <div style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>类型</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {([['all', '全部'], ['comic', '漫画'], ['novel', '小说']] as const).map(([k, label]) => (
                <button key={k} className={`chip ${lotteryMedia === k ? 'active' : ''}`}
                  onClick={() => { setLotteryMedia(k); setLotteryItems([]); }}>{label}</button>
              ))}
            </div>
          </div>

          {/* 题材标签 */}
          <div style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>题材标签</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(lotteryGenres.length ? lotteryGenres : [{ id: 'all', label: '随便来点' }]).map((g) => (
                <button key={g.id} className={`chip ${lotteryGenre === g.id ? 'active' : ''}`}
                  onClick={() => { setLotteryGenre(g.id); setLotteryItems([]); }}>{g.label}</button>
              ))}
            </div>
          </div>

          {/* 数量 + 抽奖按钮 */}
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
            <span className="muted" style={{ fontSize: 12 }}>抽取数量</span>
            <select className="input" style={{ width: 72 }} value={lotteryCount}
              onChange={(e) => setLotteryCount(parseInt(e.target.value, 10) || 12)}>
              {[6, 9, 12, 18, 24].map((n) => <option key={n} value={n}>{n} 本</option>)}
            </select>
            <button className="btn primary" disabled={lotteryRolling} onClick={() => drawLottery(false)}>
              {lotteryRolling
                ? <><Icon name="spinner" size={16} className="spin" /> 抽取中…</>
                : <><Icon name="dice" size={16} /> {lotteryItems.length ? '再抽一次' : '开始抽奖'}</>}
            </button>
            {lotteryItems.length > 0 && (
              <button className="btn sm" disabled={lotteryRolling} onClick={() => drawLottery(true)} title="重新从各源拉取候选">
                <Icon name="refresh" size={14} /> 换一批书源
              </button>
            )}
            {lotteryPoolSize > 0 && <span className="muted" style={{ fontSize: 11 }}>候选池 {lotteryPoolSize} 本</span>}
          </div>

          {/* 抽奖机屏蔽标签：整合所有源所有书的标签题材，多选后带这些标签的书不会被抽到 */}
          <div className="block-inline" style={{ marginBottom: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12 }}>
                屏蔽标签 <span className="muted" style={{ fontSize: 11 }}>· 带这些题材的书不会被抽到</span>
              </span>
              <div className="row" style={{ gap: 6 }}>
                {blockedTags.get(LOTTERY_SCOPE).length > 0 && (
                  <button className="btn sm ghost" onClick={() => { blockedTags.set(LOTTERY_SCOPE, []); setLotteryItems([]); setBlockRev((v) => v + 1); toast('已清空抽奖机屏蔽标签'); }}>清空</button>
                )}
                <button className="btn sm" onClick={() => openBlockSettings(LOTTERY_SCOPE, '抽奖机（所有源）')}>
                  <Icon name="eye" size={14} /> 设置屏蔽
                  {blockedTags.get(LOTTERY_SCOPE).length > 0 && <span className="chip-count">{blockedTags.get(LOTTERY_SCOPE).length}</span>}
                </button>
              </div>
            </div>
            {!!blockedTags.get(LOTTERY_SCOPE).length && (
              <div className="lottery-tags" style={{ marginTop: 8 }}>
                {blockedTags.get(LOTTERY_SCOPE).map((t) => <span key={t} className="lottery-tag blocked">{t}</span>)}
              </div>
            )}
          </div>

          {/* 抽奖动画占位 */}
          {lotteryRolling && (
            <div className="lottery-rolling">
              <div className="lottery-dice"><Icon name="dice" size={44} /></div>
              <div className="muted" style={{ fontSize: 13 }}>正在从各个来源抽取并去重…</div>
            </div>
          )}

          {lotteryMsg && !lotteryRolling && <p className="muted" style={{ fontSize: 13 }}>{lotteryMsg}</p>}

          {/* 抽奖结果 */}
          {!!lotteryItems.length && !lotteryRolling && (
            <div className="comic-grid lottery-grid">
              {lotteryItems.map((it, i) => (
                <div key={`${it.sourceId}-${it.link}-${i}`} className="comic-card lottery-card"
                  style={{ cursor: 'pointer', animationDelay: `${Math.min(i, 16) * 45}ms` }}
                  onClick={() => {
                    setShowLottery(false);
                    openComic(it);
                  }}>
                  <div className="cover">
                    <CoverImage src={it.coverProxy || (it.cover ? coverUrl(it.sourceId, it.cover) : '')} title={it.title} />
                    <span className="wide-tag" style={{ position: 'absolute', top: 6, left: 6 }}>
                      {it.media === 'novel' ? '小说' : '漫画'}
                    </span>
                  </div>
                  <div className="card-body">
                    <div className="card-title" title={it.title}>{it.title}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{it.sourceName}</div>
                    {!!it.tags?.length && (
                      <div className="lottery-tags">
                        {it.tags.slice(0, 2).map((t, ti) => <span key={ti} className="lottery-tag">{t}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* 标签屏蔽设置：整合当前 scope 所有书的标签题材，多选屏蔽 */}
      {showBlock && (
        <Modal
          title={`屏蔽标签 · ${blockScopeName}`}
          icon={<Icon name="eye" />}
          onClose={() => setShowBlock(false)}
          width={620}
          footer={
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <button className="btn" onClick={() => setBlockSelected([])} disabled={!blockSelected.length}>清空选择</button>
              <button className="btn primary" onClick={saveBlockSettings}>
                完成{blockSelected.length ? `（屏蔽 ${blockSelected.length} 个）` : ''}
              </button>
            </div>
          }
        >
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.7 }}>
            这里整合了<b>{blockScopeName}</b>所有书的标签题材。选中标签后，<b>带该标签的书都不会再出现</b>（发现、搜索、抽奖均已过滤），可多选，点「完成」生效。
          </p>
          <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => openBlockSettings(blockScope, blockScopeName)} title="重新抓取该范围的最新标签">
              <Icon name="refresh" size={14} /> 重新整合
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              共 {blockTags.length} 个标签{blockTags.length ? ` · 按出现频率排序` : ''}
            </span>
          </div>
          {blockLoading ? (
            <div className="empty"><p>正在整合标签题材，请稍候…</p></div>
          ) : blockTags.length ? (
            <div className="block-tag-grid">
              {blockTags.map((t) => {
                const on = blockSelected.some((x) => normalizeTag(x) === normalizeTag(t.tag));
                return (
                  <button
                    key={t.tag}
                    className={`chip ${on ? 'active' : ''}`}
                    onClick={() => setBlockSelected((prev) =>
                      on ? prev.filter((x) => normalizeTag(x) !== normalizeTag(t.tag)) : [...prev, t.tag],
                    )}
                    title={t.sources?.length ? `出现于：${t.sources.slice(0, 6).join('、')}` : undefined}
                  >
                    {t.tag} <span className="chip-count">×{t.count}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty">
              <p>这个范围暂时没有整合到标签。部分书源不提供题材标签，可稍后点「重新整合」重试。</p>
            </div>
          )}
        </Modal>
      )}

      {showAccount && (
        <Modal title="站点账号（可选）" onClose={() => setShowAccount(false)} width={560}>
          {/* 当前登录态：一眼看清是否生效、能否管理 */}
          <div className={`acct-status ${accountInfo.loggedIn ? 'on' : ''}`}>
            <div className="row" style={{ gap: 8 }}>
              <span className="acct-dot" />
              <b>{accountInfo.loggedIn ? '登录态已生效' : '当前未登录'}</b>
              <span className="muted" style={{ fontSize: 12 }}>· {active?.name || '未选择来源'}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {accountInfo.loggedIn
                ? `已保存 ${accountInfo.cookieCount} 项 Cookie${accountInfo.credentialCount ? `、${accountInfo.credentialCount} 项账号凭据` : ''}。该源的后续请求会自动携带。`
                : '不登录也能正常浏览、搜索、看免费内容，无需任何账号。'}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7, opacity: 0.85 }}>
              说明：源站登录只影响<b>该站会员/受限章节</b>的可见性，<b>不会</b>把源站账号里的收藏/书架同步到本 App（本 App 的书架存在你的本站账号或本地）。所以登录后看到的列表和免费时一样是正常的。
            </div>
            {accountInfo.loggedIn && (
              <button className="btn sm danger" style={{ marginTop: 10 }} onClick={async () => {
                if (!activeId) return;
                try {
                  await sourcesApi.logoutSource(activeId);
                  setAccountInfo((x) => ({ ...x, loggedIn: false, cookieCount: 0, credentialCount: 0 }));
                  setAccountCookie('');
                  refreshLoginStatus();
                  toast('已清除该源登录态');
                } catch (err) { errorToast(err, '清除失败'); }
              }}>一键清除登录态</button>
            )}
          </div>
          {!sessionUser && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
              💡 站点的「账号密码登录」和「保存 Cookie」需要本站账号（右上角「登录 / 注册」）；仅浏览和打开官网无需登录。
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
                    const st = await sourcesApi.getCookies(activeId);
                    setAccountInfo((x) => ({ ...x, loggedIn: !!st.loggedIn, cookieCount: st.cookieCount || 0, credentialCount: st.credentialCount || 0 }));
                    refreshLoginStatus();
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
                  setAccountInfo((x) => ({
                    ...x,
                    loggedIn: r.cleared ? false : !!(r.login?.loggedIn ?? true),
                    cookieCount: r.cleared ? 0 : (r.login?.cookieCount ?? (r.count || 0)),
                    credentialCount: r.cleared ? 0 : (r.login?.credentialCount ?? 0),
                  }));
                  refreshLoginStatus();
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
            favorite: false,
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
