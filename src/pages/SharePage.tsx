import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, shareExportUrl, type PublicComic } from '../lib/api';
import { ReaderView } from '../components/ReaderView';
import { ExportDialog } from '../components/ExportDialog';
import { Icon } from '../components/Icon';
import { downloadUrl } from '../lib/util';
import { useToast } from '../components/Toasts';

/** 分享链接落地页：先把「这是什么、有几话、能不能下载」讲清楚，再进入阅读器 */
export function SharePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<PublicComic | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [startChapterId, setStartChapterId] = useState<string | undefined>();

  async function load(pwd?: string) {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.getShared(token, pwd);
      setData(res);
      setPassword(pwd || '');
      setNeedPassword(false);
    } catch (err) {
      const message = (err as Error).message || '';
      if (message.includes('密码') || message.includes('401')) {
        setNeedPassword(true);
      } else {
        setError(message || '分享不存在或已失效');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [token]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    try {
      await api.unlockShare(token, passwordInput);
      await load(passwordInput);
    } catch (err) {
      setError((err as Error).message || '密码不正确');
    }
  }

  function downloadCbz() {
    const url = shareExportUrl(token!, 'cbz', undefined, password || undefined);
    downloadUrl(url);
    toast('已开始下载 CBZ');
  }

  function openChapter(chapterId?: string) {
    setStartChapterId(chapterId);
    setReading(true);
  }

  if (loading) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        <Icon name="spinner" size={28} className="spin" />
        <div style={{ marginTop: 12, color: 'var(--muted)' }}>正在打开分享…</div>
      </div>
    );
  }

  if (needPassword) {
    return (
      <div className="empty" style={{ paddingTop: 100 }}>
        <Icon name="lock" size={30} />
        <h3>该分享需要访问密码</h3>
        <form onSubmit={unlock} style={{ maxWidth: 320, margin: '16px auto 0', display: 'grid', gap: 10 }}>
          <input
            className="input"
            type="password"
            placeholder="请输入访问密码"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            autoFocus
          />
          <button className="btn primary" type="submit">解锁并阅读</button>
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
        </form>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="empty" style={{ paddingTop: 100 }}>
        <Icon name="close" size={30} />
        <h3>{error || '分享不存在'}</h3>
        <button className="btn" onClick={() => navigate('/')} style={{ marginTop: 10 }}>回到书架</button>
      </div>
    );
  }

  const expired = data.share.expiresAt ? data.share.expiresAt < Date.now() : false;
  if (expired) {
    return (
      <div className="empty" style={{ paddingTop: 100 }}>
        <Icon name="lock" size={30} />
        <h3>分享链接已过期</h3>
      </div>
    );
  }

  const chapters = data.chapters || [];
  const totalPages = chapters.reduce((n, c) => n + (c.pages?.length || 0), 0);
  const canDownload = !!data.share.allowDownload;

  const exportDialog = exporting ? (
    <ExportDialog
      comicId={data.id}
      comicTitle={data.title}
      chapters={chapters}
      shareToken={token || null}
      sharePassword={password || undefined}
      onClose={() => setExporting(false)}
    />
  ) : null;

  /* 阅读视图：顶栏保留「返回封面」，去掉遮住画面的浮动下载按钮 */
  if (reading) {
    return (
      <>
        <ReaderView
          title={data.title}
          chapters={chapters}
          direction={data.direction}
          initialChapterId={startChapterId}
          readOnly
          onExit={() => setReading(false)}
          headerExtra={
            <>
              <button className="btn sm ghost" onClick={() => setReading(false)} title="返回封面">
                <Icon name="book" size={15} /> 封面
              </button>
              {canDownload ? (
                <button className="btn sm ghost" onClick={() => setExporting(true)} title="下载到本地">
                  <Icon name="download" size={15} />
                </button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>仅在线阅读</span>
              )}
            </>
          }
        />
        {exportDialog}
      </>
    );
  }

  /* 落地页：封面 + 明确信息 + 大按钮 + 目录 */
  return (
    <div className="share-landing">
      <header className="share-topbar">
        <span className="share-logo"><Icon name="book" size={17} /> 漫画库 ComicVault</span>
        <span className="share-topbar-note">好友分享 · 无需登录</span>
      </header>

      <section className="share-hero">
        <div className="share-cover">
          {data.coverUrl ? <img src={data.coverUrl} alt={data.title} /> : <Icon name="book" size={54} />}
        </div>
        <div className="share-meta">
          <div className="share-badge">分享的漫画</div>
          <h1>{data.title}</h1>
          {(data.author || data.artist) && (
            <div className="share-author">
              {data.author ? `作者 ${data.author}` : ''}
              {data.author && data.artist ? ' · ' : ''}
              {data.artist ? `作画 ${data.artist}` : ''}
            </div>
          )}
          {data.description && <p className="share-desc">{data.description}</p>}
          {!!data.tags?.length && (
            <div className="share-tags">
              {data.tags.slice(0, 12).map((t, i) => <span className="chip" key={i}>{t}</span>)}
            </div>
          )}
          <div className="share-stats">
            <span><b>{chapters.length}</b> 话</span>
            <span><b>{totalPages}</b> 页</span>
            <span>{data.direction === 'rtl' ? '从右往左' : '从左往右'}</span>
          </div>
          <div className="share-perms">
            <span className={canDownload ? 'ok' : 'off'}>
              <Icon name={canDownload ? 'check' : 'lock'} size={13} />
              {canDownload ? '允许下载' : '仅在线阅读'}
            </span>
            <span>{data.share.expiresAt
              ? `有效期至 ${new Date(data.share.expiresAt).toLocaleDateString('zh-CN')}`
              : '长期有效'}</span>
          </div>
          <div className="share-actions">
            <button className="btn primary lg" onClick={() => openChapter()}>
              <Icon name="play" size={17} /> 开始阅读
            </button>
            {canDownload && (
              <>
                <button className="btn lg" onClick={downloadCbz}>
                  <Icon name="download" size={16} /> 下载 CBZ
                </button>
                <button className="btn" onClick={() => setExporting(true)}>更多格式…</button>
              </>
            )}
          </div>
          {!canDownload && (
            <div className="share-hint">分享者没有开放下载权限，你可以直接在线阅读全部话数。</div>
          )}
        </div>
      </section>

      <section className="share-chapters">
        <h2>目录 <span className="muted">共 {chapters.length} 话 · {totalPages} 页</span></h2>
        {chapters.length ? (
          <div className="share-chapter-list">
            {chapters.map((ch, i) => (
              <button className="share-chapter" key={ch.id} onClick={() => openChapter(ch.id)}>
                <span className="share-chapter-n">{i + 1}</span>
                <span className="share-chapter-title">{ch.title}</span>
                <span className="muted">{ch.pages?.length || 0} 页</span>
                <Icon name="right" size={15} />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">这本漫画还没有可阅读的话</div>
        )}
      </section>

      <footer className="share-foot">
        由 漫画库 ComicVault 分享 · 链接仅用于阅读，请勿二次分发受版权保护的内容
      </footer>
      {exportDialog}
    </div>
  );
}
