import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unisearch } from '../lib/api';
import { Icon } from '../components/Icon';
import { useErrorToast } from '../components/Toasts';
import type { UniversalMedia, UniTrendSection } from '../types';

type LangPref = 'auto' | 'chinese' | 'native' | 'romaji' | 'english';
const LANG_PREFS: { key: LangPref; label: string; hint: string }[] = [
  { key: 'auto', label: '智能', hint: '中文 → 原名 → 英文' },
  { key: 'chinese', label: '中文', hint: '优先中文译名' },
  { key: 'native', label: '原名', hint: '优先原生语言' },
  { key: 'romaji', label: '罗马音', hint: '优先拉丁转写' },
  { key: 'english', label: '英文', hint: '优先英文名' },
];
const LANG_KEY = 'cv_unisearch_lang';

const DEFAULT_CATEGORIES = [
  { key: 'all', label: '全部', hint: '综合所有品类' },
  { key: 'manga', label: '漫画', hint: '日漫 / 港漫 / 条漫' },
  { key: 'novel', label: '轻小说', hint: '轻小说 / Web 小说' },
  { key: 'anime', label: '动画', hint: 'TV / 网络 / OVA' },
  { key: 'movie', label: '影视', hint: '剧场版 / 电影' },
  { key: 'game', label: '游戏', hint: '改编游戏 / 原作游戏' },
  { key: 'music', label: '音乐', hint: '原声 / 主题曲' },
];

function score(s: number | null | undefined) {
  return s == null ? '—' : Number(s).toFixed(1);
}

/** 依据语言偏好，从多语言标题里挑出主显示名 */
function displayTitle(m: UniversalMedia, pref: LangPref): string {
  const t = m.titles || {
    native: m.nativeTitle || '', romaji: '', english: m.englishTitle || '', chinese: m.chineseTitle || '',
  };
  const pick = (keys: (keyof typeof t)[]) => {
    for (const k of keys) if (t[k] && t[k]!.trim()) return t[k]!;
    return '';
  };
  switch (pref) {
    case 'chinese': return pick(['chinese', 'native', 'romaji', 'english']) || m.title;
    case 'native': return pick(['native', 'chinese', 'romaji', 'english']) || m.title;
    case 'romaji': return pick(['romaji', 'english', 'native', 'chinese']) || m.title;
    case 'english': return pick(['english', 'romaji', 'native', 'chinese']) || m.title;
    default: return pick(['chinese', 'native', 'romaji', 'english']) || m.title;
  }
}

/** 副标题：与主显示名不同的原名/译名（按偏好排序，优先展示主语言的原名） */
function subTitle(m: UniversalMedia, pref: LangPref, main: string): string {
  const t = m.titles || { native: m.nativeTitle || '', romaji: '', english: m.englishTitle || '', chinese: m.chineseTitle || '' };
  const order: (keyof typeof t)[] = pref === 'english' ? ['native', 'chinese', 'romaji', 'english']
    : pref === 'romaji' ? ['native', 'chinese', 'english', 'romaji']
    : ['native', 'chinese', 'romaji', 'english'];
  const candidates = order.map((k) => t[k]).filter((s) => s && s.trim() && s !== main);
  return [...new Set(candidates)].slice(0, 2).join(' · ');
}

function kindLabel(m: UniversalMedia) {
  const map: Record<string, string> = {
    TV: 'TV 动画', MOVIE: '剧场版', ONA: '网络动画', OVA: 'OVA', TV_SHORT: '短篇动画',
    SPECIAL: '特别篇', MANGA: '漫画', NOVEL: '轻小说', ONE_SHOT: '短篇', MUSIC: '音乐', GAME: '游戏',
  };
  return map[m.format] || (m.category === 'novel' ? '轻小说' : m.category === 'game' ? '游戏' : m.category === 'music' ? '音乐' : m.kind === 'manga' ? '漫画' : '动画');
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    FINISHED: '已完结', ONGOING: '连载中', RELEASING: '连载中', NOT_YET_RELEASED: '未播出',
    CANCELLED: '已取消', HIATUS: '休刊中',
  };
  return map[s] || s;
}

function formatLabel(m: UniversalMedia) {
  const parts: string[] = [];
  if (m.chapters) parts.push(`${m.chapters} 话`);
  if (m.volumes) parts.push(`${m.volumes} 卷`);
  if (m.episodes) parts.push(`${m.episodes} 集`);
  if (m.duration && !m.episodes) parts.push(`${m.duration} 分钟`);
  return parts.join(' · ');
}

export function SearchPage() {
  const errorToast = useErrorToast();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [results, setResults] = useState<UniversalMedia[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<UniversalMedia | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sections, setSections] = useState<UniTrendSection[]>([]);
  const [langPref, setLangPref] = useState<LangPref>(() => {
    const v = localStorage.getItem(LANG_KEY) as LangPref | null;
    return v && LANG_PREFS.some((p) => p.key === v) ? v : 'auto';
  });
  const [showLang, setShowLang] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    unisearch.categories().then((r) => { if (r.categories?.length) setCategories(r.categories); }).catch(() => {});
  }, []);

  const loadTrending = useCallback((cat: string) => {
    unisearch.trending(cat === 'manga' ? 'manga' : cat === 'novel' ? 'novel' : 'anime')
      .then((r) => setSections(r.sections || (r.results?.length ? [{ key: 'trending', label: '热门', results: r.results }] : [])))
      .catch(() => {});
  }, []);
  useEffect(() => { loadTrending('all'); }, [loadTrending]);

  function setLang(v: LangPref) {
    setLangPref(v);
    localStorage.setItem(LANG_KEY, v);
    setShowLang(false);
  }

  const doSearch = useCallback(async (q: string, cat: string, p: number, append = false) => {
    const clean = q.trim();
    if (!clean) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await unisearch.search(clean, cat, p);
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
    doSearch(query, category, 1);
  }

  function switchCategory(cat: string) {
    setCategory(cat);
    setDetail(null);
    if (query.trim()) doSearch(query, cat, 1);
    else loadTrending(cat);
  }

  async function openDetail(m: UniversalMedia) {
    setDetailLoading(true);
    setDetail(m);
    try {
      if (/^anilist:/.test(m.id)) setDetail(await unisearch.detail(m.id));
    } catch (err) {
      errorToast(err);
    } finally {
      setDetailLoading(false);
    }
  }

  const watchLinks = useMemo(() => (m: UniversalMedia) => (m.links || []).filter((l) => l.type === 'watch'), []);
  const officialLinks = useMemo(() => (m: UniversalMedia) => (m.links || []).filter((l) => l.type === 'official'), []);
  const socialLinks = useMemo(() => (m: UniversalMedia) => (m.links || []).filter((l) => l.type === 'social'), []);

  return (
    <div className="page search-page">
      <div className="page-head">
        <div>
          <h1><Icon name="search" size={20} /> 全品类聚合检索</h1>
          <p className="muted">跨漫画、轻小说、动画、影视、游戏、音乐检索 · 多语言译名 · 正版发布与观看信息</p>
        </div>
        <div className="lang-switch">
          <button className="btn sm ghost" onClick={() => setShowLang((v) => !v)}>
            <Icon name="globe" size={13} /> 语言：{LANG_PREFS.find((p) => p.key === langPref)?.label}
          </button>
          {showLang && (
            <div className="lang-menu">
              {LANG_PREFS.map((p) => (
                <button key={p.key} className={langPref === p.key ? 'active' : ''} onClick={() => setLang(p.key)} title={p.hint}>
                  <span>{p.label}</span><small>{p.hint}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <form className="search-bar" onSubmit={onSubmit}>
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="中文名 / 日文名 / 英文名 / 别名 / 罗马音，例如：进击的巨人、Sousou no Frieren、葬送的芙莉莲"
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>

      <div className="search-tabs">
        {categories.map((c) => (
          <button key={c.key} className={`tab ${category === c.key ? 'active' : ''}`} onClick={() => switchCategory(c.key)} title={c.hint}>
            {c.label}
          </button>
        ))}
      </div>

      {!searched && sections.length > 0 && (
        <div className="trend-sections">
          {sections.map((s) => (
            <section className="search-section" key={s.key}>
              <h2>{s.label} <span className="muted sm-text">· 聚合公开元数据库</span></h2>
              {s.results.length ? (
                <div className="media-row">
                  {s.results.map((m) => (
                    <MediaCard key={m.id} m={m} pref={langPref} onOpen={() => openDetail(m)} />
                  ))}
                </div>
              ) : <p className="muted">暂无数据</p>}
            </section>
          ))}
        </div>
      )}

      {!searched && !sections.length && <p className="muted">正在加载榜单…</p>}

      {searched && (
        <section className="search-section">
          <div className="search-result-head">
            <h2>搜索结果 <span className="muted sm-text">· {categories.find((c) => c.key === category)?.label}</span></h2>
            <span className="muted sm-text">{total > 0 ? `共 ${total} 条 · 显示 ${results.length} 条` : ''}</span>
          </div>
          {results.length ? (
            <>
              <div className="media-grid">
                {results.map((m) => (
                  <MediaCard key={m.id} m={m} pref={langPref} onOpen={() => openDetail(m)} />
                ))}
              </div>
              {hasMore && (
                <button className="btn load-more" disabled={loading} onClick={() => doSearch(query, category, page + 1, true)}>
                  {loading ? '加载中…' : '加载更多'}
                </button>
              )}
            </>
          ) : (
            !loading && (
              <div className="empty-hint">
                <Icon name="search" size={28} />
                <p>没有找到匹配结果</p>
                <span className="muted sm-text">支持中文 / 日文 / 英文 / 罗马音 / 别名；也可切换上方品类再试。</span>
              </div>
            )
          )}
        </section>
      )}

      {detail && (
        <div className="backdrop" onClick={() => setDetail(null)}>
          <div className="modal media-detail" onClick={(e) => e.stopPropagation()}>
            <button className="media-detail-close" onClick={() => setDetail(null)} aria-label="关闭"><Icon name="close" size={18} /></button>
            {detailLoading && <div className="detail-loading">加载完整信息…</div>}
            {detail.banner && <div className="detail-banner" style={{ backgroundImage: `url(${detail.banner})` }} />}
            <div className="detail-body">
              <div className="detail-cover-wrap">
                {detail.cover ? <img src={detail.cover} alt={detail.title} /> : <div className="cover-ph"><Icon name="book" size={32} /></div>}
              </div>
              <div className="detail-info">
                <h2>{displayTitle(detail, langPref)}</h2>
                {subTitle(detail, langPref, displayTitle(detail, langPref)) && (
                  <p className="muted sm-text detail-alias">{subTitle(detail, langPref, displayTitle(detail, langPref))}</p>
                )}
                <div className="detail-meta">
                  <span className="badge accent-badge">{kindLabel(detail)}</span>
                  {detail.year && <span className="badge">{detail.year}</span>}
                  {detail.status && <span className="badge">{statusLabel(detail.status)}</span>}
                  {detail.score != null && <span className="badge score"><Icon name="star" size={12} /> {score(detail.score)}</span>}
                  {formatLabel(detail) && <span className="badge">{formatLabel(detail)}</span>}
                  {detail.country && <span className="badge">{detail.country}</span>}
                  {detail.licensed && <span className="badge licensed"><Icon name="check" size={11} /> 正版授权</span>}
                </div>

                {((detail.studios?.length || 0) > 0 || !!detail.origin || (detail.rankings?.length || 0) > 0) && (
                  <div className="detail-production">
                    {!!detail.studios?.length && (
                      <div className="prod-line"><span className="prod-k">制作 / 出版</span>
                        <span className="prod-v">{detail.studios!.map((s) => s.name).join('、')}</span></div>
                    )}
                    {detail.origin && <div className="prod-line"><span className="prod-k">原作来源</span><span className="prod-v">{originLabel(detail.origin)}</span></div>}
                    {!!detail.rankings?.length && (
                      <div className="prod-line"><span className="prod-k">榜单排名</span>
                        <span className="prod-v">{detail.rankings!.slice(0, 3).map((r) => `第 ${r.rank} 名 · ${r.context}`).join('；')}</span></div>
                    )}
                  </div>
                )}

                {detail.description && <p className="detail-desc">{detail.description}</p>}

                {!!detail.tags?.length && (
                  <div className="detail-tags">{detail.tags.slice(0, 16).map((t) => <span key={t} className="tag">{t}</span>)}</div>
                )}

                {!!detail.synonyms?.length && (
                  <details className="detail-names">
                    <summary>多语言译名（{detail.synonyms.length}）</summary>
                    <div className="names-list">{detail.synonyms.map((n, i) => <span key={i} className="name-chip">{n}</span>)}</div>
                  </details>
                )}

                {watchLinks(detail).length > 0 && (
                  <div className="detail-links">
                    <h3><Icon name="play" size={14} /> 哪里能看 · 正版观看平台（{watchLinks(detail).length}）</h3>
                    <div className="link-grid">
                      {watchLinks(detail).map((l, i) => (
                        <a key={i} className="watch-link" href={l.url} target="_blank" rel="noreferrer" title={l.language ? `语言：${l.language}` : ''}>
                          <Icon name="link" size={12} /> {l.site}{l.language ? <small> · {l.language}</small> : null}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {officialLinks(detail).length > 0 && (
                  <div className="detail-links">
                    <h3><Icon name="globe" size={14} /> 正版发布 · 官方网站</h3>
                    <div className="link-grid">
                      {officialLinks(detail).map((l, i) => (
                        <a key={i} className="watch-link official" href={l.url} target="_blank" rel="noreferrer">
                          <Icon name="globe" size={12} /> {l.site}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {!!detail.streamingEpisodes?.length && (
                  <div className="detail-links">
                    <h3><Icon name="play" size={14} /> 分集观看（{detail.streamingEpisodes.length} 集）</h3>
                    <div className="episode-grid">
                      {detail.streamingEpisodes.slice(0, 30).map((e, i) => (
                        <a key={i} className="episode-link" href={e.url} target="_blank" rel="noreferrer" title={`${e.site} · ${e.title}`}>
                          <span className="ep-idx">{i + 1}</span><span className="ep-text">{e.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {socialLinks(detail).length > 0 && (
                  <div className="detail-links">
                    <h3><Icon name="link" size={14} /> 官方社交</h3>
                    <div className="link-grid">
                      {socialLinks(detail).map((l, i) => (
                        <a key={i} className="watch-link social" href={l.url} target="_blank" rel="noreferrer">
                          <Icon name="link" size={12} /> {l.site}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <a className="btn sm ghost detail-source-btn" href={detail.sourceUrl} target="_blank" rel="noreferrer">
                  <Icon name="globe" size={13} /> 在 {detail.source} 查看完整资料
                </a>

                {!!detail.relations?.length && (
                  <div className="detail-rel">
                    <h3>相关作品（{detail.relations.length}）</h3>
                    <div className="rel-row">
                      {detail.relations.slice(0, 10).map((r) => (
                        <a key={r.id} className="rel-item" href={r.sourceUrl} target="_blank" rel="noreferrer" title={r.title}>
                          {r.cover ? <img src={r.cover} alt="" /> : <div className="rel-ph"><Icon name="book" size={18} /></div>}
                          <span>{r.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {!!detail.characters?.length && (
                  <div className="detail-rel">
                    <h3>主要角色</h3>
                    <div className="rel-row">
                      {detail.characters.map((c, i) => (
                        <a key={i} className="rel-item" href={c.sourceUrl} target="_blank" rel="noreferrer" title={c.name}>
                          {c.image ? <img src={c.image} alt="" /> : <div className="rel-ph"><Icon name="user" size={18} /></div>}
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

function originLabel(o: string) {
  const map: Record<string, string> = {
    MANGA: '漫画改编', LIGHT_NOVEL: '轻小说改编', NOVEL: '小说改编', ORIGINAL: '原创',
    VISUAL_NOVEL: '视觉小说改编', VIDEO_GAME: '游戏改编', OTHER: '其它',
  };
  return map[o] || o;
}

function MediaCard({ m, pref, onOpen }: { m: UniversalMedia; pref: LangPref; onOpen: () => void }) {
  const main = displayTitle(m, pref);
  const watch = (m.links || []).filter((l) => l.type === 'watch');
  return (
    <div className="media-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="media-cover">
        {m.cover ? <img src={m.cover} alt={main} loading="lazy" /> : <div className="cover-ph"><Icon name="book" size={28} /></div>}
        {m.score != null && <span className="media-score"><Icon name="star" size={11} /> {score(m.score)}</span>}
        <span className="media-kind">{kindLabel(m)}</span>
        {m.licensed && <span className="media-licensed" title="正版授权">✓</span>}
      </div>
      <div className="media-title" title={main}>{main}</div>
      <div className="media-subtitle" title={subTitle(m, pref, main)}>{subTitle(m, pref, main)}</div>
      <div className="media-sub">
        <span>{m.year || '—'}</span>
        {formatLabel(m) && <span>· {formatLabel(m)}</span>}
        {watch.length > 0 && <span className="media-watch"><Icon name="play" size={10} /> {watch.length} 个观看源</span>}
      </div>
    </div>
  );
}
