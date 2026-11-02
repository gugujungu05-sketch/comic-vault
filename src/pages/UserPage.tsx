import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { social } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useErrorToast, useToast } from '../components/Toasts';
import { formatDate } from '../lib/util';
import type { ComicSummary, PlazaPost, User } from '../types';

export function UserPage() {
  const { id } = useParams();
  const { user: me, setUser } = useSession();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [profile, setProfile] = useState<User | null>(null);
  const [comics, setComics] = useState<ComicSummary[]>([]);
  const [posts, setPosts] = useState<PlazaPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  async function load() {
    if (!id) return;
    try {
      const r = await social.userPage(id);
      setProfile(r.user);
      setComics(r.comics);
      setPosts(r.posts);
    } catch (err) {
      errorToast(err, '加载用户主页失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  if (loading) return <main className="page"><div className="empty"><Icon name="spinner" size={26} className="spin" /></div></main>;
  if (!profile) return <main className="page"><div className="empty"><h3>用户不存在</h3></div></main>;

  const isMe = me?.id === profile.id;

  return (
    <main className="page">
      <div className="profile-head">
        <span className="avatar lg">{profile.name.slice(0, 1).toUpperCase()}</span>
        <div className="profile-info">
          <h1>{profile.name}</h1>
          <div className="page-sub">{profile.bio || '这个人还没写简介'}</div>
          <div className="profile-stats">
            <span><Icon name="book" size={14} /> {comics.length} 本公开漫画</span>
            <span><Icon name="message" size={14} /> {posts.length} 条动态</span>
            <span>加入于 {formatDate(profile.createdAt)}</span>
          </div>
        </div>
        {isMe && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}><Icon name="edit" size={15} /> 编辑资料</button>}
      </div>

      <h2 className="section-title">公开的漫画</h2>
      {comics.length === 0 ? (
        <div className="empty"><Icon name="book" size={30} /><div>还没有公开漫画</div></div>
      ) : (
        <div className="comic-grid">
          {comics.map((c) => (
            <Link to={`/comic/${c.id}`} className="comic-card" key={c.id}>
              <div className="comic-cover">
                {c.coverUrl ? <img src={c.coverUrl} alt={c.title} loading="lazy" /> : <div className="cover-empty"><Icon name="book" size={30} /></div>}
              </div>
              <div className="comic-body">
                <div className="comic-title">{c.title}</div>
                <div className="comic-meta">{c.chapterCount} 话 · {c.pageCount} 页</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <h2 className="section-title" style={{ marginTop: 30 }}>广场动态</h2>
      {posts.length === 0 ? (
        <div className="empty"><Icon name="message" size={30} /><div>还没有发过动态</div></div>
      ) : (
        <div className="post-list">
          {posts.map((p) => (
            <div className="post-card" key={p.id}>
              <div className="post-time">{formatDate(p.createdAt)}</div>
              <div className="post-content">{p.content || '（分享了一本漫画）'}</div>
              {p.comic && <Link to={`/comic/${p.comic.id}`} className="post-share-link">{p.comic.title}</Link>}
              <Link to="/plaza" className="post-share-link">在广场查看 →</Link>
            </div>
          ))}
        </div>
      )}

      {editing && isMe && (
        <EditProfile
          user={profile}
          onClose={() => setEditing(false)}
          onSaved={(u) => { setProfile(u); setUser(u); setEditing(false); toast('资料已更新'); }}
        />
      )}
    </main>
  );
}

function EditProfile({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: (u: User) => void }) {
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const errorToast = useErrorToast();

  async function save() {
    setBusy(true);
    try {
      const r = await social.updateMe({ name, bio, ...(password ? { password } : {}) });
      onSaved(r.user);
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="编辑资料" icon={<Icon name="user" />} onClose={onClose} width={480}
      footer={<><button className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" onClick={save} disabled={busy}>保存</button></>}>
      <div className="field"><label>昵称</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label>简介</label><textarea className="input" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="介绍一下自己" /></div>
      <div className="field"><label>修改密码（留空则不改）</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" /></div>
    </Modal>
  );
}
