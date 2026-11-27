import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, discover, social, networkDiag, translation, VPN_HINT } from '../lib/api';
import { useSession } from '../lib/session';
import type { Announcement, Stats, UpdateInfo, TranslateConfig } from '../types';
import { Icon } from '../components/Icon';
import { formatBytes, withShareCode, copyText } from '../lib/util';
import { THEMES, normalizeTheme } from '../lib/themes';
import { useErrorToast, useToast } from '../components/Toasts';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type DesktopBridge = { version?: string };
type AndroidBridge = { version?: string; platform?: string };

export function SettingsPage() {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [runtime, setRuntime] = useState<{ version: string } | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const bridge = (window as unknown as { desktop?: DesktopBridge }).desktop;
  /* 安卓客户端的 WebView 桥：window.CVAndroid（不认识它就会按「网页版」查更新，
     返回网页版本号 2.7.x —— 看起来比客户端 3.4.x 还旧，用户以为没有新版本） */
  const androidBridge = (window as unknown as { CVAndroid?: AndroidBridge }).CVAndroid;
  const clientKind: 'desktop' | 'android' | 'web' = bridge ? 'desktop' : androidBridge ? 'android' : 'web';
  const clientVersion = bridge?.version || androidBridge?.version || '';
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
  const [theme, setTheme] = useState<string>(() => normalizeTheme(localStorage.getItem('cv-theme')));
  /* AI 翻译配置（生肉漫画 → 中文） */
  const [trCfg, setTrCfg] = useState<TranslateConfig | null>(null);
  const [trBusy, setTrBusy] = useState(false);
  const [trTest, setTrTest] = useState<{ ok: boolean; msg: string } | null>(null);
  // 翻译服务快速预设：选服务后自动填 provider/baseUrl/model，用户只需粘 Key
  const TR_PRESETS: Record<string, { provider: TranslateConfig['provider']; baseUrl: string; model: string; label: string; hint: string }> = {
    gemini: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', label: 'Google Gemini（免费额度最香，识图最准 · 需能访问谷歌）', hint: '谷歌账号登录 aistudio.google.com → Get API Key → 复制粘贴到下面。免费版每天 1500 次。国内网络需给软件挂代理。' },
    glm4v: { provider: 'custom', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.1v-thinking-flash', label: '智谱 GLM-4.1V-Thinking（国内直连 · 免费 · 识图准）', hint: '注册 open.bigmodel.cn → 控制台复制 API Key。免费视觉模型，定位文字框准、翻译质量高，国内直连无需代理。' },
    siliconflow: { provider: 'custom', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-32B-Instruct', label: '硅基流动 Qwen-VL（国内直连 · 有免费额度）', hint: '注册 siliconflow.cn → 复制 API Key。国内直连，新用户有免费额度。' },
    openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', label: 'OpenAI GPT-4o（付费 · 需能访问）', hint: 'platform.openai.com 创建 API Key。识图翻译准确，按量付费。' },
  };
  const [trPreset, setTrPreset] = useState('gemini');

  // 由后端配置反推当前预设，避免「选了智谱却显示 Gemini」的错位
  function detectPreset(cfg: TranslateConfig): string {
    const hit = Object.entries(TR_PRESETS).find(([, p]) => (
      p.provider === cfg.provider && p.baseUrl === cfg.baseUrl &&
      (!p.model || !cfg.model || p.model === cfg.model)
    ));
    return hit ? hit[0] : (cfg.provider === 'gemini' ? 'gemini' : 'custom');
  }

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.list().then((r) => setDirection(r.settings.defaultDirection || 'ltr')).catch(() => {});
    api.runtime().then(setRuntime).catch(() => {});
    translation.config().then((c) => { setTrCfg(c); setTrPreset(detectPreset(c)); }).catch(() => {});
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

  async function saveTranslate(patch: Partial<TranslateConfig>) {
    if (!trCfg) return;
    const next = { ...trCfg, ...patch };
    setTrCfg(next);
    setTrTest(null);
    try {
      await translation.saveConfig(patch);
      toast('翻译设置已保存');
    } catch (err) {
      errorToast(err);
    }
  }

  async function runTranslateTest() {
    setTrBusy(true);
    setTrTest(null);
    try {
      const r = await translation.test();
      setTrTest({ ok: r.ok, msg: `连接成功 · ${r.provider} / ${r.model} · 样图识别 ${r.regions} 处文字` });
    } catch (err) {
      setTrTest({ ok: false, msg: (err as Error)?.message || '测试失败，请检查 API Key 与网络' });
    } finally {
      setTrBusy(false);
    }
  }

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

  function changeTheme(next: string) {
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
      const r = await discover.checkUpdate(clientKind, clientVersion || '0');
      setUpdate(r);
      toast(r.hasUpdate ? `发现新版本 ${r.latest}` : '已是最新版本');
    } catch (err) {
      errorToast(err, '检查更新失败');
    } finally {
      setChecking(false);
    }
  }

  /* 网络（VPN）诊断：测后端连通性，给出可操作建议 */
  const [diag, setDiag] = useState<{ ok: boolean; ms: number; base: string } | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  async function runDiag() {
    setDiagBusy(true);
    try {
      const r = await networkDiag();
      setDiag(r);
    } catch {
      setDiag({ ok: false, ms: 0, base: '' });
    } finally {
      setDiagBusy(false);
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
        {/* AI 翻译配置：多模态大模型看图翻译生肉漫画，服务端原位渲染 */}
        <div className="chapter-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="chapter-title"><Icon name="globe" size={15} /> AI 翻译生肉漫画</div>
            <div className="chapter-sub">
              在阅读器里对非中文页面点「AI 翻译」：多模态大模型看懂画面上下文后翻译，服务端自动修补底图、把译文排回原位。
              哪家翻译最准就用哪家——推荐 Gemini（识图与排版最强）或 OpenAI GPT-4o；也支持自定义兼容接口。
              需自备对应服务的 API Key（本机/服务端保存，不会上传到别处）。
            </div>
          </div>
          {!trCfg ? (
            <div className="muted sm-text">正在读取翻译设置…</div>
          ) : (
            <>
              {/* 快速预设：一键填好地址与模型，用户只需粘 Key */}
              <div className="field" style={{ width: '100%' }}>
                <span>① 选翻译服务（一键填好地址与模型）</span>
                <select
                  className="input"
                  value={trPreset}
                  onChange={(e) => {
                    const key = e.target.value;
                    setTrPreset(key);
                    const p = TR_PRESETS[key];
                    if (!p) return;
                    const next = { ...trCfg, provider: p.provider, baseUrl: p.baseUrl, model: p.model };
                    setTrCfg(next);
                    // 立即落库，避免刷新后服务商/地址/模型又变回去
                    setTrTest(null);
                    translation.saveConfig({ provider: p.provider, baseUrl: p.baseUrl, model: p.model })
                      .then(() => toast(`已切换到「${p.label.split('（')[0]}」`))
                      .catch((err) => errorToast(err));
                  }}
                >
                  {Object.entries(TR_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                </select>
                <div className="muted sm-text" style={{ marginTop: 4, lineHeight: 1.5 }}>
                  {TR_PRESETS[trPreset]?.hint}
                </div>
              </div>
              <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: '0 0 auto' }}>
                  <span>当前服务商</span>
                  <div className="input" style={{ display: 'flex', alignItems: 'center', minWidth: 120, cursor: 'default' }}>
                    {trCfg.provider === 'gemini' ? 'Google Gemini' : trCfg.provider === 'openai' ? 'OpenAI' : '自定义接口'}
                  </div>
                </div>
                <div className="muted sm-text" style={{ paddingBottom: 8 }}>
                  由上方预设决定；如需更换，请重新选择「① 选翻译服务」
                </div>
              </div>
              <label className="field" style={{ width: '100%' }}>
                <span>API Key{trCfg.hasKey ? '（已保存，留空则保持不变）' : ''}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={trCfg.apiKey}
                  placeholder={trCfg.hasKey ? '••••••••（已保存）' : '粘贴 API Key'}
                  onChange={(e) => setTrCfg({ ...trCfg, apiKey: e.target.value })}
                />
              </label>
              <div className="row wrap" style={{ gap: 8 }}>
                <label className="field" style={{ flex: '1 1 260px' }}>
                  <span>接口地址（可留空用默认）</span>
                  <input
                    className="input"
                    value={trCfg.baseUrl}
                    placeholder={trCfg.defaults[trCfg.provider].baseUrl}
                    onChange={(e) => setTrCfg({ ...trCfg, baseUrl: e.target.value })}
                  />
                </label>
                <label className="field" style={{ flex: '1 1 200px' }}>
                  <span>模型</span>
                  <input
                    className="input"
                    value={trCfg.model}
                    placeholder={trCfg.defaults[trCfg.provider].model}
                    onChange={(e) => setTrCfg({ ...trCfg, model: e.target.value })}
                  />
                </label>
              </div>
              <label className="field" style={{ width: '100%' }}>
                <span>② 译文样式</span>
                <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!trCfg.autoStyle}
                    onChange={(e) => {
                      const next = { ...trCfg, autoStyle: e.target.checked };
                      setTrCfg(next);
                      translation.saveConfig({ autoStyle: e.target.checked }).catch((err) => errorToast(err));
                    }}
                  />
                  <span>跟随原文（自动用气泡里原文的颜色与粗细，译文更贴近原著，推荐开启）</span>
                </label>
              </label>
              <div className="row wrap" style={{ gap: 8 }}>
                <label className="field" style={{ flex: '1 1 140px' }}>
                  <span>目标语言</span>
                  <input
                    className="input"
                    value={trCfg.targetLang}
                    onChange={(e) => setTrCfg({ ...trCfg, targetLang: e.target.value })}
                    placeholder="简体中文"
                  />
                </label>
                <label className="field" style={{ flex: '1 1 140px' }}>
                  <span>字号调整（{trCfg.autoStyle ? '在贴合原文框基础上微调' : '负值更小 / 正值更大'}）</span>
                  <input
                    className="input"
                    type="number"
                    min={-6}
                    max={12}
                    value={trCfg.fontSizeOffset}
                    onChange={(e) => setTrCfg({ ...trCfg, fontSizeOffset: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="field" style={{ flex: '1 1 140px' }}>
                  <span>文字颜色（{trCfg.autoStyle ? '跟随原文时仅作兜底' : '所有译文统一用此色'}）</span>
                  <input
                    className="input"
                    type="color"
                    value={trCfg.inkColor}
                    onChange={(e) => setTrCfg({ ...trCfg, inkColor: e.target.value })}
                    style={{ width: 64, padding: 2 }}
                  />
                </label>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn primary" disabled={trBusy} onClick={() => saveTranslate({
                  provider: trCfg.provider, apiKey: trCfg.apiKey, baseUrl: trCfg.baseUrl, model: trCfg.model,
                  targetLang: trCfg.targetLang, fontSizeOffset: trCfg.fontSizeOffset, inkColor: trCfg.inkColor,
                  autoStyle: trCfg.autoStyle,
                })}>
                  {trBusy ? '处理中…' : '保存翻译设置'}
                </button>
                <button className="btn" disabled={trBusy} onClick={runTranslateTest}>
                  {trBusy ? '测试中…' : '测试连接'}
                </button>
              </div>
              {trTest && (
                <div className={trTest.ok ? 'auth-hint' : 'auth-hint dev'} style={{ color: trTest.ok ? 'var(--accent)' : undefined }}>
                  {trTest.msg}
                </div>
              )}
            </>
          )}
        </div>

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
            <div className="chapter-sub">阅读器界面会跟随主题一起变化</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`chip ${theme === t.id ? 'active' : ''}`}
                onClick={() => changeTheme(t.id)}
                title={t.label}
              >
                <span
                  style={{
                    display: 'inline-block', width: 12, height: 12, borderRadius: 4,
                    background: `linear-gradient(135deg, ${t.swatch[0]} 55%, ${t.swatch[1]} 55%)`,
                    marginRight: 6, border: '1px solid var(--border)', verticalAlign: '-2px',
                  }}
                />
                {t.label}
              </button>
            ))}
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
                {bridge
                  ? `桌面软件 v${bridge.version || '1.0'}`
                  : androidBridge
                    ? `安卓客户端 v${androidBridge.version || '1.0'}`
                    : installed
                      ? '已安装的应用'
                      : '浏览器网页'}
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
          <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={runDiag} disabled={diagBusy}>
              <Icon name="eye" size={15} /> {diagBusy ? '检测中…' : '网络检测'}
            </button>
            {diag && (
              <span className="muted sm-text">
                {diag.ok
                  ? `服务器连接正常（${diag.ms}ms）`
                  : `连不上服务器。${VPN_HINT}`}
              </span>
            )}
          </div>
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
