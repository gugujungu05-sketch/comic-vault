import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { discover } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from './Icon';
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
 * 公告发布入口只对「站点公告账号」可见，且服务端再次鉴权。
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
    try {
      await discover.deleteAnnouncement(id);
      toast('公告已删除');
      await load();
    } catch (err) {
      errorToast(err, '删除失败');
    }
  }

  const announcements = data?.announcements || [];
  const activities = (data?.activities || []).slice(0, limit);

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
              <div className="ann-main">
                <div className="ann-title">{n.title}</div>
                <div className="ann-content">{n.content}</div>
                <div className="ann-by">{n.byName} · {formatDate(n.at)}</div>
              </div>
              {user?.id === n.by && (
                <button className="btn sm ghost danger" title="删除自己发布的公告" onClick={() => remove(n.id)}>
                  <Icon name="trash" size={13} />
                </button>
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
    </section>
  );
}
