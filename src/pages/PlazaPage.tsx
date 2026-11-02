import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { social } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { withShareCode, formatDate, classNames } from '../lib/util';
import type { ComicSummary, PlazaPost } from '../types';

export function PlazaPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [posts, setPosts] = useState<PlazaPost[]>([]);
  const [mine, setMine] = useState<ComicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [comicId, setComicId] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await social.posts();
      setPosts(r.posts);
    } catch (err) {
      errorToast(err, '加载广场失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    if (user) {
      fetch('/api/comics').then((r) => r.json()).then((d) => setMine(d.comics || [])).catch(() => {});
    }
  }, [user?.id]);

  function requireLogin(): boolean {
    if (!user) {
      errorToast(new Error('登录后才能参与讨论'));
      navigate('/');
      return false;
    }
    return true;
  }

  async function publish() {
    if (!requireLogin()) return;
    if (!content.trim() && !comicId) return errorToast(new Error('写点什么再发吧'));
    setBusy(true);
    try {
      await social.createPost({ content: content.trim(), comicId: comicId || undefined, shareUrl: shareUrl.trim() || undefined });
      setContent(''); setComicId(''); setShareUrl('');
      toast('已发布到广场');
      await load();
    } catch (err) {
      errorToast(err, '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function act(p: Promise<unknown>, ok: string) {
    try {
      await p;
      if (ok) toast(ok);
      await load();
    } catch (err) {
      errorToast(err, '操作失败');
    }
  }

  return (
    <main className="page plaza-page">
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">广场</h1>
          <div className="page-sub">聊漫画、分享书单、推荐好作品 · {posts.length} 条动态</div>
        </div>
      </div>

      <div className="post-composer">
        <textarea
          className="input"
          rows={3}
          placeholder={user ? '今天想聊点什么？推荐一本漫画、吐槽一话剧情…' : '登录后即可发帖讨论'}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onFocus={() => { if (!user) navigate('/'); }}
        />
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          {user && mine.length > 0 && (
            <select className="select" style={{ maxWidth: 240 }} value={comicId} onChange={(e) => setComicId(e.target.value)}>
              <option value="">不附带漫画</option>
              {mine.map((c) => <option key={c.id} value={c.id}>📚 {c.title}</option>)}
            </select>
          )}
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="或粘贴一个分享链接（可选）" value={shareUrl} onChange={(e) => setShareUrl(e.target.value)} />
          <button className="btn primary" onClick={publish} disabled={busy}><Icon name="message" size={15} /> 发布</button>
        </div>
      </div>

      {loading ? (
        <div className="empty"><Icon name="spinner" size={26} className="spin" /><div style={{ marginTop: 10 }}>加载中…</div></div>
      ) : posts.length === 0 ? (
        <div className="empty"><Icon name="message" size={34} /><h3>广场还很安静</h3><div>发第一条动态，推荐你喜欢的漫画吧</div></div>
      ) : (
        <div className="post-list">
          {posts.map((p) => {
            const liked = !!user && p.likes.includes(user.id);
            return (
              <article className="post-card" key={p.id}>
                <div className="post-head">
                  <Link to={`/u/${p.authorId}`} className="post-author">
                    <span className="avatar sm">{p.authorName.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <div className="post-name">{p.authorName}</div>
                      <div className="post-time">{formatDate(p.createdAt)}</div>
                    </div>
                  </Link>
                  {user?.id === p.authorId && (
                    <button className="btn sm ghost danger" onClick={() => act(social.deletePost(p.id), '已删除')} title="删除自己的帖子">
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                {p.content && <div className="post-content">{p.content}</div>}
                {p.comic && (
                  <Link to={`/comic/${p.comic.id}`} className="post-comic">
                    {p.comic.coverUrl ? <img src={p.comic.coverUrl} alt="" /> : <div className="post-comic-empty"><Icon name="book" size={22} /></div>}
                    <div>
                      <div className="post-comic-title">{p.comic.title}</div>
                      <div className="post-comic-sub">{p.comic.chapterCount} 话 · 点击查看详情</div>
                    </div>
                  </Link>
                )}
                {p.shareUrl && (
                  <a className="post-share-link" href={withShareCode(p.shareUrl)} target="_blank" rel="noreferrer">
                    <Icon name="link" size={14} /> 打开分享链接
                  </a>
                )}
                <div className="post-actions">
                  <button className={classNames('chip sm', liked && 'active')} onClick={() => { if (requireLogin()) act(social.likePost(p.id), ''); }}>
                    <Icon name="heart" size={13} /> {p.likes.length}
                  </button>
                  <span className="muted sm-text">{p.comments.length} 条评论</span>
                </div>
                <div className="comment-list">
                  {p.comments.map((c) => (
                    <div className="comment" key={c.id}>
                      <span className="avatar xs">{c.byName.slice(0, 1).toUpperCase()}</span>
                      <div className="comment-body">
                        <b>{c.byName}</b> {c.content}
                        <div className="post-time">{formatDate(c.at)}</div>
                      </div>
                      {user?.id === c.by && (
                        <button className="btn sm ghost danger" onClick={() => act(social.deleteComment(p.id, c.id), '')} title="删除自己的评论">
                          <Icon name="trash" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input
                    className="input" placeholder={user ? '写条评论…' : '登录后评论'}
                    value={commentDraft[p.id] || ''}
                    onChange={(e) => setCommentDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (commentDraft[p.id] || '').trim() && requireLogin()) {
                        const v = commentDraft[p.id].trim();
                        setCommentDraft((d) => ({ ...d, [p.id]: '' }));
                        act(social.comment(p.id, v), '');
                      }
                    }}
                  />
                  <button className="btn sm" onClick={() => {
                    const v = (commentDraft[p.id] || '').trim();
                    if (v && requireLogin()) { setCommentDraft((d) => ({ ...d, [p.id]: '' })); act(social.comment(p.id, v), ''); }
                  }}>发送</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
