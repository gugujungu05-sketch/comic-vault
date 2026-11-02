import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, social } from '../lib/api';
import { useSession } from '../lib/session';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import type { CommunityComic, MetaEntry, ComicSummary } from '../types';

export function CommunityPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { user } = useSession();
  const [comics, setComics] = useState<CommunityComic[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommunityComic | null>(null);
  const [showPublish, setShowPublish] = useState(false);

  async function load() {
    try {
      const r = await social.community();
      setComics(r.comics);
    } catch (err) {
      errorToast(err, '加载公共书库失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const tags = useMemo(() => {
    const s = new Set<string>();
    comics.forEach((c) => {
      (c.tags || []).forEach((t) => s.add(t));
      (c.tagEntries || []).forEach((t) => s.add(t.value || ''));
    });
    return [...s].filter(Boolean).sort();
  }, [comics]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return comics.filter((c) => {
      if (tag) {
        const all = [...(c.tags || []), ...(c.tagEntries || []).map((t) => t.value || '')];
        if (!all.includes(tag)) return false;
      }
      if (!q) return true;
      const names = [c.title, c.baseTitle || '', ...(c.aliases || []).map((a) => a.value || '')];
      return names.some((n) => n.toLowerCase().includes(q)) || (c.author || '').toLowerCase().includes(q);
    });
  }, [comics, query, tag]);

  function requireLogin(): boolean {
    if (!user) {
      errorToast(new Error('请先登录后再操作'));
      navigate('/');
      return false;
    }
    return true;
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">公共书库</h1>
          <div className="page-sub">所有人都能上传话、补标签、加别名与封面；但只能删除自己上传的那一条</div>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn primary" onClick={() => { if (requireLogin()) setShowPublish(true); }}>
            <Icon name="upload" size={16} /> 发布漫画
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="search-wrap">
          <Icon name="search" size={16} />
          <input className="input" placeholder="搜索书名、别名、作者…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {tags.length > 0 && (
        <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <button className={`chip ${!tag ? 'active' : ''}`} onClick={() => setTag(null)}>全部</button>
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? 'active' : ''}`} onClick={() => setTag(t)}>
              <Icon name="tag" size={12} /> {t}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty"><Icon name="spinner" size={26} className="spin" /><div style={{ marginTop: 10 }}>加载中…</div></div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <Icon name="globe" size={34} />
          <h3>公共书库还是空的</h3>
          <div>把你的漫画发布到公共书库，大家就能一起补全元数据、追更话数</div>
        </div>
      ) : (
        <div className="comic-grid">
          {visible.map((c, i) => (
            <article className="comic-card anim-fade-up" key={c.id} style={{ animationDelay: `${i * 40}ms` }}>
              <div className="comic-cover" onClick={() => navigate(`/comic/${c.id}`)}>
                {c.coverUrl ? <img src={c.coverUrl} alt={c.title} loading="lazy" /> : <div className="cover-empty"><Icon name="book" size={30} /></div>}
                <span className="badge community"><Icon name="globe" size={12} /> 公共</span>
              </div>
              <div className="comic-body">
                <div className="comic-title" title={c.title}>{c.title}</div>
                <div className="comic-meta">{c.chapterCount} 话 · {c.pageCount} 页 · 由 {c.ownerName} 创建</div>
                {(c.aliases?.length || 0) > 0 && (
                  <div className="comic-meta">别名：{c.aliases!.map((a) => a.value).join(' / ')}</div>
                )}
                <div className="row wrap" style={{ gap: 6, margin: '8px 0' }}>
                  {(c.tagEntries || []).map((t) => (
                    <span className="chip sm" key={t.id}><Icon name="tag" size={11} /> {t.value}</span>
                  ))}
                  {(c.covers?.length || 0) > 1 && (
                    <span className="chip sm"><Icon name="image" size={11} /> {c.covers!.length} 张封面</span>
                  )}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => navigate(`/comic/${c.id}`)}><Icon name="play" size={14} /> 阅读</button>
                  <button className="btn sm primary" onClick={() => { if (requireLogin()) setEditing(c); }}>
                    <Icon name="edit" size={14} /> 协作编辑
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <CommunityEditor comic={editing} onClose={() => setEditing(null)} onChanged={async () => { await load(); setEditing(null); }} />
      )}
      {showPublish && (
        <PublishDialog onClose={() => setShowPublish(false)} onDone={async () => { setShowPublish(false); toast('已发布到公共书库'); await load(); }} />
      )}
    </main>
  );
}

/* ------------------------------ 发布到公共书库 ------------------------------ */

function PublishDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mine, setMine] = useState<ComicSummary[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const errorToast = useErrorToast();
  const navigate = useNavigate();

  useEffect(() => {
    api.list().then((r) => setMine(r.comics.filter((c) => c.scope !== 'community'))).catch(() => {});
  }, []);

  async function publishExisting() {
    if (!pick) return errorToast(new Error('请先选择一本漫画'));
    setBusy(true);
    try {
      await api.update(pick, { scope: 'community', visibility: 'public' });
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

function CommunityEditor({ comic, onClose, onChanged }: {
  comic: CommunityComic;
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
      toast(ok);
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
