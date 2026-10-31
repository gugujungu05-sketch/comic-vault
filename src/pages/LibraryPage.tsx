import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { ComicSummary, Stats } from '../types';
import { ComicCard } from '../components/ComicCard';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ImportDialog } from '../components/ImportDialog';
import { ShareDialog } from '../components/ShareDialog';
import { useErrorToast, useToast } from '../components/Toasts';
import { formatBytes } from '../lib/util';

type SortKey = 'updated' | 'title' | 'pages' | 'created';

export function LibraryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
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

  async function load() {
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
          <button className="btn" onClick={() => setShowImport(true)}>
            <Icon name="upload" size={16} /> 导入漫画
          </button>
          <button className="btn primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={16} /> 新建漫画
          </button>
        </div>
      </div>

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
            />
          ))}
        </div>
      ) : (
        <div className="chapter-list">
          {visible.map((c) => (
            <div className="chapter-item" key={c.id} onClick={() => navigate(`/comic/${c.id}`)} style={{ cursor: 'pointer' }}>
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
    </main>
  );
}

function NewComicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [tags, setTags] = useState('');
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
    </Modal>
  );
}
