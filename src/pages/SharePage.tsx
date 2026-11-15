import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, shareExportUrl, type PublicComic } from '../lib/api';
import { ReaderView } from '../components/ReaderView';
import { ExportDialog } from '../components/ExportDialog';
import { Icon } from '../components/Icon';
import { downloadUrl } from '../lib/util';
import { useToast } from '../components/Toasts';

/** 同一访客用同一个匿名标识：重开链接能续读，访问记录也按这个人合并成一条 */
function visitorIdFor(token: string): string {
  const key = `cv-share-vid-${token.slice(0, 12)}`;
  try {
    let v = localStorage.getItem(key);
    if (!v) {
      v = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    return `v_${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** 分享链接落地页：先把「这是什么、有几话、能不能下载」讲清楚，再进入阅读器 */
export function SharePage() {
  const { token: routeToken } = useParams();
  const location = useLocation();
  /** 兼容两种入口：/s/:token（深链）与 /comic-vault/?s=token（200 直达，二维码/扫码用） */
  const token = routeToken || new URLSearchParams(location.search).get('s') || '';
  const visitorId = useRef(visitorIdFor(token)).current;
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<PublicComic | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportMode, setExportMode] = useState<'all' | 'single' | 'multi'>('all');
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [startChapterId, setStartChapterId] = useState<string | undefined>();
  const [startPageIndex, setStartPageIndex] = useState(0);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const lastReport = useRef(0);
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReport = useRef<{ chapterId: string; pageIndex: number } | null>(null);
  const resume = data?.share?.resume || null;

  async function load(pwd?: string) {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.getShared(token, pwd, visitorId);
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

  /** 阅读位置节流上报：同一访客的进度存服务端，重开链接可续读。
   *  带尾随上报，保证「最后一页」不会被节流吞掉。 */
  const reportProgress = useCallback(
    (chapterId: string, pageIndex: number) => {
      pendingReport.current = { chapterId, pageIndex };
      const send = (p: { chapterId: string; pageIndex: number }) => {
        lastReport.current = Date.now();
        api.reportShareProgress(token, { visitorId, ...p }, password || undefined).catch(() => {});
      };
      const gap = Date.now() - lastReport.current;
      if (gap < 2000) {
        if (!reportTimer.current) {
          reportTimer.current = setTimeout(() => {
            reportTimer.current = null;
            if (pendingReport.current) send(pendingReport.current);
          }, 2000 - gap + 30);
        }
        return;
      }
      if (reportTimer.current) { clearTimeout(reportTimer.current); reportTimer.current = null; }
      send({ chapterId, pageIndex });
    },
    [token, visitorId, password],
  );

  function downloadChapters(ids: string[], fmt = 'cbz') {
    const url = shareExportUrl(token, fmt, ids.length ? ids : undefined, password || undefined);
    downloadUrl(url);
    toast(ids.length === 1 ? '已开始下载本话' : ids.length ? `已开始下载 ${ids.length} 话` : '已开始下载整本');
  }

  function openExport(mode: 'all' | 'single' | 'multi', selected: string[] = []) {
    setExportMode(mode);
    setExportSelected(selected);
    setExporting(true);
  }

  /** fromStart=true 从该话第 1 页开始；继续阅读时沿用上次的页码 */
  function openChapter(chapterId?: string, fromStart = true) {
    setStartChapterId(chapterId);
    setStartPageIndex(fromStart ? 0 : (resume?.pageIndex ?? 0));
    setReading(true);
  }

  function togglePick(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
      initialMode={exportMode}
      initialSelected={exportSelected}
      onClose={() => setExporting(false)}
    />
  ) : null;

  /* 阅读视图：顶栏只留返回 / 封面 / 下载 / 保存本页，其余收进设置面板，尽量不挡画面 */
  if (reading) {
    return (
      <>
        <ReaderView
          title={data.title}
          chapters={chapters}
          direction={data.direction}
          initialChapterId={startChapterId}
          initialPageIndex={startPageIndex}
          readOnly
          onProgress={reportProgress}
          onExit={() => setReading(false)}
          headerExtra={
            <>
              <button className="btn sm ghost" onClick={() => setReading(false)} title="返回封面">
                <Icon name="book" size={15} /> 封面
              </button>
              {canDownload && (
                <button className="btn sm ghost" onClick={() => openExport('all')} title="下载到本地">
                  <Icon name="download" size={15} /> 下载
                </button>
              )}
            </>
          }
        />
        {exportDialog}
      </>
    );
  }

  /* 落地页：封面 + 明确信息 + 大按钮 + 目录（支持单话 / 多话 / 整本下载） */
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
            {resume ? (
              <>
                <button className="btn primary lg" onClick={() => openChapter(resume.chapterId, false)}>
                  <Icon name="play" size={17} /> 继续阅读
                  <span className="share-resume-tag">
                    第 {resume.chapterIndex + 1} 话 · 第 {resume.pageIndex + 1} 页
                  </span>
                </button>
                <button className="btn lg" onClick={() => openChapter(undefined, true)}>从头阅读</button>
              </>
            ) : (
              <button className="btn primary lg" onClick={() => openChapter()}>
                <Icon name="play" size={17} /> 开始阅读
              </button>
            )}
            {canDownload && (
              <>
                <button className="btn lg" onClick={() => downloadChapters([])}>
                  <Icon name="download" size={16} /> 下载整本
                </button>
                <button className="btn" onClick={() => openExport('all')}>单话 / 多话 / 多格式…</button>
              </>
            )}
          </div>
          {resume && (
            <div className="share-hint">
              上次读到 <b>第 {resume.chapterIndex + 1} 话 · 第 {resume.pageIndex + 1} 页</b>
              （{new Date(resume.ts).toLocaleString('zh-CN')}），同一设备再打开会从这里继续。
            </div>
          )}
          {!canDownload && (
            <div className="share-hint">分享者没有开放下载权限，你可以直接在线阅读全部话数。</div>
          )}
        </div>
      </section>

      <section className="share-chapters">
        <div className="share-chapters-head">
          <h2>目录 <span className="muted">共 {chapters.length} 话 · {totalPages} 页</span></h2>
          {canDownload && chapters.length > 1 && (
            <button className="btn sm ghost" onClick={() => { setPickMode(!pickMode); setPicked([]); }}>
              {pickMode ? '取消多选' : '☑ 多选下载'}
            </button>
          )}
        </div>
        {pickMode && canDownload && (
          <div className="share-pick-bar">
            <button className="btn sm" onClick={() => setPicked(chapters.map((c) => c.id))}>全选</button>
            <button className="btn sm ghost" onClick={() => setPicked([])}>清空</button>
            <span className="grow" />
            <button className="btn sm primary" disabled={!picked.length}
              onClick={() => downloadChapters(picked)}>
              ⇩ 下载所选 {picked.length} 话
            </button>
            <button className="btn sm ghost" disabled={!picked.length}
              onClick={() => openExport('multi', picked)}>更多格式…</button>
          </div>
        )}
        {chapters.length ? (
          <div className="share-chapter-list">
            {chapters.map((ch, i) => (
              <div className="share-chapter-row" key={ch.id}>
                {pickMode && canDownload && (
                  <input
                    type="checkbox"
                    checked={picked.includes(ch.id)}
                    onChange={() => togglePick(ch.id)}
                    aria-label={`选择 ${ch.title}`}
                  />
                )}
                <button className="share-chapter" onClick={() => openChapter(ch.id, true)}>
                  <span className="share-chapter-n">{i + 1}</span>
                  <span className="share-chapter-title">{ch.title}</span>
                  <span className="muted">{ch.pages?.length || 0} 页</span>
                  <Icon name="right" size={15} />
                </button>
                {canDownload && !pickMode && (
                  <button
                    className="btn sm ghost share-chapter-dl"
                    onClick={() => downloadChapters([ch.id])}
                    title="只下载这一话（单话）"
                  >
                    <Icon name="download" size={14} /> 本话
                  </button>
                )}
              </div>
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
