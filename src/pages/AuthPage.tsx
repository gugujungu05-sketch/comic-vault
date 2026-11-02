import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { social } from '../lib/api';
import { useSession } from '../lib/session';

type Mode = 'password' | 'code';

export function AuthPage() {
  const { needsSetup, codeLogin, setUser, refresh } = useSession();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [mode, setMode] = useState<Mode>('password');
  const [register, setRegister] = useState(needsSetup);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish() {
    await refresh();
    toast('欢迎回来');
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return errorToast(new Error('请填写邮箱和密码'));
    setBusy(true);
    try {
      const r = register
        ? await social.register({ email: email.trim(), password, name: name.trim() })
        : await social.login({ email: email.trim(), password });
      setUser('user' in r ? r.user : null);
      await finish();
    } catch (err) {
      errorToast(err, register ? '注册失败' : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    if (!email.trim()) return errorToast(new Error('请先填写邮箱'));
    setBusy(true);
    try {
      const r = await social.sendCode(email.trim());
      setDevCode(r.devCode);
      toast(r.sent ? '验证码已发送到邮箱' : '已生成开发模式验证码');
    } catch (err) {
      errorToast(err, '发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !code.trim()) return errorToast(new Error('请填写邮箱和验证码'));
    setBusy(true);
    try {
      const r = await social.loginCode(email.trim(), code.trim());
      setUser(r.user);
      await finish();
    } catch (err) {
      errorToast(err, '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark big"><Icon name="book" size={26} /></span>
          <h1>ComicVault</h1>
          <p>存储 · 分话 · 阅读 · 分享</p>
          <div className="auth-features">
            <div><Icon name="book" size={16} /> 私人书架，数据彼此独立</div>
            <div><Icon name="users" size={16} /> 公共书库，大家一起补全</div>
            <div><Icon name="message" size={16} /> 广场讨论，分享好漫画</div>
            <div><Icon name="share" size={16} /> 私密漫画也能一键分享</div>
          </div>
        </div>

        <div className="auth-form">
          <h2>{needsSetup ? '创建第一个账号' : '登录 / 注册'}</h2>
          {needsSetup && (
            <div className="auth-hint">这是本站的第一个账号，创建后会自动接管书架里已有的漫画。</div>
          )}

          <div className="tabs" style={{ marginBottom: 18 }}>
            <button className={`tab ${mode === 'password' ? 'active' : ''}`} onClick={() => setMode('password')}>
              邮箱 + 密码
            </button>
            <button className={`tab ${mode === 'code' ? 'active' : ''}`} onClick={() => setMode('code')}>
              邮箱验证码
            </button>
          </div>

          {mode === 'password' ? (
            <form onSubmit={submitPassword}>
              <div className="field">
                <label>邮箱</label>
                <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              {register && (
                <div className="field">
                  <label>昵称</label>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="怎么称呼你" />
                </div>
              )}
              <div className="field">
                <label>密码（至少 6 位）</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
              </div>
              <button className="btn primary block" disabled={busy} type="submit">
                {busy ? '请稍候…' : register ? '创建账号' : '登录'}
              </button>
              <button
                type="button"
                className="btn ghost block"
                onClick={() => setRegister(!register)}
                style={{ marginTop: 10 }}
              >
                {register ? '已有账号？去登录' : '没有账号？注册一个'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <div className="field">
                <label>邮箱</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={sendCode} disabled={busy}>
                  获取验证码
                </button>
                <input className="input" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" />
              </div>
              {devCode && (
                <div className="auth-hint dev">
                  开发模式验证码：<b>{devCode}</b>
                  <button type="button" className="btn sm ghost" onClick={() => setCode(devCode)} style={{ marginLeft: 8 }}>
                    填入
                  </button>
                </div>
              )}
              {codeLogin.devMode && !devCode && (
                <div className="auth-hint">尚未配置邮件服务，获取验证码后会直接显示在本页（配置 RESEND_API_KEY 后自动改为发真实邮件）。</div>
              )}
              <button className="btn primary block" disabled={busy} type="submit" style={{ marginTop: 14 }}>
                {busy ? '请稍候…' : '验证码登录 / 注册'}
              </button>
            </form>
          )}
          <div className="auth-foot">漫画数据各账号独立；公共书库与广场无需登录也能浏览。</div>
        </div>
      </div>
    </div>
  );
}
