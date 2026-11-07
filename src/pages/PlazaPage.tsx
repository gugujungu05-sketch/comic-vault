import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { social } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { PostComposer } from '../components/PostComposer';
import { PostAttachments } from '../components/PostAttachments';
import { RichText } from '../components/RichText';
import { EmojiPicker, EmojiSuggestions, useEmojiPreference, useStickers } from '../components/EmojiKit';
import { withShareCode, formatDate, classNames } from '../lib/util';
import type { PlazaBoard, PlazaPost } from '../types';

export function PlazaPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { enabled: autoSearch, setEnabled: setAutoSearch } = useEmojiPreference();
  const { stickers, reload: reloadStickers } = useStickers();

  const [posts, setPosts] = useState<PlazaPost[]>([]);
  const [boards, setBoards] = useState<PlazaBoard[]>([]);
  const [activeBoard, setActiveBoard] = useState('all');
  const [search, setSearch] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [openEmojiFor, setOpenEmojiFor] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('cv-unlocked-posts') || '{}'); } catch { return {}; }
  });
  const [passFor, setPassFor] = useState<Record<string, string>>({});
  const [passErr, setPassErr] = useState<Record<string, string>>({});

  async function unlockPost(p: PlazaPost) {
    const pwd = (passFor[p.id] || '').trim();
    if (!pwd) return;
    try {
      const r = await social.unlockPost(p.id, pwd);
      setUnlocked((u) => {
        const next = { ...u, [p.id]: true };
        try { localStorage.setItem('cv-unlocked-posts', JSON.stringify(next)); } catch { /* 忽略 */ }
        return next;
      });
      setPosts((prev) => prev.map((x) => (x.id === p.id ? r.post : x)));
      setPassErr((e) => ({ ...e, [p.id]: '' }));
    } catch {
      setPassErr((e) => ({ ...e, [p.id]: '密码不正确' }));
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await social.posts(activeBoard, appliedQuery);
      setPosts(r.posts);
      setBoards(r.boards);
    } catch (err) {
      errorToast(err, '加载广场失败');
    } finally {
      setLoading(false);
    }
  }, [activeBoard, appliedQuery, errorToast]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  function requireLogin(): boolean {
    if (!user) {
      errorToast(new Error('登录后才能参与讨论'));
      navigate('/');
      return false;
    }
    return true;
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

  function commentInsert(postId: string, insert: string, term: string) {
    setCommentDraft((d) => {
      const cur = d[postId] || '';
      const base = term && cur.endsWith(term) ? cur.slice(0, -term.length) : cur;
      return { ...d, [postId]: base + insert };
    });
  }

  function sendComment(p: PlazaPost) {
    const v = (commentDraft[p.id] || '').trim();
    if (!v || !requireLogin()) return;
    setCommentDraft((d) => ({ ...d, [p.id]: '' }));
    setOpenEmojiFor(null);
    act(social.comment(p.id, v), '');
  }

  function boardBadge(id: string) {
    const b = boards.find((x) => x.id === id);
    return b ? `${b.icon} ${b.name}` : '💬 综合讨论';
  }

  return (
    <main className="page plaza-page">
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">广场</h1>
          <div className="page-sub">
            分区讨论 · 图片 / 视频 / 文件 / 表情包 · {posts.length} 条动态
            {appliedQuery ? ` · 搜索「${appliedQuery}」` : ''}
          </div>
        </div>
      </div>

      <div className="board-bar">
        {(boards.length ? boards : [{ id: 'all', name: '全部', icon: '✨', desc: '', count: posts.length }]).map((b) => (
          <button
            key={b.id}
            className={classNames('board-chip', activeBoard === b.id && 'active')}
            onClick={() => setActiveBoard(b.id)}
            title={b.desc}
          >
            <span className="board-icon">{b.icon}</span>
            <span>{b.name}</span>
            <span className="board-count">{b.count}</span>
          </button>
        ))}
      </div>

      <div className="plaza-search">
        <div className="search-wrap">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="搜索帖子正文、作者、评论、附件名或附带漫画…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setAppliedQuery(search.trim()); }}
          />
        </div>
        <button className="btn" onClick={() => setAppliedQuery(search.trim())}>搜索</button>
        {appliedQuery && (
          <button className="btn ghost" onClick={() => { setSearch(''); setAppliedQuery(''); }}>清除</button>
        )}
      </div>

      <PostComposer
        user={user}
        boards={boards}
        activeBoard={activeBoard}
        stickers={stickers}
        reloadStickers={reloadStickers}
        autoSearch={autoSearch}
        onAutoSearchChange={setAutoSearch}
        onPublished={load}
      />

      {loading ? (
        <div className="empty"><Icon name="spinner" size={26} className="spin" /><div style={{ marginTop: 10 }}>加载中…</div></div>
      ) : posts.length === 0 ? (
        <div className="empty">
          <Icon name="message" size={34} />
          <h3>这个分区还很安静</h3>
          <div>发第一条动态，或切换到「全部」看看</div>
        </div>
      ) : (
        <div className="post-list">
          {posts.map((p) => {
            const liked = !!user && p.likes.includes(user.id);
            const draft = commentDraft[p.id] || '';
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
                  <div className="row" style={{ gap: 6 }}>
                    <span className="post-board-badge">{boardBadge(p.board)}</span>
                    {user?.id === p.authorId && (
                      <button className="btn sm ghost danger" onClick={() => act(social.deletePost(p.id), '已删除')} title="删除自己的帖子">
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {p.locked && !unlocked[p.id] && p.authorId !== user?.id ? (
                  <div className="post-locked">
                    <Icon name="lock" size={18} />
                    <div className="post-locked-text">这条帖子设置了密码可见，输入密码后查看</div>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        className="input"
                        style={{ width: 160 }}
                        type="password"
                        placeholder="可见密码"
                        value={passFor[p.id] || ''}
                        onChange={(e) => setPassFor((m) => ({ ...m, [p.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') unlockPost(p); }}
                      />
                      <button className="btn sm primary" onClick={() => unlockPost(p)}>解锁</button>
                    </div>
                    {passErr[p.id] && <div style={{ color: 'var(--warn)', fontSize: 12 }}>{passErr[p.id]}</div>}
                  </div>
                ) : (
                  <>
                    {p.content && <RichText text={p.content} className="post-content" />}
                    <PostAttachments attachments={p.attachments} />

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
                  </>
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
                        <b>{c.byName}</b> <RichText text={c.content} className="comment-rich" inline />
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

                <div className="comment-composer">
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      className="input"
                      placeholder={user ? '写条评论…（可发表情包）' : '登录后评论'}
                      value={draft}
                      onChange={(e) => setCommentDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && draft.trim()) sendComment(p);
                      }}
                    />
                    <button
                      className={classNames('btn sm ghost', openEmojiFor === p.id && 'active')}
                      onClick={() => setOpenEmojiFor(openEmojiFor === p.id ? null : p.id)}
                      title="插入表情包"
                    >😀</button>
                    <button className="btn sm" onClick={() => sendComment(p)}>发送</button>
                  </div>
                  <EmojiSuggestions
                    text={draft}
                    enabled={autoSearch}
                    stickers={stickers}
                    onPick={(insert, term) => commentInsert(p.id, insert, term)}
                    onDisable={() => setAutoSearch(false)}
                  />
                  {openEmojiFor === p.id && (
                    <div className="emoji-panel-wrap">
                      <EmojiPicker
                        user={user}
                        stickers={stickers}
                        reload={reloadStickers}
                        autoSearch={autoSearch}
                        onAutoSearchChange={setAutoSearch}
                        onPick={(insert, term) => commentInsert(p.id, insert, term)}
                        onClose={() => setOpenEmojiFor(null)}
                      />
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
