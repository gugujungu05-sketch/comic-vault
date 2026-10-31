import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Stats } from '../types';
import { Icon } from '../components/Icon';
import { formatBytes } from '../lib/util';
import { useErrorToast, useToast } from '../components/Toasts';

export function SettingsPage() {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('cv-theme') as 'dark' | 'light') || 'dark',
  );

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.list().then((r) => setDirection(r.settings.defaultDirection || 'ltr')).catch(() => {});
  }, []);

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
      </div>
    </main>
  );
}
