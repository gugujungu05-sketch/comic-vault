import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, social, exportUrl } from '../lib/api';
import type { ComicSummary, Stats } from '../types';
import { ComicCard } from '../components/ComicCard';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ImportDialog } from '../components/ImportDialog';
import { ShareDialog } from '../components/ShareDialog';
import { ActivityFeed } from '../components/ActivityFeed';
import { useErrorToast, useToast } from '../components/Toasts';
import { useSession } from '../lib/session';
import { formatBytes } from '../lib/util';

type SortKey = 'updated' | 'title' | 'pages' | 'created';

export function LibraryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { user } = useSession();
  const [comics, setComics] = useState<ComicSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('updated');
  const [onlyFav, setOnlyFav] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [shareComic, setShareComic] = useState<ComicSummary | null>(null);
  const [dropped, setDropped] = useState(false);
  const dragDepth = useRef(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkTag, setBulkTag] = useState('');

  async function load() {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const [list, st] = await Promise.all([api.list(), api.stats()]);
      setComics(list.comics);
      setStats(st);
    } catch (err) {
      errorToast(err, '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const tags = useMemo(() => {
    const set = new Set<string>();
    comics.forEach((c) => (c.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [comics]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = comics.filter((c) => {
      if (onlyFav && !c.favorite) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        (c.author || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (c.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    });
    list = [...list].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh');
      if (sort === 'pages') return b.pageCount - a.pageCount;
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return list;
  }, [comics, query, tag, sort, onlyFav]);

  async function toggleFavorite(id: string, next: boolean) {
    setComics((prev) => prev.map((c) => (c.id === id ? { ...c, favorite: next } : c)));
    try {
      await api.update(id, { favorite: next });
    } catch (err) {
      errorToast(err, '更新失败');
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectAll() {
    setSelected(new Set(visible.map((c) => c.id)));
  }

  function clearSelection() {
    setSelected(new Set());
    setSelecting(false);
  }

  async function bulkDelete() {
    setBulkBusy(true);
    try {
      await Promise.all([...selected].map((id) => api.remove(id).catch(() => null)));
      toast(`已删除 ${selected.size} 部漫画`);
      clearSelection();
      await load();
    } catch (err) {
      errorToast(err, '删除失败');
    } finally {
      setBulkBusy(false);
      setConfirmDelete(false);
    }
  }

  async function bulkAddTag() {
    const t = bulkTag.trim();
    if (!t) return;
    setBulkBusy(true);
    try {
      await Promise.all([...selected].map((id) => social.addTag(id, t).catch(() => null)));
      toast(`已为 ${selected.size} 部添加标签「${t}」`);
      setBulkTag('');
      await load();
    } catch (err) {
      errorToast(err, '加标签失败');
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkExport() {
    [...selected].forEach((id) => {
      const a = document.createElement('a');
      a.href = exportUrl(id, 'cbz');
      a.download = '';
      a.click();
    });
    toast('已发起批量导出（CBZ）');
  }

  return (
    <main
      className="page"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        setDropped(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current--;
        if (dragDepth.current <= 0) setDropped(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropped(false);
        setShowImport(true);
      }}
    >
      {dropped && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 90,
            display: 'grid',
            placeItems: 'center',
            background: 'color-mix(in srgb, var(--bg) 72%, transparent)',
            backdropFilter: 'blur(4px)',
            pointerEvents: 'none',
          }}
        >
          <div className="dropzone over" style={{ padding: '40px 60px', pointerEvents: 'none' }}>
            <div className="big">松开即可导入漫画</div>
            <div>支持图片 / 文件夹 / ZIP·CBZ / PDF，自动分话</div>
          </div>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">我的漫画库</h1>
          <div className="page-sub">
            {comics.length} 部作品 · {stats?.pageCount ?? 0} 页 · 占用 {formatBytes(stats?.storageBytes || 0)}
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          {user ? (
            <>
              {!selecting ? (
                <button className="btn" onClick={() => setSelecting(true)}>
                  <Icon name="check-square" size={16} /> 多选
                </button>
              ) : (
                <button className="btn ghost" onClick={clearSelection}>
                  <Icon name="x" size={16} /> 取消多选
                </button>
              )}
              <button className="btn" onClick={() => setShowImport(true)}>
                <Icon name="upload" size={16} /> 导入漫画
              </button>
              <button className="btn primary" onClick={() => setShowNew(true)}>
                <Icon name="plus" size={16} /> 新建漫画
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => navigate('/?login=1')}>
              <Icon name="user" size={16} /> 登录 / 注册
            </button>
          )}
        </div>
      </div>

      {!user && (
        <div className="anon-welcome">
          <div className="anon-welcome-icon"><Icon name="book" size={30} /></div>
          <h2>欢迎来到 ComicVault</h2>
          <p>登录后即可上传、分话管理并同步你自己的漫画；现在也能直接浏览公共书库与广场。</p>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => navigate('/?login=1')}>
              <Icon name="user" size={16} /> 登录 / 注册
            </button>
            <button className="btn" onClick={() => navigate('/community')}>
              <Icon name="globe" size={16} /> 先逛逛公共书库
            </button>
          </div>
        </div>
      )}

      {stats && (
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <div className="stat-card anim-fade-up">
            <div className="v">{stats.comicCount}</div>
            <div className="k">部作品</div>
          </div>
          <div className="stat-card anim-fade-up" style={{ animationDelay: '60ms' }}>
            <div className="v">{stats.chapterCount}</div>
            <div className="k">个章节</div>
          </div>
          <div className="stat-card anim-fade-up" style={{ animationDelay: '120ms' }}>
            <div className="v">{stats.pageCount}</div>
            <div className="k">页图片</div>
          </div>
          <div className="stat-card anim-fade-up" style={{ animationDelay: '180ms' }}>
            <div className="v">{formatBytes(stats.storageBytes)}</div>
            <div className="k">本地占用</div>
          </div>
        </div>
      )}

      <ActivityFeed />

      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search-wrap">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="搜索标题、作者、标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="select" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="updated">最近更新</option>
          <option value="created">最新添加</option>
          <option value="title">标题排序</option>
          <option value="pages">页数最多</option>
        </select>
        <button className={`chip ${onlyFav ? 'active' : ''}`} onClick={() => setOnlyFav(!onlyFav)}>
          <Icon name="star" size={13} /> 收藏
        </button>
        <button className="btn icon ghost" onClick={() => setView(view === 'grid' ? 'list' : 'grid')} title="切换视图">
          <Icon name={view === 'grid' ? 'list' : 'grid'} />
        </button>
      </div>

      {tags.length > 0 && (
        <div className="row" style={{ marginBottom: 16 }}>
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? 'active' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
              <Icon name="tag" size={12} /> {t}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty">
          <Icon name="spinner" size={26} className="spin" />
          <div style={{ marginTop: 10 }}>加载中…</div>
        </div>
      ) : visible.length === 0 ? (
        <div
          className={`empty dropzone ${dropped ? 'over' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current++;
            setDropped(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current--;
            if (dragDepth.current <= 0) setDropped(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDropped(false);
            setShowImport(true);
          }}
        >
          <Icon name="book" size={34} />
          <h3>书架还是空的</h3>
          <div>把图片、文件夹、ZIP/CBZ 或 PDF 拖到这里，或直接点击「导入漫画」</div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
            <button className="btn primary" onClick={() => setShowImport(true)}>
              <Icon name="upload" size={16} /> 导入第一本漫画
            </button>
          </div>
        </div>
      ) : view === 'grid' ? (
        <div className="comic-grid">
          {visible.map((c, i) => (
            <ComicCard
              key={c.id}
              comic={c}
              index={i}
              onToggleFavorite={toggleFavorite}
              onShare={(x) => setShareComic(x)}
              selecting={selecting}
              selected={selected.has(c.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      ) : (
        <div className="chapter-list">
          {visible.map((c) => (
            <div
              className={`chapter-item ${selecting ? 'selecting' : ''} ${selected.has(c.id) ? 'selected' : ''}`}
              key={c.id}
              onClick={() => (selecting ? toggleSelect(c.id) : navigate(`/comic/${c.id}`))}
              style={{ cursor: 'pointer' }}
            >
              {selecting && (
                <button
                  className={`card-check ${selected.has(c.id) ? 'on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }}
                  aria-label="选择"
                >
                  {selected.has(c.id) && <Icon name="check" size={14} />}
                </button>
              )}
              <div className="chapter-thumb">
                {c.coverUrl && <img src={c.coverUrl} alt="" loading="lazy" />}
              </div>
              <div className="chapter-main">
                <div className="chapter-title">
                  {c.title}
                  {c.favorite && <Icon name="star" size={13} color="var(--warn)" />}
                </div>
                <div className="chapter-sub">
                  {c.chapterCount} 话 · {c.pageCount} 页 · {c.author || '未知作者'}
                  {c.share?.enabled ? ' · 分享中' : ''}
                </div>
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/read/${c.id}`);
                  }}
                >
                  <Icon name="play" size={14} /> 阅读
                </button>
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShareComic(c);
                  }}
                >
                  <Icon name="share" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && <NewComicDialog onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/comic/${id}`)} />}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onDone={(id) => {
            setShowImport(false);
            toast('导入完成');
            navigate(`/comic/${id}`);
          }}
        />
      )}
      {shareComic && (
        <ShareDialog
          comic={shareComic}
          onClose={() => setShareComic(null)}
          onChanged={(share) =>
            setComics((prev) => prev.map((c) => (c.id === shareComic.id ? { ...c, share } : c)))
          }
        />
      )}

      {selecting && selected.size > 0 && (
        <div className="bulk-bar">
          <div className="bulk-info">
            已选 <b>{selected.size}</b> 部
            <button className="btn sm ghost" onClick={selectAll}>全选当前</button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>清空</button>
          </div>
          <div className="bulk-actions">
            <div className="bulk-tag">
              <input
                className="input sm"
                placeholder="加标签…"
                value={bulkTag}
                onChange={(e) => setBulkTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && bulkAddTag()}
              />
              <button className="btn sm" onClick={bulkAddTag} disabled={bulkBusy || !bulkTag.trim()}>
                <Icon name="tag" size={13} /> 加标签
              </button>
            </div>
            <button className="btn sm" onClick={bulkExport} disabled={bulkBusy}>
              <Icon name="download" size={13} /> 导出 CBZ
            </button>
            <button className="btn sm danger" onClick={() => setConfirmDelete(true)} disabled={bulkBusy}>
              <Icon name="trash" size={13} /> 删除
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <Modal
          title="确认删除"
          icon={<Icon name="trash" />}
          onClose={() => setConfirmDelete(false)}
          width={420}
          footer={<>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>取消</button>
            <button className="btn danger" onClick={bulkDelete} disabled={bulkBusy}>{bulkBusy ? '删除中…' : `删除 ${selected.size} 部`}</button>
          </>}
        >
          <p>确定要删除选中的 <b>{selected.size}</b> 部漫画吗？此操作不可恢复，封面与全部页面图片都会删除。</p>
        </Modal>
      )}
    </main>
  );
}

function NewComicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [tags, setTags] = useState('');
  const [scope, setScope] = useState<'personal' | 'community'>('personal');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [allowDownload, setAllowDownload] = useState(true);
  const [busy, setBusy] = useState(false);
  const errorToast = useErrorToast();

  async function create(afterImport: boolean) {
    if (!title.trim()) {
      errorToast(new Error('请先填写标题'));
      return;
    }
    setBusy(true);
    try {
      const comic = await api.create({
        title: title.trim(),
        author: author.trim(),
        direction,
        tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        scope,
        visibility: scope === 'community' ? 'public' : visibility,
        allowDownload,
      });
      if (afterImport) onClose();
      onCreated(comic.id);
    } catch (err) {
      errorToast(err, '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建漫画"
      icon={<Icon name="plus" />}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => create(false)} disabled={busy}>
            创建
          </button>
        </>
      }
    >
      <div className="field">
        <label>标题</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：星海拾遗" />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>作者</label>
          <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
        </div>
        <div className="field">
          <label>阅读方向</label>
          <select className="select" value={direction} onChange={(e) => setDirection(e.target.value as 'ltr' | 'rtl')}>
            <option value="ltr">从左往右（LTR）</option>
            <option value="rtl">从右往左（日漫 RTL）</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>标签（逗号分隔）</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="热血, 科幻, 完结" />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>存放位置</label>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'personal' | 'community')}>
            <option value="personal">我的私人书架</option>
            <option value="community">公共书库（所有人可见）</option>
          </select>
        </div>
        <div className="field">
          <label>可见性</label>
          <select
            className="select"
            value={scope === 'community' ? 'public' : visibility}
            disabled={scope === 'community'}
            onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
          >
            <option value="private">私密（仅自己 + 分享链接）</option>
            <option value="public">公开（别人可看）</option>
          </select>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
        允许别人下载（公开 / 分享时生效）
      </label>
    </Modal>
  );
}
