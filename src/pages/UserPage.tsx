import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { social } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useErrorToast, useToast } from '../components/Toasts';
import { formatDate } from '../lib/util';
import { Avatar } from '../components/Avatar';
import { AvatarCrop } from '../components/AvatarCrop';
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
        <Avatar user={profile} size="lg" />
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
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(user.avatar || undefined);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cropSrc, setCropSrc] = useState('');
  // 上传期间的本地预览地址：先立即显示裁剪结果，不必干等网络
  const localPreview = useRef<string | null>(null);
  const errorToast = useErrorToast();
  const toast = useToast();

  useEffect(() => () => {
    if (localPreview.current) URL.revokeObjectURL(localPreview.current);
  }, []);

  function releasePreview() {
    const old = localPreview.current;
    localPreview.current = null;
    // 延后回收，等 <img> 切到正式地址后再释放，避免瞬间空白
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
  }

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = () => setCropSrc(String(reader.result || ''));
    reader.readAsDataURL(f);
  }

  async function onCropped(blob: Blob) {
    setCropSrc('');
    releasePreview();
    const preview = URL.createObjectURL(blob);
    localPreview.current = preview;
    setAvatarUrl(preview);
    setUploading(true);
    try {
      const r = await social.uploadAvatar(blob, 'avatar.jpg');
      setAvatarUrl(r.url);
      releasePreview();
      toast('头像已上传，记得点「保存」');
    } catch (err) {
      setAvatarUrl(user.avatar || undefined);
      releasePreview();
      errorToast(err, '头像上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (uploading) {
      errorToast(new Error('头像还在上传，请稍候再保存'), '请稍候');
      return;
    }
    setBusy(true);
    try {
      // avatar 始终提交：有值则更新，空串表示移除头像。
      // 旧逻辑只在「有值且不同于原值」时才提交，导致点「移除头像」保存后毫无变化。
      const r = await social.updateMe({
        name, bio,
        avatar: avatarUrl || '',
        ...(password ? { password } : {}),
      });
      onSaved(r.user);
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="编辑资料" icon={<Icon name="user" />} onClose={onClose} width={480}
      footer={<><button className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" onClick={save} disabled={busy || uploading}>{busy ? '保存中…' : uploading ? '头像上传中…' : '保存'}</button></>}>
      <div className="field">
        <label>头像</label>
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <Avatar user={{ name, avatar: avatarUrl || null }} size="lg" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="btn" style={{ cursor: 'pointer' }}>
              {uploading ? '上传中…' : '选择图片'}
              <input type="file" accept="image/*" hidden onChange={onPickAvatar} />
            </label>
            {avatarUrl && (
              <button className="btn sm ghost" onClick={() => { releasePreview(); setAvatarUrl(undefined); }}>移除头像</button>
            )}
          </div>
        </div>
      </div>
      <div className="field"><label>昵称</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label>简介</label><textarea className="input" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="介绍一下自己" /></div>
      <div className="field"><label>修改密码（留空则不改）</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" /></div>
      {cropSrc && (
        <AvatarCrop
          src={cropSrc}
          onClose={() => setCropSrc('')}
          onDone={(b) => onCropped(b)}
        />
      )}
    </Modal>
  );
}
