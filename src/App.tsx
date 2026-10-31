import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './components/Toasts';
import { Icon } from './components/Icon';
import { LibraryPage } from './pages/LibraryPage';
import { ComicPage } from './pages/ComicPage';
import { ReaderPage } from './pages/ReaderPage';
import { SharePage } from './pages/SharePage';
import { SettingsPage } from './pages/SettingsPage';

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
        <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
          设置
        </NavLink>
      </nav>
      <div className="header-right">
        <button className="btn icon ghost" onClick={onToggleTheme} title="切换主题" aria-label="切换主题">
          <Icon name={theme === 'dark' ? 'eye' : 'settings'} />
        </button>
      </div>
    </header>
  );
}

function Shell() {
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const immersive = location.pathname.startsWith('/read/') || location.pathname.startsWith('/s/');

  return (
    <div className="app">
      {!immersive && (
        <Header theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
      )}
      <Routes>
        <Route path="/" element={<LibraryPage />} />
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
        <Shell />
      </ToastProvider>
    </BrowserRouter>
  );
}
