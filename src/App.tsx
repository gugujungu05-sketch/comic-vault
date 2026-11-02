import { useEffect, useState } from 'react';
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
import { SessionProvider, useSession } from './lib/session';
import { social } from './lib/api';
import { rememberShareCode, withShareCode } from './lib/util';

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
          <NavLink to={`/u/${user.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
            我的主页
          </NavLink>
        )}
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
              <span className="avatar sm">{user.name.slice(0, 1).toUpperCase()}</span>
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
          <button className="btn sm primary" onClick={() => navigate('/')}>
            登录 / 注册
          </button>
        )}
      </div>
    </header>
  );
}

function Shell() {
  const { theme, setTheme } = useTheme();
  const { user, loading } = useSession();
  const location = useLocation();
  const immersive = location.pathname.startsWith('/read/') || location.pathname.startsWith('/s/');

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
      </div>
    );
  }

  // 分享链接、公共书库、广场、用户主页、公开漫画详情与阅读器：无需登录也能浏览
  const publicPath =
    location.pathname.startsWith('/s/') ||
    location.pathname.startsWith('/community') ||
    location.pathname.startsWith('/plaza') ||
    location.pathname.startsWith('/u/') ||
    location.pathname.startsWith('/comic/') ||
    location.pathname.startsWith('/read/');

  if (!user && !publicPath) return <AuthPage />;

  return (
    <div className="app">
      {!immersive && <Header theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />}
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/plaza" element={<PlazaPage />} />
        <Route path="/u/:id" element={<UserPage />} />
        <Route path="/comic/:id" element={<ComicPage />} />
        <Route path="/read/:id" element={<ReaderPage />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<LibraryPage />} />
      </Routes>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
