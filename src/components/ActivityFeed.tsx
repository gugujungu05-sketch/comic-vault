import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { discover } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useErrorToast, useToast } from './Toasts';
import { formatDate } from '../lib/util';
import type { ActivityItem, Announcement } from '../types';

interface FeedData {
  activities: ActivityItem[];
  announcements: Announcement[];
  canAnnounce: boolean;
}

/**
 * 首页动态流：公告置顶 + 公共书库 / 广场最新动态。
 * 公告可点开查看详情并评论；公告账号可发布 / 编辑 / 删除自己的公告。
 */
export function ActivityFeed({ limit = 12 }: { limit?: number }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const { user } = useSession();
  const [data, setData] = useState<FeedData | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  /* 公告详情 / 编辑 / 评论 */
  const [detail, setDetail] = useState<Announcement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [commentText, setCommentText] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await discover.activity(40));
    } catch {
      /* 动态不可用时不影响书架主功能 */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function publish() {
    if (!title.trim() || !content.trim()) {
      errorToast(new Error('请填写公告标题和内容'));
      return;
    }
    setBusy(true);
    try {
      await discover.createAnnouncement({ title: title.trim(), content: content.trim() });
      setTitle('');
      setContent('');
      setShowForm(false);
      toast('公告已发布并置顶');
      await load();
    } catch (err) {
      errorToast(err, '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('确定删除这条公告吗？删除后无法恢复。')) return;
    try {
      await discover.deleteAnnouncement(id);
      toast('公告已删除');
      if (detail?.id === id) setDetail(null);
      await load();
    } catch (err) {
      errorToast(err, '删除失败');
    }
  }

  /** 点开公告查看详情与评论 */
  async function openDetail(id: string) {
    setDetailLoading(true);
    try {
      const r = await discover.announcementDetail(id);
      setDetail(r.announcement);
      return r.announcement;
    } catch (err) {
      errorToast(err, '读取公告失败');
      return null;
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveEdit() {
    if (!detail) return;
    if (!editTitle.trim() || !editContent.trim()) {
      errorToast(new Error('标题和内容不能为空'));
      return;
    }
    try {
      const r = await discover.updateAnnouncement(detail.id, {
        title: editTitle.trim(), content: editContent.trim(),
      });
      setDetail(r.announcement);
      setEditing(false);
      toast('公告已更新', 'ok');
      await load();
    } catch (err) {
      errorToast(err, '保存失败');
    }
  }

  async function sendComment() {
    if (!detail) return;
    if (!user) { toast('请先登录再评论', 'err'); return; }
    const text = commentText.trim();
    if (!text) return;
    setCommentBusy(true);
    try {
      const r = await discover.commentAnnouncement(detail.id, text);
      setDetail((d) => d ? { ...d, comments: [...(d.comments || []), r.comment] } : d);
      setCommentText('');
    } catch (err) {
      errorToast(err, '评论失败');
    } finally {
      setCommentBusy(false);
    }
  }

  async function removeComment(cid: string) {
    if (!detail) return;
    try {
      await discover.deleteAnnouncementComment(detail.id, cid);
      setDetail((d) => d ? { ...d, comments: (d.comments || []).filter((c) => c.id !== cid) } : d);
      toast('评论已删除', 'ok');
    } catch (err) {
      errorToast(err, '删除失败');
    }
  }

  const announcements = data?.announcements || [];
  const activities = (data?.activities || []).slice(0, limit);
  const canManageDetail = !!detail && !!user && user.id === detail.by;

  return (
    <section className="feed-panel panel">
      <div className="feed-head">
        <div className="panel-title"><Icon name="message" size={17} /> 站内动态</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={load} title="刷新动态">
            <Icon name="refresh" size={14} />
          </button>
          {data?.canAnnounce && (
            <button className="btn sm" onClick={() => setShowForm(!showForm)}>
              <Icon name="plus" size={14} /> 发布公告
            </button>
          )}
        </div>
      </div>

      {announcements.length > 0 && (
        <div className="ann-list">
          {announcements.map((n) => (
            <article className="ann-card" key={n.id}>
              <div className="ann-badge"><Icon name="message" size={13} /> 公告</div>
              <div
                className="ann-main"
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={() => openDetail(n.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') openDetail(n.id); }}
                title="点击查看详情与评论"
              >
                <div className="ann-title">{n.title}</div>
                <div className="ann-content">{n.content}</div>
                <div className="ann-by">
                  {n.byName} · {formatDate(n.at)}
                  {(n.comments?.length || 0) > 0 && <> · 💬 {n.comments!.length} 条评论</>}
                </div>
              </div>
              {user?.id === n.by && (
                <div className="row" style={{ gap: 4 }}>
                  <button
                    className="btn sm ghost"
                    title="编辑这条公告"
                    onClick={async () => {
                      const a = await openDetail(n.id);
                      if (a) { setEditTitle(a.title); setEditContent(a.content); setEditing(true); }
                    }}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                  <button className="btn sm ghost danger" title="删除自己发布的公告" onClick={() => remove(n.id)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {showForm && data?.canAnnounce && (
        <div className="ann-form">
          <div className="field">
            <label>公告标题</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：公共书库上线公告" />
          </div>
          <div className="field">
            <label>公告内容</label>
            <textarea className="input" rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="写点什么给大家看…" />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" onClick={publish} disabled={busy}>
              {busy ? '发布中…' : '发布并置顶'}
            </button>
            <button className="btn sm ghost" onClick={() => setShowForm(false)}>取消</button>
          </div>
        </div>
      )}

      {activities.length === 0 ? (
        <div className="muted sm-text feed-empty">还没有动态，去公共书库或广场发第一条吧</div>
      ) : (
        <div className="feed-list">
          {activities.map((a) => (
            <Link className="feed-item" to={a.link} key={a.id}>
              <span className="feed-icon">{a.icon}</span>
              <span className="feed-text">{a.text}</span>
              <span className="feed-meta">{a.userName} · {formatDate(a.at)}</span>
            </Link>
          ))}
        </div>
      )}

      {/* 公告详情：全文 + 编辑（公告账号）+ 评论 */}
      {detail && (
        <Modal
          title={detail.title}
          icon={<Icon name="message" size={16} />}
          onClose={() => { setDetail(null); setEditing(false); }}
          width={640}
        >
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {detail.byName} · 发布于 {formatDate(detail.at)}
            {detail.editedAt ? ` · 编辑于 ${formatDate(detail.editedAt)}` : ''}
          </div>

          {editing && canManageDetail ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="field">
                <label>公告标题</label>
                <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
              </div>
              <div className="field">
                <label>公告内容</label>
                <textarea className="input" rows={5} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" onClick={saveEdit}>保存修改</button>
                <button className="btn sm ghost" onClick={() => setEditing(false)}>取消</button>
              </div>
            </div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 14 }}>{detail.content}</div>
          )}

          <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
              💬 评论（{(detail.comments || []).length}）
            </div>
            {(detail.comments || []).length === 0 ? (
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>还没有评论，来说两句吧</div>
            ) : (
              <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                {(detail.comments || []).map((c) => (
                  <div key={c.id} className="card" style={{ padding: '8px 10px', borderRadius: 10 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                      <b style={{ fontSize: 13 }}>{c.byName}</b>
                      <span className="muted" style={{ fontSize: 11 }}>{formatDate(c.at)}</span>
                      {(user?.id === c.by || canManageDetail) && (
                        <button
                          className="btn sm ghost danger"
                          style={{ marginLeft: 'auto' }}
                          title="删除这条评论"
                          onClick={() => removeComment(c.id)}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{c.text}</div>
                  </div>
                ))}
              </div>
            )}
            {user ? (
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <textarea
                  className="input"
                  rows={2}
                  style={{ flex: 1 }}
                  placeholder="写下你的评论…"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendComment(); }}
                />
                <button className="btn sm primary" onClick={sendComment} disabled={commentBusy}>
                  {commentBusy ? '发送中…' : '评论'}
                </button>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>登录后可以评论公告。</div>
            )}
          </div>
        </Modal>
      )}

      {detailLoading && <div className="muted sm-text">正在载入公告…</div>}
    </section>
  );
}
