import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ToastProvider } from './components/Toasts';
import { Icon } from './components/Icon';
import { LibraryPage } from './pages/LibraryPage';
import { ComicPage } from './pages/ComicPage';
import { ReaderPage } from './pages/ReaderPage';
import { SharePage } from './pages/SharePage';
import { SettingsPage } from './pages/SettingsPage';
import { AuthPage } from './pages/AuthPage';
import { CommunityPage } from './pages/CommunityPage';
import { PlazaPage } from './pages/PlazaPage';
import { UserPage } from './pages/UserPage';
import { DownloadsPage } from './pages/DownloadsPage';
import SourcesPage from './pages/SourcesPage';
import { SessionProvider, useSession } from './lib/session';
import { social, detectApiBase, getApiBase } from './lib/api';
import { rememberShareCode, withShareCode } from './lib/util';
import { Avatar } from './components/Avatar';

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('cv-theme') as 'dark' | 'light') || 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cv-theme', theme);
  }, [theme]);
  return { theme, setTheme };
}

function Header({ theme, onToggleTheme }: { theme: string; onToggleTheme: () => void }) {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  async function logout() {
    try {
      await social.logout();
    } catch {
      /* 忽略 */
    }
    setUser(null);
    setOpen(false);
    navigate('/');
  }

  return (
    <header className="header">
      <NavLink to="/" className="brand">
        <span className="brand-mark">
          <Icon name="book" size={17} />
        </span>
        ComicVault
      </NavLink>
      <nav className="nav">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          书架
        </NavLink>
        <NavLink to="/community" className={({ isActive }) => (isActive ? 'active' : '')}>
          公共书库
        </NavLink>
        <NavLink to="/plaza" className={({ isActive }) => (isActive ? 'active' : '')}>
          广场
        </NavLink>
        {user && (
          <NavLink to="/sources" className={({ isActive }) => (isActive ? 'active' : '')}>
            在线来源
          </NavLink>
        )}
        {user && (
          <NavLink to={`/u/${user.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
            我的主页
          </NavLink>
        )}
        <NavLink to="/downloads" className={({ isActive }) => (isActive ? 'active' : '')}>
          软件下载
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
          设置
        </NavLink>
      </nav>
      <div className="header-right">
        <button className="btn icon ghost" onClick={onToggleTheme} title="切换主题" aria-label="切换主题">
          <Icon name={theme === 'dark' ? 'eye' : 'settings'} />
        </button>
        {user ? (
          <div className="user-menu">
            <button className="user-trigger" onClick={() => setOpen(!open)}>
              <Avatar user={user} size="sm" />
              <span className="user-name">{user.name}</span>
            </button>
            {open && (
              <div className="user-dropdown">
                <div className="dropdown-email">{user.email}</div>
                <button onClick={() => { setOpen(false); navigate(`/u/${user.id}`); }}>
                  <Icon name="user" size={15} /> 我的主页
                </button>
                <button onClick={logout}>
                  <Icon name="logout" size={15} /> 退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="btn sm primary" onClick={() => navigate('/?login=1')}>
            登录 / 注册
          </button>
        )}
      </div>
    </header>
  );
}

/** 手机端底部主导航：桌面端仍用顶部 .nav，移动端隐藏横向菜单改用底栏 */
function MobileTabs() {
  const tabs = [
    { to: '/', label: '书架', icon: 'book' },
    { to: '/community', label: '书库', icon: 'globe' },
    { to: '/plaza', label: '广场', icon: 'message' },
    { to: '/downloads', label: '软件', icon: 'download' },
    { to: '/settings', label: '设置', icon: 'settings' },
  ] as const;
  return (
    <nav className="mobile-tabs" aria-label="主导航">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/' ? true : undefined}
          className={({ isActive }) => (isActive ? 'active' : '')}
        >
          <Icon name={t.icon} size={20} />
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * 读取站点 backend.json 的候选地址并并行竞速探测，返回是否找到可用后端。
 * 抽成模块级函数供「首屏探测 / 离线重连 / 请求失败即时重连」三处复用。
 */
async function probeBackend(): Promise<boolean> {
  const cfg = await fetch(`${import.meta.env.BASE_URL}backend.json`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const remote: string[] = Array.isArray(cfg?.candidates) ? cfg.candidates : [];
  const found = await detectApiBase([
    typeof localStorage !== 'undefined' ? localStorage.getItem('cv-api-base') || '' : '',
    ...remote,
    'http://127.0.0.1:8787',
  ]);
  return !!found;
}

function Shell() {
  const { theme, setTheme } = useTheme();
  const { user, loading, needsSetup, refresh } = useSession();
  const location = useLocation();
  const immersive = location.pathname.startsWith('/read/') || location.pathname.startsWith('/s/');
  const [offline, setOffline] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const probingRef = useRef(false);

  /* GitHub Pages 深链兜底：404.html 把 /comic-vault/s/xxx 转成 ?cvroute=s/xxx，这里还原 */
  useEffect(() => {
    try {
      const r = new URLSearchParams(window.location.search).get('cvroute');
      if (!r) return;
      const target = decodeURIComponent(r) + window.location.hash;
      window.history.replaceState(null, '', import.meta.env.BASE_URL + target);
    } catch { /* 忽略 */ }
  }, []);

  /* 统一的重连动作：重新探测并按需刷新会话，带并发保护避免重复请求 */
  const reconnect = useCallback(async (markBusy = false): Promise<boolean> => {
    if (probingRef.current) return false;
    probingRef.current = true;
    if (markBusy) setReconnecting(true);
    try {
      const found = await probeBackend();
      setOffline(!found);
      if (found) refresh();
      return found;
    } finally {
      probingRef.current = false;
      if (markBusy) setReconnecting(false);
    }
  }, [refresh]);

  /* 域名直达：页面不是从后端域名打开时（如 GitHub Pages），探测可用后端并连接。
     探测顺序：已保存的地址 → backend.json 候选 → 本机服务（桌面软件内置）。 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const direct = await fetch('/api/runtime', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (direct?.app && !getApiBase()) return;
      if (!alive) return;
      await reconnect();
    })();
    return () => { alive = false; };
  }, [reconnect]);

  /* 离线自动重连：探测失败（后端临时不可用）时，每隔一段时间自动重试，
     后端一旦恢复（含隧道地址变更）即自动连接，无需用户手动刷新页面。 */
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => { reconnect(); }, 10000);
    return () => { clearInterval(timer); };
  }, [offline, reconnect]);

  /* 请求级网络故障：用户点「获取验证码」等操作失败时立刻重探测，
     不用等 10 秒定时器，且能自动切到刚更新的隧道地址。
     加冷却避免多个并发失败请求触发一堆探测。 */
  useEffect(() => {
    let last = 0;
    const onLost = () => {
      const t = Date.now();
      if (t - last < 3000) return;
      last = t;
      reconnect();
    };
    window.addEventListener('cv:backend-lost', onLost);
    return () => window.removeEventListener('cv:backend-lost', onLost);
  }, [reconnect]);

  /* 托管环境访问凭据：记住 sharecode，SPA 跳转/刷新后补回地址栏 */
  useEffect(() => {
    rememberShareCode();
    let code: string | null = null;
    try {
      code = sessionStorage.getItem('cv-sharecode');
    } catch {
      /* 忽略 */
    }
    if (code && !window.location.search.includes('sharecode')) {
      window.history.replaceState(null, '', withShareCode(window.location.pathname + window.location.search));
    }
  }, [location]);

  if (loading) {
    return (
      <div className="app-loading">
        <Icon name="spinner" size={26} className="spin" />
        {offline && (
          <div style={{ marginTop: 14, color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: '0 24px', lineHeight: 2 }}>
            正在连接漫画库服务器…
            <br />
            登录、验证码等功能需要服务器在线，连接成功后会自动恢复。
            <br />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => reconnect(true)}>
              {reconnecting ? '重试中…' : '立即重试'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // 首次使用（还没有任何账号）必须先创建第一个账号
  if (needsSetup) return <AuthPage />;

  // 分享链接、首页、公共书库、广场、用户主页、公开漫画详情、阅读器与设置页：无需登录也能浏览
  // 设置页包含「安装为应用 / 桌面软件与数据互通」，首次访问（尚未注册）也应可用
  const isHome = location.pathname === '/' || location.pathname === '';
  const publicPath =
    isHome ||
    location.pathname.startsWith('/s/') ||
    location.pathname.startsWith('/community') ||
    location.pathname.startsWith('/plaza') ||
    location.pathname.startsWith('/u/') ||
    location.pathname.startsWith('/comic/') ||
    location.pathname.startsWith('/read/') ||
    location.pathname.startsWith('/downloads') ||
    location.pathname.startsWith('/settings');

  // 允许未登录进入应用（可浏览公共内容）；仅个人书架的私有操作按需引导登录
  // ?login=1 显式唤起登录页（顶栏「登录 / 注册」、未登录态的引导按钮都用它）
  const wantLogin = new URLSearchParams(location.search).has('login');
  if (!user && (wantLogin || !publicPath)) return <AuthPage />;

  return (
    <div className="app">
      {offline && (
        <div className="offline-bar">
          <Icon name="globe" size={14} />
          服务器暂时不可用，登录 / 验证码等功能需等连接恢复（后台自动重试）
          <button className="btn sm ghost" style={{ marginLeft: 'auto', padding: '2px 10px' }}
            disabled={reconnecting} onClick={() => reconnect(true)}>
            {reconnecting ? '重试中…' : '立即重试'}
          </button>
        </div>
      )}
      {!immersive && <Header theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />}
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/plaza" element={<PlazaPage />} />
        <Route path="/u/:id" element={<UserPage />} />
        <Route path="/comic/:id" element={<ComicPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/read/:id" element={<ReaderPage />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/downloads" element={<DownloadsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<LibraryPage />} />
      </Routes>
      {!immersive && <MobileTabs />}
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ToastProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
