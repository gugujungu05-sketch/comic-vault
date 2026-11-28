import { useCallback, useEffect, useRef, useState } from 'react';
import { unisearch } from '../lib/api';
import { Icon } from '../components/Icon';
import { useErrorToast } from '../components/Toasts';
import type { UniversalMedia } from '../types';

type Tab = 'all' | 'manga' | 'anime';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'manga', label: '漫画 / 轻小说' },
  { key: 'anime', label: '动画 / 影视' },
];

/** 格式化评分（0-10 → 一位小数） */
function score(s: number | null | undefined) {
  return s == null ? '—' : Number(s).toFixed(1);
}

/** 类型中文名 */
function kindLabel(m: UniversalMedia) {
  const map: Record<string, string> = {
    TV: 'TV 动画', MOVIE: '剧场版', ONA: '网络动画', OVA: 'OVA',
    MANGA: '漫画', NOVEL: '轻小说', ONE_SHOT: '短篇', SPECIAL: '特别篇',
  };
  return map[m.format] || (m.kind === 'manga' ? '漫画' : '动画');
}

export function SearchPage() {
  const errorToast = useErrorToast();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [results, setResults] = useState<UniversalMedia[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<UniversalMedia | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [trending, setTrending] = useState<UniversalMedia[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // 首次进入加载热门榜
  useEffect(() => {
    unisearch.trending('anime').then((r) => setTrending(r.results || [])).catch(() => {});
  }, []);

  const doSearch = useCallback(async (q: string, t: Tab, p: number, append = false) => {
    const clean = q.trim();
    if (!clean) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await unisearch.search(clean, t, p);
      if (r.error) throw new Error(r.error);
      setResults((prev) => append ? [...prev, ...(r.results || [])] : (r.results || []));
      setHasMore(!!r.hasNextPage);
      setTotal(r.total || 0);
      setPage(p);
    } catch (err) {
      errorToast(err);
      if (!append) setResults([]);
    } finally {
      setLoading(false);
    }
  }, [errorToast]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDetail(null);
    doSearch(query, tab, 1);
  }

  function switchTab(t: Tab) {
    setTab(t);
    setDetail(null);
    if (query.trim()) doSearch(query, t, 1);
    else unisearch.trending(t === 'manga' ? 'manga' : 'anime').then((r) => setTrending(r.results || [])).catch(() => {});
  }

  async function openDetail(m: UniversalMedia) {
    setDetailLoading(true);
    setDetail(m); // 先用列表数据填充，详情回来再覆盖
    try {
      const d = await unisearch.detail(m.id);
      setDetail(d);
    } catch (err) {
      errorToast(err);
    } finally {
      setDetailLoading(false);
    }
  }

  const watchLinks = (m: UniversalMedia) => (m.links || []).filter((l) => l.type === 'watch');

  return (
    <div className="page search-page">
      <div className="page-head">
        <div>
          <h1><Icon name="search" size={20} /> 全站书籍检索</h1>
          <p className="muted">一次搜遍漫画、轻小说、动画、影视 —— 详细信息 + 哪里能看（比番组计划更全）</p>
        </div>
      </div>

      <form className="search-bar" onSubmit={onSubmit}>
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入书名 / 动画名 / 日文名 / 别名，例如：进击的巨人、One Piece、葬送的芙莉莲"
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>

      <div className="search-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => switchTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {!searched && (
        <section className="search-section">
          <h2>热门榜 <span className="muted sm-text">· 来自 AniList</span></h2>
          <div className="media-grid">
            {(trending.length ? trending : []).map((m) => (
              <MediaCard key={m.id} m={m} onOpen={() => openDetail(m)} />
            ))}
          </div>
          {!trending.length && <p className="muted">正在加载热门…</p>}
        </section>
      )}

      {searched && (
        <section className="search-section">
          <div className="search-result-head">
            <h2>搜索结果</h2>
            <span className="muted sm-text">{total > 0 ? `共 ${total} 条 · 显示 ${results.length} 条` : ''}</span>
          </div>
          {results.length ? (
            <>
              <div className="media-grid">
                {results.map((m) => (
                  <MediaCard key={m.id} m={m} onOpen={() => openDetail(m)} />
                ))}
              </div>
              {hasMore && (
                <button className="btn" style={{ margin: '18px auto', display: 'block' }} disabled={loading} onClick={() => doSearch(query, tab, page + 1, true)}>
                  {loading ? '加载中…' : '加载更多'}
                </button>
              )}
            </>
          ) : (
            !loading && <p className="muted">没有找到匹配结果，换个关键词试试（支持中文名 / 日文名 / 英文名）。</p>
          )}
        </section>
      )}

      {detail && (
        <div className="backdrop" onClick={() => setDetail(null)}>
          <div className="modal media-detail" onClick={(e) => e.stopPropagation()}>
            <button className="media-detail-close" onClick={() => setDetail(null)} aria-label="关闭"><Icon name="close" size={18} /></button>
            {detailLoading && <div className="detail-loading">加载详细信息…</div>}
            {detail.banner && <div className="detail-banner" style={{ backgroundImage: `url(${detail.banner})` }} />}
            <div className="detail-body">
              <div className="detail-cover-wrap">
                {detail.cover ? <img src={detail.cover} alt={detail.title} /> : <div className="cover-ph"><Icon name="book" size={32} /></div>}
              </div>
              <div className="detail-info">
                <h2>{detail.title}</h2>
                {(detail.nativeTitle || detail.englishTitle) && (
                  <p className="muted sm-text">{detail.nativeTitle}{detail.englishTitle ? ` · ${detail.englishTitle}` : ''}</p>
                )}
                <div className="detail-meta">
                  <span className="badge">{kindLabel(detail)}</span>
                  {detail.year && <span className="badge">{detail.year}</span>}
                  {detail.status && <span className="badge">{statusLabel(detail.status)}</span>}
                  <span className="badge score"><Icon name="star" size={12} /> {score(detail.score)}</span>
                  {detail.chapters != null && <span className="badge">{detail.chapters} 话</span>}
                  {detail.episodes != null && <span className="badge">{detail.episodes} 集</span>}
                  {detail.volumes != null && <span className="badge">{detail.volumes} 卷</span>}
                </div>
                {detail.tags?.length > 0 && (
                  <div className="detail-tags">{detail.tags.slice(0, 14).map((t) => <span key={t} className="tag">{t}</span>)}</div>
                )}
                {detail.description && <p className="detail-desc">{detail.description}</p>}

                {watchLinks(detail).length > 0 && (
                  <div className="detail-links">
                    <h3><Icon name="play" size={14} /> 哪里能看</h3>
                    <div className="link-row">
                      {watchLinks(detail).map((l, i) => (
                        <a key={i} className="watch-link" href={l.url} target="_blank" rel="noreferrer">
                          <Icon name="link" size={12} /> {l.site}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <a className="btn sm ghost" href={detail.sourceUrl} target="_blank" rel="noreferrer">
                  <Icon name="globe" size={13} /> 在 {detail.source} 查看完整资料
                </a>

                {detail.relations && detail.relations.length > 0 && (
                  <div className="detail-rel">
                    <h3>相关作品</h3>
                    <div className="rel-row">
                      {detail.relations.slice(0, 8).map((r) => (
                        <a key={r.id} className="rel-item" href={r.sourceUrl} target="_blank" rel="noreferrer" title={r.title}>
                          {r.cover ? <img src={r.cover} alt="" /> : <Icon name="book" size={18} />}
                          <span>{r.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {detail.characters && detail.characters.length > 0 && (
                  <div className="detail-rel">
                    <h3>主要角色</h3>
                    <div className="rel-row">
                      {detail.characters.map((c, i) => (
                        <a key={i} className="rel-item" href={c.sourceUrl} target="_blank" rel="noreferrer" title={c.name}>
                          {c.image ? <img src={c.image} alt="" /> : <Icon name="user" size={18} />}
                          <span>{c.name}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    FINISHED: '已完结', ONGOING: '连载中', RELEASING: '连载中',
    NOT_YET_RELEASED: '未播出', CANCELLED: '已取消', HIATUS: '休刊中',
  };
  return map[s] || s;
}

function MediaCard({ m, onOpen }: { m: UniversalMedia; onOpen: () => void }) {
  const watch = (m.links || []).filter((l) => l.type === 'watch');
  return (
    <div className="media-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="media-cover">
        {m.cover ? <img src={m.cover} alt={m.title} loading="lazy" /> : <div className="cover-ph"><Icon name="book" size={28} /></div>}
        {m.score != null && <span className="media-score"><Icon name="star" size={11} /> {score(m.score)}</span>}
        <span className="media-kind">{kindLabel(m)}</span>
      </div>
      <div className="media-title" title={m.title}>{m.title}</div>
      <div className="media-sub">
        {m.year || '—'} {m.chapters ? `· ${m.chapters} 话` : m.episodes ? `· ${m.episodes} 集` : ''}
        {watch.length > 0 && <span className="media-watch"><Icon name="play" size={10} /> {watch.length} 个观看源</span>}
      </div>
    </div>
  );
}
