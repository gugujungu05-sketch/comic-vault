import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, shareExportUrl, type PublicComic } from '../lib/api';
import { ReaderView } from '../components/ReaderView';
import { ExportDialog } from '../components/ExportDialog';
import { Icon } from '../components/Icon';
import { downloadUrl } from '../lib/util';
import { useToast } from '../components/Toasts';

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
          <button className="btn primary" type="submit">
            解锁并阅读
          </button>
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
        <button className="btn" onClick={() => navigate('/')} style={{ marginTop: 10 }}>
          回到书架
        </button>
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

  return (
    <>
      <ReaderView
        title={data.title}
        chapters={data.chapters}
        direction={data.direction}
        readOnly
        onExit={() => navigate('/')}
        headerExtra={
          data.share.allowDownload ? (
            <button className="btn sm ghost" onClick={() => setExporting(true)} title="下载到本地">
              <Icon name="download" size={15} />
            </button>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>仅在线阅读</span>
          )
        }
      />
      {exporting && (
        <ExportDialog
          comicId={data.id}
          comicTitle={data.title}
          chapters={data.chapters}
          shareToken={token || null}
          sharePassword={password || undefined}
          onClose={() => setExporting(false)}
        />
      )}
      <button
        className="btn sm"
        style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 70, opacity: 0.85 }}
        onClick={() => {
          const url = shareExportUrl(token!, 'cbz', undefined, password || undefined);
          downloadUrl(url);
          toast('已开始下载 CBZ');
        }}
      >
        <Icon name="download" size={14} /> 一键下载 CBZ
      </button>
    </>
  );
}
