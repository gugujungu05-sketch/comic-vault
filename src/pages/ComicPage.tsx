import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Chapter, Comic } from '../types';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ImportDialog } from '../components/ImportDialog';
import { ExportDialog } from '../components/ExportDialog';
import { ShareDialog } from '../components/ShareDialog';
import { useErrorToast, useToast } from '../components/Toasts';
import { copyText, formatDate } from '../lib/util';

export function ComicPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [comic, setComic] = useState<Comic | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [folderImport, setFolderImport] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function load() {
    if (!id) return;
    try {
      setComic(await api.get(id));
    } catch (err) {
      errorToast(err, '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  const chapterMap = useMemo(() => {
    const map = new Map<string, Chapter>();
    comic?.chapters.forEach((c) => map.set(c.id, c));
    return map;
  }, [comic]);

  if (loading) {
    return (
      <main className="page">
        <div className="empty">
          <Icon name="spinner" size={26} className="spin" />
        </div>
      </main>
    );
  }

  if (!comic) {
    return (
      <main className="page">
        <div className="empty">
          <h3>漫画不存在</h3>
          <button className="btn" onClick={() => navigate('/')}>
            返回书架
          </button>
        </div>
      </main>
    );
  }

  const progressChapter = comic.progress ? chapterMap.get(comic.progress.chapterId) : null;

  async function moveChapter(index: number, delta: number) {
    if (!comic) return;
    const order = comic.chapters.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    const next = await api.reorderChapters(comic.id, order).catch((err) => {
      errorToast(err);
      return null;
    });
    if (next) setComic({ ...comic, chapters: next.map((c) => ({ ...c, pages: chapterMap.get(c.id)?.pages || c.pages })) });
    else await load();
  }

  async function removeChapter(chapterId: string) {
    if (!comic) return;
    if (!confirm('删除该话及其所有页面？此操作不可撤销。')) return;
    try {
      const next = await api.deleteChapter(comic.id, chapterId);
      setComic({ ...comic, chapters: next });
      toast('已删除');
    } catch (err) {
      errorToast(err);
    }
  }

  async function addChapter() {
    if (!comic) return;
    const title = prompt('新章节标题', `第 ${comic.chapters.length + 1} 话`);
    if (!title) return;
    const next = await api.addChapter(comic.id, { title, number: comic.chapters.length + 1 });
    setComic({ ...comic, chapters: next });
  }

  async function renameChapter(ch: Chapter) {
    const title = prompt('章节标题', ch.title);
    if (!title || !comic) return;
    const next = await api.updateChapter(comic.id, ch.id, { title });
    setComic({ ...comic, chapters: next.map((c) => ({ ...c, pages: chapterMap.get(c.id)?.pages || c.pages })) });
  }

  async function uploadCover(file: File) {
    if (!comic) return;
    try {
      const res = await api.uploadCover(comic.id, file, file.name);
      setComic({ ...comic, coverUrl: res.coverUrl, coverPageId: null });
      toast('封面已更新');
    } catch (err) {
      errorToast(err);
    }
  }

  async function setCoverFromPage(chapterId: string, pageId: string) {
    if (!comic) return;
    try {
      await api.setCoverPage(comic.id, chapterId, pageId);
      await load();
      toast('已设为封面');
    } catch (err) {
      errorToast(err);
    }
  }

  async function deletePickedPages(chapterId: string) {
    if (!comic) return;
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return;
    if (!confirm(`删除选中的 ${ids.length} 页？`)) return;
    try {
      for (const pageId of ids) await api.deletePage(comic.id, chapterId, pageId);
      setPicked({});
      await load();
      toast('已删除');
    } catch (err) {
      errorToast(err);
    }
  }

  async function movePickedPages(fromChapterId: string) {
    if (!comic) return;
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return;
    const target = prompt('移动到哪一话？请输入章节标题', comic.chapters.find((c) => c.id !== fromChapterId)?.title || '');
    if (!target) return;
    const targetChapter = comic.chapters.find((c) => c.title === target);
    if (!targetChapter) {
      errorToast(new Error('找不到该章节'));
      return;
    }
    try {
      const res = await api.movePages(comic.id, fromChapterId, ids, targetChapter.id);
      setPicked({});
      await load();
      toast(`已移动 ${res.moved} 页`);
    } catch (err) {
      errorToast(err);
    }
  }

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn sm ghost" onClick={() => navigate('/')}>
          <Icon name="left" size={14} /> 返回书架
        </button>
      </div>

      <div className="detail-hero anim-fade-up">
        <div className="hero-cover">
          {comic.coverUrl ? <img src={comic.coverUrl} alt={comic.title} /> : <div className="cover-empty"><Icon name="book" size={30} /></div>}
          <div className="row" style={{ marginTop: 8 }}>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              <Icon name="image" size={14} /> 换封面
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && uploadCover(e.target.files[0])}
              />
            </label>
          </div>
        </div>

        <div>
          <div className="row">
            <h1 className="page-title" style={{ marginRight: 8 }}>{comic.title}</h1>
            <button className="btn icon ghost" onClick={() => setEditing(true)} title="编辑信息">
              <Icon name="edit" />
            </button>
            <button
              className={`btn icon ghost ${comic.favorite ? 'on' : ''}`}
              onClick={async () => {
                const next = !comic.favorite;
                setComic({ ...comic, favorite: next });
                await api.update(comic.id, { favorite: next }).catch(() => {});
              }}
              title="收藏"
              style={{ color: comic.favorite ? 'var(--warn)' : undefined }}
            >
              <Icon name="star" size={16} fill={comic.favorite ? 'currentColor' : 'none'} />
            </button>
          </div>

          <div className="card-meta" style={{ marginTop: 6 }}>
            <span>{comic.author || '未知作者'}</span>
            <span>{comic.chapterCount} 话</span>
            <span>{comic.pageCount} 页</span>
            <span>{comic.direction === 'rtl' ? '日漫顺序 RTL' : '左起 LTR'}</span>
            <span>
              {comic.status === 'completed' ? '已完结' : comic.status === 'hiatus' ? '暂停更新' : '连载中'}
            </span>
            <span>更新于 {formatDate(comic.updatedAt)}</span>
          </div>

          {!!comic.tags.length && (
            <div className="row" style={{ marginTop: 10 }}>
              {comic.tags.map((t) => (
                <span className="chip" key={t}>
                  <Icon name="tag" size={12} /> {t}
                </span>
              ))}
            </div>
          )}

          {comic.description && (
            <p style={{ color: 'var(--muted)', marginTop: 10, whiteSpace: 'pre-wrap' }}>{comic.description}</p>
          )}

          {progressChapter && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>
              上次读到：<b>{progressChapter.title}</b> 第 {comic.progress!.pageIndex + 1} 页
            </div>
          )}

          <div className="toolbar">
            <button className="btn primary" onClick={() => navigate(`/read/${comic.id}`)}>
              <Icon name="play" size={16} /> {progressChapter ? '继续阅读' : '开始阅读'}
            </button>
            <button className="btn" onClick={() => setImporting(true)}>
              <Icon name="upload" size={16} /> 导入并分话
            </button>
            <button className="btn" onClick={() => setExporting([])}>
              <Icon name="download" size={16} /> 保存到本地
            </button>
            <button className="btn" onClick={() => setSharing(true)}>
              <Icon name="share" size={16} /> 分享
            </button>
            <button className="btn ghost" onClick={() => setFolderImport(true)}>
              <Icon name="folder" size={16} /> 从服务器目录导入
            </button>
            <button
              className="btn ghost"
              onClick={async () => {
                try {
                  const copy = await api.duplicate(comic.id);
                  toast('已创建副本');
                  navigate(`/comic/${copy.id}`);
                } catch (err) {
                  errorToast(err, '创建副本失败');
                }
              }}
            >
              <Icon name="copy" size={16} /> 创建副本
            </button>
            <button className="btn danger ghost" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={16} /> 删除
            </button>
          </div>
        </div>
      </div>

      <div className="row" style={{ margin: '18px 0 10px' }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>章节（{comic.chapters.length}）</h2>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={addChapter}>
            <Icon name="plus" size={14} /> 新建空章节
          </button>
          <button className="btn sm" onClick={() => setImporting(true)}>
            <Icon name="upload" size={14} /> 导入图片
          </button>
        </div>
      </div>

      <div className="chapter-list">
        {comic.chapters.map((ch, i) => {
          const first = ch.pages[0];
          const open = expanded === ch.id;
          return (
            <div key={ch.id}>
              <div className="chapter-item">
                <div className="chapter-thumb">
                  {first && <img src={first.thumbUrl || first.url} alt="" loading="lazy" />}
                </div>
                <div className="chapter-main">
                  <div className="chapter-title">
                    {ch.title}
                    {comic.progress?.chapterId === ch.id && <span className="badge accent">在读</span>}
                  </div>
                  <div className="chapter-sub">{ch.pages.length} 页</div>
                </div>
                <div className="row">
                  <button className="btn sm" onClick={() => navigate(`/read/${comic.id}?chapter=${ch.id}`)}>
                    <Icon name="play" size={14} />
                  </button>
                  <button className="btn sm ghost" onClick={() => setExpanded(open ? null : ch.id)} title="管理页面">
                    <Icon name={open ? 'up' : 'down'} size={14} />
                  </button>
                  <button className="btn sm ghost" onClick={() => renameChapter(ch)} title="重命名">
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="btn sm ghost" onClick={() => moveChapter(i, -1)} disabled={i === 0} title="上移">
                    <Icon name="up" size={14} />
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => moveChapter(i, 1)}
                    disabled={i === comic.chapters.length - 1}
                    title="下移"
                  >
                    <Icon name="down" size={14} />
                  </button>
                  <button className="btn sm ghost" onClick={() => setExporting([ch.id])} title="导出该话">
                    <Icon name="download" size={14} />
                  </button>
                  <button className="btn sm ghost" onClick={() => removeChapter(ch.id)} title="删除">
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>

              {open && (
                <div style={{ padding: '10px 10px 14px', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 10px 10px', background: 'var(--bg-soft)' }}>
                  {ch.pages.length === 0 ? (
                    <div style={{ color: 'var(--muted)', fontSize: 13 }}>该章节还没有页面，点击「导入图片」添加。</div>
                  ) : (
                    <>
                      <div className="row" style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                          已选 {Object.values(picked).filter(Boolean).length} 页
                        </span>
                        <button className="btn sm" onClick={() => deletePickedPages(ch.id)}>
                          <Icon name="trash" size={13} /> 删除选中
                        </button>
                        <button className="btn sm" onClick={() => movePickedPages(ch.id)}>
                          <Icon name="right" size={13} /> 移动到其它话
                        </button>
                        <button
                          className="btn sm ghost"
                          onClick={() => setPicked(Object.fromEntries(ch.pages.map((p) => [p.id, true])))}
                        >
                          全选
                        </button>
                        <button className="btn sm ghost" onClick={() => setPicked({})}>
                          取消选择
                        </button>
                      </div>
                      <div className="thumb-grid">
                        {ch.pages.map((p, idx) => (
                          <button
                            key={p.id}
                            className={picked[p.id] ? 'active' : ''}
                            onClick={() => setPicked({ ...picked, [p.id]: !picked[p.id] })}
                            onDoubleClick={() => setCoverFromPage(ch.id, p.id)}
                            title="单击选择，双击设为封面"
                          >
                            <img src={p.thumbUrl || p.url} alt="" loading="lazy" />
                            <span className="n">{idx + 1}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {comic.chapters.length === 0 && (
          <div className="empty">
            <Icon name="folder" size={28} />
            <h3>还没有章节</h3>
            <div>导入图片后会自动按规则分成一话一话</div>
          </div>
        )}
      </div>

      {editing && (
        <EditMetaDialog
          comic={comic}
          onClose={() => setEditing(false)}
          onSaved={(c) => {
            setComic({ ...comic, ...c });
            setEditing(false);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          comicId={comic.id}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          comicId={comic.id}
          comicTitle={comic.title}
          chapters={comic.chapters}
          initialSelected={exporting}
          onClose={() => setExporting(null)}
        />
      )}
      {sharing && (
        <ShareDialog
          comic={comic}
          onClose={() => setSharing(false)}
          onChanged={(share) => setComic({ ...comic, share })}
        />
      )}
      {folderImport && (
        <FolderImportDialog
          comicId={comic.id}
          onClose={() => setFolderImport(false)}
          onDone={() => {
            setFolderImport(false);
            load();
            toast('导入完成');
          }}
        />
      )}
      {confirmDelete && (
        <Modal
          title="删除漫画"
          onClose={() => setConfirmDelete(false)}
          width={420}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.remove(comic.id);
                  toast('已删除');
                  navigate('/');
                }}
              >
                确认删除
              </button>
            </>
          }
        >
          <div>将删除《{comic.title}》的全部章节与图片文件，此操作不可撤销。</div>
        </Modal>
      )}
    </main>
  );
}

function EditMetaDialog({
  comic,
  onClose,
  onSaved,
}: {
  comic: Comic;
  onClose: () => void;
  onSaved: (c: Partial<Comic>) => void;
}) {
  const [form, setForm] = useState({
    title: comic.title,
    author: comic.author,
    artist: comic.artist,
    description: comic.description,
    tags: comic.tags.join(', '),
    status: comic.status,
    direction: comic.direction,
    language: comic.language,
  });
  const [busy, setBusy] = useState(false);
  const errorToast = useErrorToast();

  async function save() {
    setBusy(true);
    try {
      const updated = await api.update(comic.id, {
        title: form.title,
        author: form.author,
        artist: form.artist,
        description: form.description,
        tags: form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        status: form.status,
        direction: form.direction,
        language: form.language,
      });
      onSaved(updated);
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="编辑漫画信息"
      icon={<Icon name="edit" />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label>标题</label>
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>作者</label>
          <input className="input" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
        </div>
        <div className="field">
          <label>绘者</label>
          <input className="input" value={form.artist} onChange={(e) => setForm({ ...form, artist: e.target.value })} />
        </div>
        <div className="field">
          <label>连载状态</label>
          <select className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Comic['status'] })}>
            <option value="ongoing">连载中</option>
            <option value="completed">已完结</option>
            <option value="hiatus">暂停更新</option>
          </select>
        </div>
        <div className="field">
          <label>阅读方向</label>
          <select
            className="select"
            value={form.direction}
            onChange={(e) => setForm({ ...form, direction: e.target.value as 'ltr' | 'rtl' })}
          >
            <option value="ltr">从左往右 LTR</option>
            <option value="rtl">从右往左 RTL</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>标签（逗号分隔）</label>
        <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
      </div>
      <div className="field">
        <label>简介</label>
        <textarea className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
    </Modal>
  );
}

function FolderImportDialog({
  comicId,
  onClose,
  onDone,
}: {
  comicId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dir, setDir] = useState('');
  const [mode, setMode] = useState<'folder' | 'flat'>('folder');
  const [per, setPer] = useState(30);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const errorToast = useErrorToast();

  async function run() {
    setBusy(true);
    try {
      const res = await api.importFolder({ dir, mode, pagesPerChapter: per, comicId });
      toast(`已导入 ${res.chapters.length} 话`);
      onDone();
    } catch (err) {
      errorToast(err, '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="从服务器目录导入"
      icon={<Icon name="folder" />}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={run} disabled={busy || !dir}>
            {busy ? '导入中…' : '开始导入'}
          </button>
        </>
      }
    >
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
        直接读取运行 ComicVault 的机器上的目录，无需上传，适合一次导入几十 GB 的本地漫画。
      </div>
      <div className="field">
        <label>目录绝对路径</label>
        <input className="input" placeholder="/home/user/manga/某部作品" value={dir} onChange={(e) => setDir(e.target.value)} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>分话方式</label>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'folder' | 'flat')}>
            <option value="folder">每个子目录一话</option>
            <option value="flat">平铺后按页数切分</option>
          </select>
        </div>
        {mode === 'flat' && (
          <div className="field">
            <label>每话页数</label>
            <input className="input" type="number" value={per} onChange={(e) => setPer(Number(e.target.value) || 30)} />
          </div>
        )}
      </div>
      <button
        className="btn sm ghost"
        onClick={() => {
          copyText(dir);
          toast('已复制路径模板');
        }}
      >
        <Icon name="copy" size={14} /> 复制当前路径
      </button>
    </Modal>
  );
}
