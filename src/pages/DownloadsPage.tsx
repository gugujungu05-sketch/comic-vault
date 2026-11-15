import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, discover, absoluteUrl } from '../lib/api';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { copyText, formatDate, withShareCode } from '../lib/util';
import type { SoftwareInfo, UpdateInfo } from '../types';

type Channel = 'desktop' | 'android' | 'web';
type DesktopBridge = { version?: string; isDesktop?: boolean };

/** 软件下载、网站地址、版本与自动更新检查 */
export function DownloadsPage() {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [info, setInfo] = useState<SoftwareInfo | null>(null);
  const [runtime, setRuntime] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const bridge = (window as unknown as { desktop?: DesktopBridge }).desktop;
  const channel: Channel = 'desktop';
  const clientVersion = bridge?.version || '';
  const siteUrl = withShareCode(`${window.location.origin}/`);

  useEffect(() => {
    discover.software().then(setInfo).catch(() => {});
    api.runtime().then((r) => setRuntime(r.version)).catch(() => {});
  }, []);

  async function check() {
    setChecking(true);
    try {
      const r = await discover.checkUpdate(channel, clientVersion);
      setUpdate(r);
      toast(r.hasUpdate ? '发现新版本，请下载最新安装包' : '已是最新版本');
    } catch (err) {
      errorToast(err, '检查更新失败');
    } finally {
      setChecking(false);
    }
  }

  async function copySite() {
    const ok = await copyText(siteUrl);
    toast(ok ? '网站地址已复制' : '复制失败，请手动复制地址栏网址');
  }

  async function copySha(sha: string) {
    const ok = await copyText(sha);
    toast(ok ? 'SHA256 已复制，可用于校验下载文件' : '复制失败');
  }

  /**
   * 安装包地址绝对化。
   * 历史 bug：/files/xxx.exe 在 GitHub Pages 上会被解析成 pages 域名的根路径而 404，
   * 点「下载」看起来毫无反应。现在补成常驻后端的绝对地址并带上网关凭据，
   * 配合服务端 Content-Disposition: attachment，点击即开始下载文件。
   */
  function downloadUrl(url: string) {
    if (!url.startsWith('/')) return url;
    return absoluteUrl(url) || withShareCode(url);
  }

  return (
    <main className="page downloads-page">
      <div className="page-head">
        <div>
          <h1 className="page-title anim-fade-up">软件下载与更新</h1>
          <div className="page-sub">桌面端、手机端、网页 / PWA 全部连同一个服务器、同一个账号、同一份数据 · 安装包清单随发版自动更新</div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <a className="btn" href="https://github.com/gugujungu05-sketch/comic-vault/releases/latest" target="_blank" rel="noreferrer">
            <Icon name="link" size={16} /> GitHub Release（备用）
          </a>
        </div>
      </div>

      <div className="dl-grid">
        <section className="panel">
          <div className="panel-title"><Icon name="globe" size={17} /> 网站地址</div>
          <div className="dl-site-url" title={siteUrl}>{siteUrl}</div>
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn sm" onClick={copySite}><Icon name="copy" size={14} /> 复制网址</button>
            <a className="btn sm" href={siteUrl} target="_blank" rel="noreferrer">
              <Icon name="link" size={14} /> 在新窗口打开
            </a>
          </div>
          <div className="muted sm-text" style={{ marginTop: 10 }}>
            桌面 / 手机软件是独立界面，在各自的「设置」里连接这个服务器地址，与网站共用同一份数据。
          </div>
        </section>

        <section className="panel">
          <div className="panel-title"><Icon name="refresh" size={17} /> 版本与自动更新</div>
          <div className="dl-ver-row"><span>网站版本</span><b>{runtime || info?.webVersion || '—'}</b></div>
          <div className="dl-ver-row"><span>客户端版本</span><b>v{info?.version || '—'}</b></div>
          <div className="dl-ver-row"><span>构建序号</span><b>#{info?.build ?? '—'}{info?.buildVersion ? ` · 包 ${info.buildVersion}` : ''}</b></div>
          <div className="dl-ver-row"><span>当前客户端</span><b>{bridge?.isDesktop ? `v${clientVersion}（桌面软件）` : '网页版 · 自动最新'}</b></div>
          {info?.autoUpdated && (
            <div className="dl-auto-tip">
              <Icon name="check" size={14} /> 安装包清单由发版脚本自动同步，服务端无需重启
            </div>
          )}
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn sm primary" onClick={check} disabled={checking}>
              <Icon name="refresh" size={14} /> {checking ? '检查中…' : '检查更新'}
            </button>
          </div>
          {update && (
            <div className={`dl-update ${update.hasUpdate ? 'has' : ''}`}>
              <div className="dl-update-head">
                {update.hasUpdate ? `发现新版本 ${update.latest}` : `已是最新版本 ${update.latest}`}
              </div>
              <div className="muted sm-text">{update.hint}</div>
              {update.hasUpdate && (
                <ul className="dl-notes">
                  {update.notes.map((n) => <li key={n}>{n}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="muted sm-text" style={{ marginTop: 10 }}>
            网页 / PWA 内容随服务器实时更新，永远不需要手动升级；桌面与手机软件按上面的清单下载新安装包。
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title"><Icon name="download" size={17} /> 安装包清单</div>
        <div className="dl-note">
          按平台与架构分文件，不提供合集包。下面的文件名、体积与 SHA256 由发版脚本从真实成品自动计算；
          点「直接下载」即走常驻服务器直链开始下载，服务端热读清单，<b>发新版不用改代码、不用重启</b>。
          同一份安装包也同步在 <a href={info?.driveUrl || '#'} target="_blank" rel="noreferrer">GitHub Release</a> 上。
        </div>
        <div className="dl-list">
          {(info?.software || []).map((s) => {
            const href = downloadUrl(s.url);
            return (
              <article className="dl-card" key={s.id}>
                <div className="dl-card-icon">{s.icon}</div>
                <div className="dl-card-body">
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <b>{s.name}</b>
                    <span className="chip sm">{s.platform}</span>
                    {s.primary && <span className="chip sm active">推荐</span>}
                    {s.local && <span className="chip sm local">本站直链</span>}
                  </div>
                  <div className="dl-card-file">{s.file} · {s.size}{s.sizeBytes ? '（实测）' : ''}</div>
                  <div className="muted sm-text">{s.desc}</div>
                  <div className="dl-card-meta">
                    {s.sha256 && (
                      <button className="dl-sha" onClick={() => copySha(s.sha256!)} title={s.sha256}>
                        SHA256 {s.sha256.slice(0, 12)}… · 复制校验
                      </button>
                    )}
                    {s.updatedAt ? <span>打包于 {formatDate(s.updatedAt)}</span> : null}
                  </div>
                </div>
                <div className="dl-card-ops">
                  {s.id === 'pwa' ? (
                    <Link className="btn sm" to="/"><Icon name="globe" size={14} /> 打开网页版</Link>
                  ) : (
                    <a className="btn sm primary" href={href} download={s.file || ''} rel="noreferrer">
                      <Icon name="download" size={14} /> 直接下载
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title"><Icon name="check" size={17} /> 安装与数据互通</div>
        <ol className="dl-steps">
          <li>按自己的系统选一个安装包：Windows 64 位选安装版或便携版，双击 exe；Linux 给 AppImage 加执行权限；Android 安装 APK。</li>
          <li>打开软件后保持默认服务器地址（就是上面的网站地址），用同一个邮箱账号登录。</li>
          <li>书架、公共书库、广场、阅读进度即时同步；网页刷新或手机切换网络都不会丢数据。</li>
          <li>iOS 用 Safari 打开网站 → 分享 → 「添加到主屏幕」，即得到与原生 App 一样的全屏体验。</li>
        </ol>
        {info?.notes?.length ? (
          <div className="dl-release">
            <b>客户端 v{info.version} 更新说明</b>
            <ul className="dl-notes">{info.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        ) : null}
        {(info?.releasedAt || update?.releasedAt) ? (
          <div className="muted sm-text" style={{ marginTop: 8 }}>
            版本发布时间：{formatDate((info?.releasedAt || update?.releasedAt)!)}
          </div>
        ) : null}
        {info?.versionRule ? (
          <details className="dl-rule">
            <summary>四段版本号怎么读（主.次.修.构建）</summary>
            <ul>{Object.entries(info.versionRule).map(([k, v]) => <li key={k}><code>{k}</code> {v}</li>)}</ul>
          </details>
        ) : null}
      </section>
    </main>
  );
}
