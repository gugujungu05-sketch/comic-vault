import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, discover, social } from '../lib/api';
import { useSession } from '../lib/session';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { formatDate } from '../lib/util';
import type {
  Category, CommunityComic, ComicSummary, ImportComicItem, MetaEntry, RankingItem, UploadRecord,
} from '../types';

const RANK_TABS = [
  { id: 'hot', name: '热门' },
  { id: 'views', name: '浏览' },
  { id: 'likes', name: '点赞' },
  { id: 'downloads', name: '下载' },
  { id: 'new', name: '新书' },
];

const SORTS = [
  { id: 'updated', name: '最近更新' },
  { id: 'new', name: '最新加入' },
  { id: 'views', name: '浏览最多' },
  { id: 'likes', name: '点赞最多' },
  { id: 'pages', name: '页数最多' },
];

export function CommunityPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { user } = useSession();

  const [comics, setComics] = useState<CommunityComic[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ranking, setRanking] = useState<RankingItem[]>([]);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [rankType, setRankType] = useState('hot');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('updated');
  const [tag, setTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CommunityComic | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const loadComics = useCallback(async () => {
    setLoading(true);
    try {
      const r = await social.community({ q: appliedQuery, category, sort });
      setComics(r.comics);
    } catch (err) {
      errorToast(err, '加载公共书库失败');
    } finally {
      setLoading(false);
    }
  }, [appliedQuery, category, sort, errorToast]);

  const loadSide = useCallback(async () => {
    try {
      const [cats, ups] = await Promise.all([discover.categories(), discover.uploads(20)]);
      setCategories(cats.categories);
      setUploads(ups.uploads);
    } catch {
      /* 侧栏失败不影响主列表 */
    }
  }, []);

  useEffect(() => { loadComics(); }, [loadComics]);
  useEffect(() => { loadSide(); }, [loadSide]);
  useEffect(() => {
    discover.ranking(rankType, 8).then((r) => setRanking(r.ranking)).catch(() => {});
  }, [rankType]);

  const tags = useMemo(() => {
    const s = new Set<string>();
    comics.forEach((c) => {
      (c.tags || []).forEach((t) => s.add(t));
      (c.tagEntries || []).forEach((t) => s.add(t.value || ''));
    });
    return [...s].filter(Boolean).sort();
  }, [comics]);

  const visible = useMemo(() => {
    if (!tag) return comics;
    return comics.filter((c) => {
      const all = [...(c.tags || []), ...(c.tagEntries || []).map((t) => t.value || '')];
      return all.includes(tag);
    });
  }, [comics, tag]);

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name || '其他';

  function requireLogin(): boolean {
    if (!user) {
      errorToast(new Error('请先登录后再操作'));
      navigate('/');
      return false;
    }
    return true;
  }

  async function like(c: CommunityComic) {
    if (!requireLogin()) return;
    try {
      const r = await discover.like(c.id);
      setComics((prev) => prev.map((x) => (
        x.id === c.id
          ? { ...x, likes: r.likes, likedBy: r.liked ? [...(x.likedBy || []), user!.id] : (x.likedBy || []).filter((id) => id !== user!.id) }
          : x
      )));
    } catch (err) {
      errorToast(err, '点赞失败');
    }
  }

  function openComic(c: CommunityComic) {
    discover.view(c.id).catch(() => {});
    navigate(`/comic/${c.id}`);
  }

  async function refreshAll() {
    await Promise.all([loadComics(), loadSide()]);
    discover.ranking(rankType, 8).then((r) => setRanking(r.ranking)).catch(() => {});
  }

  return (
    <main className="page community-page">
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">公共书库</h1>
          <div className="page-sub">所有人都能上传话、补标签、加别名与封面；但只能删除自己上传的那一条</div>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={() => { if (requireLogin()) setShowImport(true); }}>
            <Icon name="upload" size={16} /> 批量导入
          </button>
          <button className="btn primary" onClick={() => { if (requireLogin()) setShowPublish(true); }}>
            <Icon name="plus" size={16} /> 发布漫画
          </button>
        </div>
      </div>

      <div className="community-search">
        <div className="search-wrap">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="搜索书名、别名、作者、标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setAppliedQuery(query.trim()); }}
          />
        </div>
        <button className="btn" onClick={() => setAppliedQuery(query.trim())}>搜索</button>
        {appliedQuery && (
          <button className="btn ghost" onClick={() => { setQuery(''); setAppliedQuery(''); }}>
            清除「{appliedQuery}」
          </button>
        )}
        <select className="select" style={{ width: 140, marginLeft: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {categories.length > 0 && (
        <div className="cat-bar">
          {categories.map((c) => (
            <button key={c.id} className={`chip ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>
              <span>{c.icon}</span> {c.name} <span className="chip-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      {tags.length > 0 && (
        <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <button className={`chip sm ${!tag ? 'active' : ''}`} onClick={() => setTag(null)}>全部标签</button>
          {tags.map((t) => (
            <button key={t} className={`chip sm ${tag === t ? 'active' : ''}`} onClick={() => setTag(t)}>
              <Icon name="tag" size={12} /> {t}
            </button>
          ))}
        </div>
      )}

      <div className="community-layout">
        <div className="community-main">
          {loading ? (
            <div className="empty"><Icon name="spinner" size={26} className="spin" /><div style={{ marginTop: 10 }}>加载中…</div></div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <Icon name="globe" size={34} />
              <h3>没有符合条件的漫画</h3>
              <div>换个分类或关键词，或把你的漫画发布到公共书库</div>
            </div>
          ) : (
            <div className="comic-grid">
              {visible.map((c, i) => {
                const liked = !!user && (c.likedBy || []).includes(user.id);
                return (
                  <article className="comic-card anim-fade-up" key={c.id} style={{ animationDelay: `${i * 40}ms` }}>
                    <div className="comic-cover" onClick={() => openComic(c)}>
                      {c.coverUrl ? <img src={c.coverUrl} alt={c.title} loading="lazy" /> : <div className="cover-empty"><Icon name="book" size={30} /></div>}
                      <span className="badge community"><Icon name="globe" size={12} /> 公共</span>
                      {c.sample && <span className="badge sample">示例</span>}
                    </div>
                    <div className="comic-body">
                      <div className="comic-title" title={c.title}>{c.title}</div>
                      <div className="comic-meta">{c.chapterCount} 话 · {c.pageCount} 页 · 由 {c.ownerName} 创建</div>
                      <div className="row wrap" style={{ gap: 6, margin: '8px 0' }}>
                        <span className="chip sm cat-chip">{categoryName(c.category)}</span>
                        <span className="chip sm"><Icon name="eye" size={11} /> {c.views}</span>
                        {(c.aliases?.length || 0) > 0 && (
                          <span className="chip sm">别名 {c.aliases!.length}</span>
                        )}
                      </div>
                      {(c.aliases?.length || 0) > 0 && (
                        <div className="comic-meta">别名：{c.aliases!.map((a) => a.value).join(' / ')}</div>
                      )}
                      <div className="row wrap" style={{ gap: 6 }}>
                        {(c.tagEntries || []).map((t) => (
                          <span className="chip sm" key={t.id}><Icon name="tag" size={11} /> {t.value}</span>
                        ))}
                        {(c.covers?.length || 0) > 1 && (
                          <span className="chip sm"><Icon name="image" size={11} /> {c.covers!.length} 张封面</span>
                        )}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 8 }}>
                        <button className="btn sm" onClick={() => openComic(c)}><Icon name="play" size={14} /> 阅读</button>
                        <button className={`btn sm ${liked ? 'primary' : ''}`} onClick={() => like(c)}>
                          <Icon name="heart" size={14} /> {c.likes}
                        </button>
                        <button className="btn sm primary" onClick={() => { if (requireLogin()) setEditing(c); }}>
                          <Icon name="edit" size={14} /> 协作
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="community-side">
          <section className="panel side-panel">
            <div className="panel-title"><Icon name="star" size={16} /> 排行榜</div>
            <div className="rank-tabs">
              {RANK_TABS.map((t) => (
                <button key={t.id} className={rankType === t.id ? 'active' : ''} onClick={() => setRankType(t.id)}>{t.name}</button>
              ))}
            </div>
            <div className="rank-list">
              {ranking.length === 0 && <div className="muted sm-text">暂无数据</div>}
              {ranking.map((r) => (
                <button className="rank-item" key={r.id} onClick={() => navigate(`/comic/${r.id}`)}>
                  <span className={`rank-no top${r.rank <= 3 ? r.rank : ''}`}>{r.rank}</span>
                  {r.coverUrl ? <img src={r.coverUrl} alt="" /> : <span className="rank-empty"><Icon name="book" size={16} /></span>}
                  <span className="rank-main">
                    <span className="rank-title">{r.title}</span>
                    <span className="rank-sub">{r.chapterCount} 话 · {r.views} 浏览 · {r.likes} 赞</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel side-panel">
            <div className="panel-title"><Icon name="upload" size={16} /> 公共书库上传记录</div>
            <div className="upload-list">
              {uploads.length === 0 && <div className="muted sm-text">还没有上传记录</div>}
              {uploads.map((u) => (
                <div className="upload-item" key={u.id}>
                  <div className="upload-dot" />
                  <div className="upload-main">
                    <div className="upload-title">
                      {u.chapterTitle ? `《${u.comicTitle}》· ${u.chapterTitle}` : `《${u.comicTitle}》`}
                      {u.count > 0 && <span className="muted"> +{u.count} 页</span>}
                    </div>
                    <div className="upload-by">{u.userName} · {formatDate(u.at)}</div>
                  </div>
                </div>
              ))}
            </div>
            <button className="btn sm ghost block" style={{ marginTop: 10 }} onClick={refreshAll}>
              <Icon name="refresh" size={13} /> 刷新记录
            </button>
          </section>
        </aside>
      </div>

      {editing && (
        <CommunityEditor
          comic={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onChanged={async () => { await refreshAll(); setEditing(null); }}
        />
      )}
      {showPublish && (
        <PublishDialog
          categories={categories}
          onClose={() => setShowPublish(false)}
          onDone={async () => { setShowPublish(false); toast('已发布到公共书库'); await refreshAll(); }}
        />
      )}
      {showImport && (
        <CommunityImportDialog
          categories={categories}
          onClose={() => setShowImport(false)}
          onDone={async () => { setShowImport(false); await refreshAll(); }}
        />
      )}
    </main>
  );
}

/* ------------------------------ 合规批量导入 ------------------------------ */

const IMPORT_EXAMPLE = `[
  {
    "title": "示例漫画名",
    "author": "作者名",
    "category": "slice",
    "description": "一句话简介",
    "tags": ["标签1", "标签2"],
    "sourceUrl": "https://example.com/来源页",
    "chapters": [
      { "title": "第 1 话", "pages": [] }
    ]
  }
]`;

function CommunityImportDialog({ categories, onClose, onDone }: {
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [raw, setRaw] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function submit() {
    let items: ImportComicItem[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('清单必须是 JSON 数组');
      items = parsed;
    } catch (err) {
      errorToast(err instanceof Error ? err : new Error('JSON 解析失败'), '清单格式不正确');
      return;
    }
    if (!confirmed) {
      errorToast(new Error('请先勾选合法授权确认'));
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const r = await discover.importComics({ confirmRights: true, items });
      setErrors(r.errors);
      toast(`已导入 ${r.created.length} 本漫画${r.importedImages ? `、${r.importedImages} 张图片` : ''}`);
      if (r.created.length) onDone();
    } catch (err) {
      errorToast(err, '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="批量导入到公共书库" icon={<Icon name="upload" />} onClose={onClose} width={680}>
      <div className="rights-note">
        <Icon name="lock" size={16} />
        <div>
          <b>请先确认版权</b>
          <div>本站不会爬取或搬运第三方网站的受版权保护内容。只导入你拥有合法授权、属于公有领域或自己制作的作品；图片地址仅支持公开 http/https 直链，内网地址会被拒绝。</div>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>我确认对上述内容拥有合法授权，或内容属于公有领域 / 自制，并承担相应责任</span>
      </label>
      <div className="field">
        <label>导入清单（JSON 数组，最多 20 本）</label>
        <textarea
          className="input mono"
          rows={9}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={IMPORT_EXAMPLE}
        />
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <button className="btn sm ghost" onClick={() => setRaw(IMPORT_EXAMPLE)}>填入示例</button>
        <span className="muted sm-text">
          pages 留空只导入元数据，之后到漫画详情页上传图片；填写图片直链则会一并落盘。
        </span>
      </div>
      {categories.length > 0 && (
        <div className="muted sm-text">可选分类：{categories.filter((c) => c.id !== 'all').map((c) => `${c.icon} ${c.name}`).join(' · ')}</div>
      )}
      {errors.length > 0 && (
        <div className="import-errors">
          <b>部分内容未导入：</b>
          {errors.slice(0, 8).map((e, i) => <div key={i}>· {e}</div>)}
          {errors.length > 8 && <div>… 另有 {errors.length - 8} 条</div>}
        </div>
      )}
      <button className="btn primary block" style={{ marginTop: 14 }} onClick={submit} disabled={busy || !confirmed || !raw.trim()}>
        {busy ? '导入中…' : '确认导入'}
      </button>
    </Modal>
  );
}

/* ------------------------------ 发布到公共书库 ------------------------------ */

function PublishDialog({ categories, onClose, onDone }: {
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mine, setMine] = useState<ComicSummary[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('other');
  const [busy, setBusy] = useState(false);
  const errorToast = useErrorToast();
  const navigate = useNavigate();

  useEffect(() => {
    api.list().then((r) => setMine(r.comics.filter((c) => c.scope !== 'community'))).catch(() => {});
  }, []);

  async function assignCategory(id: string) {
    try { await discover.setCategory(id, category); } catch { /* 分类失败不影响发布 */ }
  }

  async function publishExisting() {
    if (!pick) return errorToast(new Error('请先选择一本漫画'));
    setBusy(true);
    try {
      await api.update(pick, { scope: 'community', visibility: 'public' });
      await assignCategory(pick);
      onDone();
    } catch (err) {
      errorToast(err, '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (!title.trim()) return errorToast(new Error('请填写书名'));
    setBusy(true);
    try {
      const c = await api.create({ title: title.trim(), scope: 'community', visibility: 'public' });
      await assignCategory(c.id);
      onClose();
      navigate(`/comic/${c.id}`);
    } catch (err) {
      errorToast(err, '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="发布到公共书库" icon={<Icon name="globe" />} onClose={onClose} width={540}>
      <div className="field">
        <label>分类</label>
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.filter((c) => c.id !== 'all').map((c) => (
            <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
          ))}
          {categories.length === 0 && <option value="other">其他</option>}
        </select>
      </div>
      <div className="field">
        <label>从我的书架选一本（发布后所有人可见，仍归你管理）</label>
        <select className="select" value={pick || ''} onChange={(e) => setPick(e.target.value)}>
          <option value="">请选择…</option>
          {mine.map((c) => <option key={c.id} value={c.id}>{c.title}（{c.chapterCount} 话）</option>)}
        </select>
      </div>
      <button className="btn primary block" onClick={publishExisting} disabled={busy || !pick}>发布选中的漫画</button>
      <div className="or-divider">或</div>
      <div className="field">
        <label>新建一本公共漫画（创建后再导入图片分话）</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="书名" />
      </div>
      <button className="btn block" onClick={createNew} disabled={busy || !title.trim()}>新建并前往导入</button>
    </Modal>
  );
}

/* ------------------------------ 协作编辑器 ------------------------------ */

function EntryList({
  title, kind, entries, activeId, onAdd, onDelete, onActivate, placeholder,
}: {
  title: string;
  kind: 'aliases' | 'tags' | 'covers';
  entries: MetaEntry[];
  activeId?: string | null;
  onAdd: (v: string) => void;
  onDelete: (id: string) => void;
  onActivate?: (id: string) => void;
  placeholder: string;
}) {
  const { user } = useSession();
  const [value, setValue] = useState('');
  return (
    <div className="edit-section">
      <h4>{title} <span className="muted">（{entries.length}）</span></h4>
      {kind !== 'covers' && (
        <div className="row" style={{ gap: 8 }}>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(value.trim()); setValue(''); } }} />
          <button className="btn sm" onClick={() => { if (value.trim()) { onAdd(value.trim()); setValue(''); } }}><Icon name="plus" size={14} /></button>
        </div>
      )}
      <div className="entry-list">
        {entries.length === 0 && <div className="muted sm-text">还没有内容，来添加第一条吧</div>}
        {entries.map((e) => (
          <div className="entry-item" key={e.id}>
            {kind === 'covers' && e.url && <img className="entry-cover" src={e.url} alt="" />}
            <div className="entry-main">
              <div>{e.value || (kind === 'covers' ? '自定义封面' : '')}</div>
              <div className="entry-by">由 {e.byName} 添加{activeId === e.id ? ' · 当前使用' : ''}</div>
            </div>
            {onActivate && activeId !== e.id && (
              <button className="btn sm ghost" onClick={() => onActivate(e.id)}>设为当前</button>
            )}
            {user?.id === e.by && (
              <button className="btn sm ghost danger" title="只能删除自己添加的" onClick={() => onDelete(e.id)}>
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommunityEditor({ comic, categories, onClose, onChanged }: {
  comic: CommunityComic;
  categories: Category[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const { user } = useSession();
  const [aliases, setAliases] = useState<MetaEntry[]>(comic.aliases || []);
  const [tags, setTags] = useState<MetaEntry[]>(comic.tagEntries || []);
  const [covers, setCovers] = useState<MetaEntry[]>(comic.covers || []);
  const [activeCoverId, setActiveCoverId] = useState(comic.activeCoverId);
  const [activeAliasId, setActiveAliasId] = useState(comic.activeAliasId);
  const [category, setCategory] = useState(comic.category || 'other');
  const [chapters, setChapters] = useState(comic.chapters);
  const [pages, setPages] = useState<{ chapterId: string; id: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.get(comic.id)
      .then((c) => setPages((c.chapters || []).flatMap((ch) => (ch.pages || []).map((p) => ({ chapterId: ch.id, id: p.id })))))
      .catch(() => {});
  }, [comic.id]);

  async function run<T>(p: Promise<T>, ok: string, after?: (r: T) => void) {
    setBusy(true);
    try {
      const r = await p;
      after?.(r);
      if (ok) toast(ok);
    } catch (err) {
      errorToast(err, '操作失败');
    } finally {
      setBusy(false);
    }
  }

  const addAlias = (v: string) => run(social.addAlias(comic.id, v), '已添加别名', (r) => setAliases(r.entries));
  const addTag = (v: string) => run(social.addTag(comic.id, v), '已添加标签', (r) => setTags(r.entries));

  return (
    <Modal
      title={`协作编辑 · ${comic.title}`}
      icon={<Icon name="users" />}
      onClose={onClose}
      width={720}
      footer={<button className="btn primary" onClick={onChanged}>完成</button>}
    >
      <div className="edit-note">
        <Icon name="lock" size={15} /> 所有人都能添加名称、标签、封面和话数；<b>只有添加者本人能删除自己那一条</b>。
      </div>

      <div className="edit-section">
        <h4>分类</h4>
        <div className="row" style={{ gap: 8 }}>
          <select className="select" style={{ flex: 1 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.filter((c) => c.id !== 'all').map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
          <button className="btn sm" onClick={() => run(
            discover.setCategory(comic.id, category), '分类已更新',
          )}>保存分类</button>
        </div>
      </div>

      <div className="edit-grid">
        <EntryList title="多个名字 / 别名" kind="aliases" entries={aliases} activeId={activeAliasId} placeholder="输入另一个书名或译名"
          onAdd={addAlias}
          onActivate={(id) => run(social.activateAlias(comic.id, id), '已设为显示名', () => setActiveAliasId(id))}
          onDelete={(id) => run(social.deleteEntry(comic.id, 'aliases', id), '已删除', (r) => setAliases(r.entries))} />
        <EntryList title="标签" kind="tags" entries={tags} placeholder="输入标签"
          onAdd={addTag}
          onDelete={(id) => run(social.deleteEntry(comic.id, 'tags', id), '已删除', (r) => setTags(r.entries))} />
      </div>

      <div className="edit-section">
        <h4>多个封面</h4>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <select className="select" style={{ flex: 1 }} id="cover-page-pick" defaultValue="">
            <option value="">从漫画页面里挑一张当封面…</option>
            {pages.map((p, i) => <option key={`${p.chapterId}-${p.id}`} value={`${p.chapterId}|${p.id}`}>第 {i + 1} 张页面</option>)}
          </select>
          <button className="btn sm" onClick={() => {
            const sel = document.getElementById('cover-page-pick') as HTMLSelectElement | null;
            const v = sel?.value || '';
            if (!v) return;
            const [chapterId, pageId] = v.split('|');
            run(social.addCoverPage(comic.id, chapterId, pageId), '已添加封面', (r) => { setCovers(r.entries); setActiveCoverId(r.id); });
          }}>添加</button>
          <input
            ref={(el) => { fileRef.current = el; }}
            type="file" accept="image/*" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(social.addCoverFile(comic.id, f, f.name), '已上传封面', (r) => { setCovers(r.entries); setActiveCoverId(r.id); });
              e.target.value = '';
            }}
          />
          <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={14} /> 上传图片</button>
        </div>
        <EntryList title="" kind="covers" entries={covers} activeId={activeCoverId} placeholder=""
          onAdd={() => {}}
          onActivate={(id) => run(social.activateCover(comic.id, id), '已设为当前封面', () => setActiveCoverId(id))}
          onDelete={(id) => run(social.deleteEntry(comic.id, 'covers', id), '已删除', (r) => setCovers(r.entries))} />
      </div>

      <div className="edit-section">
        <h4>话数 <span className="muted">（{chapters.length}）</span></h4>
        <div className="entry-list">
          {chapters.map((ch) => (
            <div className="entry-item" key={ch.id}>
              <div className="entry-main">
                <div>{ch.title} · {ch.pageCount} 页</div>
                <div className="entry-by">由 {ch.uploadedByName || comic.ownerName} 上传</div>
              </div>
              {user?.id === ch.uploadedBy && (
                <button className="btn sm ghost danger" onClick={() => run(
                  api.deleteChapter(comic.id, ch.id), '已删除该话',
                  (list) => setChapters(list.map((x) => ({ ...x, pageCount: x.pages?.length || 0, uploadedBy: x.uploadedBy || null, uploadedByName: '' }))),
                )}><Icon name="trash" size={13} /></button>
              )}
            </div>
          ))}
        </div>
        <div className="muted sm-text" style={{ marginTop: 8 }}>要追加新话，请进入漫画详情页「新建章节 / 导入图片」。</div>
      </div>
      {busy && <div className="muted sm-text">处理中…</div>}
    </Modal>
  );
}
