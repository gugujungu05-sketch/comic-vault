import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, discover, social } from '../lib/api';
import { useSession } from '../lib/session';
import type { Announcement, Stats, UpdateInfo } from '../types';
import { Icon } from '../components/Icon';
import { formatBytes, withShareCode, copyText } from '../lib/util';
import { useErrorToast, useToast } from '../components/Toasts';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type DesktopBridge = { version?: string };

export function SettingsPage() {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [runtime, setRuntime] = useState<{ version: string } | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const bridge = (window as unknown as { desktop?: DesktopBridge }).desktop;
  const { user, setUser, codeLogin } = useSession();
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyDevCode, setVerifyDevCode] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [canAnnounce, setCanAnnounce] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [annBusy, setAnnBusy] = useState(false);
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('cv-theme') as 'dark' | 'light') || 'dark',
  );

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.list().then((r) => setDirection(r.settings.defaultDirection || 'ltr')).catch(() => {});
    api.runtime().then(setRuntime).catch(() => {});
    discover.announcements().then((r) => {
      setAnnouncements(r.announcements);
      setCanAnnounce(r.canAnnounce);
    }).catch(() => {});

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    } catch {
      /* 忽略 */
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) {
      toast('请使用浏览器菜单中的「安装应用 / 添加到主屏幕」');
      return;
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      toast(choice.outcome === 'accepted' ? '正在安装…' : '已取消安装');
      setInstallPrompt(null);
    } catch (err) {
      errorToast(err);
    }
  }

  async function copySiteUrl() {
    const ok = await copyText(withShareCode(`${window.location.origin}/`));
    toast(ok ? '网址已复制，可粘贴到浏览器或发给朋友' : '复制失败，请手动复制地址栏网址');
  }

  function openInBrowser() {
    window.open(withShareCode(`${window.location.origin}/`), '_blank', 'noopener');
  }

  async function saveDirection(next: 'ltr' | 'rtl') {
    setDirection(next);
    try {
      await api.saveSettings({ defaultDirection: next });
      toast('已保存');
    } catch (err) {
      errorToast(err);
    }
  }

  function changeTheme(next: 'dark' | 'light') {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cv-theme', next);
  }

  async function sendVerifyCode() {
    setVerifyBusy(true);
    try {
      const r = await social.sendVerifyCode();
      setVerifyDevCode(r.devCode);
      toast(r.sent ? '验证码已发送到邮箱' : (r.devCode ? '已生成开发模式验证码' : r.hint));
    } catch (err) {
      errorToast(err, '发送失败');
    } finally {
      setVerifyBusy(false);
    }
  }

  async function confirmVerify() {
    if (!verifyCode.trim()) {
      errorToast(new Error('请填写验证码'));
      return;
    }
    setVerifyBusy(true);
    try {
      const r = await social.verifyEmail(verifyCode.trim());
      setUser(r.user);
      setVerifyCode('');
      setVerifyDevCode(null);
      toast('邮箱验证成功，之后可用它找回密码');
    } catch (err) {
      errorToast(err, '验证失败');
    } finally {
      setVerifyBusy(false);
    }
  }


  async function checkUpdate() {
    setChecking(true);
    try {
      const r = await discover.checkUpdate(
        bridge ? 'desktop' : 'web',
        bridge ? (bridge.version || '1.0.0') : '',
      );
      setUpdate(r);
      toast(r.hasUpdate ? `发现新版本 ${r.latest}` : '已是最新版本');
    } catch (err) {
      errorToast(err, '检查更新失败');
    } finally {
      setChecking(false);
    }
  }

  async function loadAnnouncements() {
    try {
      const r = await discover.announcements();
      setAnnouncements(r.announcements);
      setCanAnnounce(r.canAnnounce);
    } catch {
      /* 公告不可用不影响设置页 */
    }
  }

  async function publishAnnouncement() {
    if (!annTitle.trim() || !annContent.trim()) {
      errorToast(new Error('请填写公告标题和内容'));
      return;
    }
    setAnnBusy(true);
    try {
      await discover.createAnnouncement({ title: annTitle.trim(), content: annContent.trim() });
      setAnnTitle('');
      setAnnContent('');
      toast('公告已发布并置顶');
      await loadAnnouncements();
    } catch (err) {
      errorToast(err, '发布失败');
    } finally {
      setAnnBusy(false);
    }
  }

  async function removeAnnouncement(id: string) {
    try {
      await discover.deleteAnnouncement(id);
      toast('公告已删除');
      await loadAnnouncements();
    } catch (err) {
      errorToast(err, '删除失败');
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">阅读偏好、存储状况与导入方式</div>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="v">{stats?.comicCount ?? 0}</div>
          <div className="k">部作品</div>
        </div>
        <div className="stat-card">
          <div className="v">{stats?.pageCount ?? 0}</div>
          <div className="k">页图片</div>
        </div>
        <div className="stat-card">
          <div className="v">{formatBytes(stats?.storageBytes || 0)}</div>
          <div className="k">占用空间</div>
        </div>
        <div className="stat-card">
          <div className="v">{stats?.hasSharp ? '已启用' : '未启用'}</div>
          <div className="k">图像处理引擎</div>
        </div>
      </div>

      <div className="chapter-list">
        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 10 }}>
          <div>
            <div className="chapter-title">邮箱验证与找回密码</div>
            <div className="chapter-sub">
              注册时不强制验证邮箱，可以先正常使用；验证后，忘记密码时可用这个邮箱收验证码重置密码。
              {user ? ` 当前账号：${user.email}` : ' 登录后才能验证邮箱。'}
            </div>
          </div>
          {!user ? (
            <div className="chapter-sub">请先登录，再回来验证邮箱。</div>
          ) : user.emailVerified ? (
            <div className="app-panel">
              <div className="app-panel-row">
                <span className="app-panel-label">验证状态</span>
                <span className="badge">已验证</span>
                <span className="app-panel-value">可用于找回密码</span>
              </div>
            </div>
          ) : (
            <>
              <div className="app-panel">
                <div className="app-panel-row">
                  <span className="app-panel-label">验证状态</span>
                  <span className="badge">未验证</span>
                  <span className="app-panel-value">暂不能用于找回密码</span>
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={sendVerifyCode} disabled={verifyBusy}>获取验证码</button>
                <input
                  className="input" style={{ maxWidth: 180 }}
                  value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder="6 位验证码"
                />
                <button className="btn primary" onClick={confirmVerify} disabled={verifyBusy}>确认验证</button>
              </div>
              {verifyDevCode && (
                <div className="auth-hint dev">
                  开发模式验证码：<b>{verifyDevCode}</b>
                  <button type="button" className="btn sm ghost" onClick={() => setVerifyCode(verifyDevCode)} style={{ marginLeft: 8 }}>
                    填入
                  </button>
                </div>
              )}
              {codeLogin.devMode && !verifyDevCode && (
                <div className="chapter-sub">
                  当前未配置邮件服务，验证码会直接显示在本页；配置 SMTP / Resend 后会自动改为发到邮箱。
                </div>
              )}
            </>
          )}
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 10 }}>
          <div>
            <div className="chapter-title">外观主题</div>
            <div className="chapter-sub">深色适合夜间阅读，浅色适合白天</div>
          </div>
          <div className="row">
            <button className={`chip ${theme === 'dark' ? 'active' : ''}`} onClick={() => changeTheme('dark')}>
              深色
            </button>
            <button className={`chip ${theme === 'light' ? 'active' : ''}`} onClick={() => changeTheme('light')}>
              浅色
            </button>
          </div>
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 10 }}>
          <div>
            <div className="chapter-title">新建漫画的默认阅读方向</div>
            <div className="chapter-sub">日漫一般是从右往左（RTL），国漫/美漫一般从左往右（LTR）</div>
          </div>
          <div className="row">
            <button className={`chip ${direction === 'ltr' ? 'active' : ''}`} onClick={() => saveDirection('ltr')}>
              从左往右 LTR
            </button>
            <button className={`chip ${direction === 'rtl' ? 'active' : ''}`} onClick={() => saveDirection('rtl')}>
              从右往左 RTL
            </button>
          </div>
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="chapter-title">
              <Icon name="upload" size={15} /> 支持的导入格式
            </div>
            <div className="chapter-sub">
              图片：JPG / PNG / WebP / GIF / BMP / AVIF · 压缩包：ZIP / CBZ（自动读取 ComicInfo.xml）·
              文档：PDF（按页渲染为图片）· 文件夹：拖拽整个目录，按子目录自动分话 ·
              服务器本地目录：无需上传，直接读取磁盘
            </div>
          </div>
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="chapter-title">
              <Icon name="download" size={15} /> 支持的导出格式
            </div>
            <div className="chapter-sub">
              CBZ（含 ComicInfo.xml 元数据，主流漫画阅读器通用）· ZIP（按话分目录）· PDF（原图比例排版）·
              EPUB（固定版式，支持 Apple Books / Calibre）
            </div>
          </div>
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="chapter-title">
              <Icon name="folder" size={15} /> 数据存储位置
            </div>
            <div className="chapter-sub">
              漫画元数据保存在 <code>data/db.json</code>，图片原文件保存在 <code>data/store</code>
              。可直接复制整个 data 目录做备份或迁移；也可以用环境变量 <code>CV_DATA_DIR</code> 指定其它位置。
            </div>
          </div>
        </div>

        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="chapter-title">
              <Icon name="download" size={15} /> 桌面软件与数据互通
            </div>
            <div className="chapter-sub">
              桌面软件、网页和手机安装的应用连接的是<strong>同一台服务器、同一个账号</strong>。
              在软件里新建漫画、改名、换封面或删除，网页与手机刷新后立刻同步；网站里分享的私密漫画链接，在软件里也能直接打开。
              数据始终保存在服务器，不依赖本地同步。
            </div>
          </div>
          <div className="app-panel">
            <div className="app-panel-row">
              <span className="app-panel-label">当前数据源</span>
              <code className="app-panel-value">{window.location.origin}</code>
              <span className="badge">{runtime ? `服务端 v${runtime.version}` : '连接中…'}</span>
            </div>
            <div className="app-panel-row">
              <span className="app-panel-label">运行形态</span>
              <span className="app-panel-value">
                {bridge ? `桌面软件 v${bridge.version || '1.0'}` : installed ? '已安装的应用' : '浏览器网页'}
              </span>
            </div>
          </div>
          <div className="row">
            {!installed && (
              <button className="btn primary" onClick={installApp}>
                <Icon name="download" size={15} /> 安装到本机
              </button>
            )}
            <button className="btn" onClick={copySiteUrl}>复制网址</button>
            <button className="btn ghost" onClick={openInBrowser}>在浏览器中打开</button>
            <Link className="btn" to="/downloads"><Icon name="download" size={15} /> 软件下载</Link>
            <button className="btn" onClick={checkUpdate} disabled={checking}>
              <Icon name="refresh" size={15} /> {checking ? '检查中…' : '检查更新'}
            </button>
          </div>
          {update && (
            <div className={`dl-update ${update.hasUpdate ? 'has' : ''}`}>
              <div className="dl-update-head">
                {update.hasUpdate ? `发现新版本 ${update.latest}` : `已是最新版本 ${update.latest}`}
              </div>
              <div className="muted sm-text">{update.hint}</div>
            </div>
          )}
          <div className="chapter-sub">
            电脑上想用独立窗口：运行项目 <code>desktop/</code> 里的「启动软件.bat」（Windows）或「启动软件.command」（macOS / Linux），
            也可打包成 exe / dmg 安装包。软件菜单里可随时切换服务器地址，指向线上或本机服务。
          </div>
        </div>

        {canAnnounce && (
          <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 10 }}>
            <div>
              <div className="chapter-title"><Icon name="message" size={15} /> 站点公告管理</div>
              <div className="chapter-sub">
                这个权限只单独授予你的账号；发布的公告会置顶显示在首页动态流，其它账号只能查看。
              </div>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input" style={{ maxWidth: 240 }} value={annTitle} onChange={(e) => setAnnTitle(e.target.value)} placeholder="公告标题" />
              <button className="btn primary" onClick={publishAnnouncement} disabled={annBusy}>
                {annBusy ? '发布中…' : '发布公告'}
              </button>
            </div>
            <textarea className="input" rows={3} value={annContent} onChange={(e) => setAnnContent(e.target.value)} placeholder="公告内容…" />
            <div className="ann-manage-list">
              {announcements.length === 0 && <div className="muted sm-text">还没有发布过公告</div>}
              {announcements.map((n) => (
                <div className="ann-manage-item" key={n.id}>
                  <div>
                    <b>{n.title}</b>
                    <div className="muted sm-text">{n.content}</div>
                  </div>
                  {user?.id === n.by && (
                    <button className="btn sm ghost danger" onClick={() => removeAnnouncement(n.id)}>
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
