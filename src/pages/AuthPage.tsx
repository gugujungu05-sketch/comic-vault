import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useErrorToast, useToast } from '../components/Toasts';
import { social } from '../lib/api';
import { useSession } from '../lib/session';

type Mode = 'password' | 'code' | 'forgot';

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
  const [newPassword, setNewPassword] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [forgotSent, setForgotSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeLeft, setCodeLeft] = useState(0);
  const [showPwd, setShowPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);

  useEffect(() => {
    if (codeLeft <= 0) return;
    const t = setInterval(() => setCodeLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(t);
  }, [codeLeft]);

  async function finish() {
    await refresh();
    toast('欢迎回来');
  }

  function switchMode(next: Mode) {
    setMode(next);
    setDevCode(null);
    setForgotSent(false);
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
    if (codeLeft > 0) return;
    setBusy(true);
    try {
      const r = await social.sendCode(email.trim());
      setDevCode(r.devCode);
      setCodeLeft(60);
      toast(r.sent ? '验证码已发送到邮箱' : (r.devCode ? '已生成开发模式验证码' : '邮件发送失败'));
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

  async function sendResetCode() {
    if (!email.trim()) return errorToast(new Error('请先填写邮箱'));
    setBusy(true);
    try {
      const r = await social.forgotSend(email.trim());
      setForgotSent(true);
      toast(r.hint || '验证码已发送，请查收邮箱');
    } catch (err) {
      errorToast(err, '发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !code.trim() || !newPassword) {
      return errorToast(new Error('请填写邮箱、验证码和新密码'));
    }
    if (newPassword.length < 6) return errorToast(new Error('新密码至少 6 位'));
    setBusy(true);
    try {
      const r = await social.forgotReset({
        email: email.trim(), code: code.trim(), password: newPassword,
      });
      toast(r.hint || '密码已重置，请重新登录');
      setCode('');
      setNewPassword('');
      setPassword('');
      setForgotSent(false);
      switchMode('password');
      setRegister(false);
      await refresh();
    } catch (err) {
      errorToast(err, '重置失败');
    } finally {
      setBusy(false);
    }
  }

  const recoveryEnabled = !!codeLogin.recoveryEnabled;

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
            <button className={`tab ${mode === 'password' ? 'active' : ''}`} onClick={() => switchMode('password')}>
              邮箱 + 密码
            </button>
            <button className={`tab ${mode === 'code' ? 'active' : ''}`} onClick={() => switchMode('code')}>
              邮箱验证码
            </button>
            {recoveryEnabled && (
              <button className={`tab ${mode === 'forgot' ? 'active' : ''}`} onClick={() => switchMode('forgot')}>
                忘记密码
              </button>
            )}
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
                <div className="pwd-wrap">
                  <input
                    className="input"
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••"
                  />
                  <button
                    type="button"
                    className="pwd-toggle"
                    onClick={() => setShowPwd((v) => !v)}
                    title={showPwd ? '隐藏密码' : '显示密码（防止输错）'}
                  >
                    {showPwd ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
              {register && (
                <div className="auth-hint">
                  注册不需要邮箱验证码，可以直接开始使用。之后到「设置 → 邮箱验证」补做验证，验证后这个邮箱就能用来找回密码。
                </div>
              )}
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
              {recoveryEnabled && (
                <button type="button" className="btn ghost block" onClick={() => switchMode('forgot')} style={{ marginTop: 6 }}>
                  忘记密码？用邮箱找回
                </button>
              )}
            </form>
          ) : mode === 'code' ? (
            <form onSubmit={submitCode}>
              <div className="field">
                <label>邮箱</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={sendCode} disabled={busy || codeLeft > 0}>
                  {codeLeft > 0 ? `${codeLeft} 秒后再发` : '获取验证码'}
                </button>
                <input className="input" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" />
              </div>
              {devCode && (
                <div className="auth-code-box" role="status">
                  <span className="auth-code-label">邮箱验证码（点击复制）</span>
                  <button
                    type="button"
                    className="auth-code-value"
                    onClick={async () => {
                      const { copyText } = await import('../lib/util');
                      await copyText(devCode);
                      toast('验证码已复制');
                    }}
                    title="复制验证码"
                  >
                    {devCode}
                  </button>
                  <button type="button" className="btn sm" onClick={() => setCode(devCode)}>填入</button>
                </div>
              )}
              <div className="auth-hint" style={{ marginTop: 12 }}>
                新邮箱验证码登录即自动注册，无需密码；密码之后可在「设置」里补设。
              </div>
              <button className="btn primary block" disabled={busy} type="submit" style={{ marginTop: 14 }}>
                {busy ? '请稍候…' : '登录 / 注册'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitReset}>
              <div className="field">
                <label>账号邮箱</label>
                <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={sendResetCode} disabled={busy}>
                  {forgotSent ? '重新发送' : '获取验证码'}
                </button>
                <input className="input" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" />
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label>新密码（至少 6 位）</label>
                <div className="pwd-wrap">
                  <input
                    className="input"
                    type={showNewPwd ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••"
                  />
                  <button
                    type="button"
                    className="pwd-toggle"
                    onClick={() => setShowNewPwd((v) => !v)}
                    title={showNewPwd ? '隐藏密码' : '显示密码（防止输错）'}
                  >
                    {showNewPwd ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
              <div className="auth-hint">
                只有<strong>已验证过邮箱</strong>的账号能收到重置验证码。还没验证的话，请先登录后在「设置 → 邮箱验证」完成验证。
              </div>
              <button className="btn primary block" disabled={busy} type="submit" style={{ marginTop: 14 }}>
                {busy ? '请稍候…' : '重置密码'}
              </button>
              <button type="button" className="btn ghost block" onClick={() => switchMode('password')} style={{ marginTop: 10 }}>
                想起来了，返回登录
              </button>
            </form>
          )}
          <div className="auth-foot">漫画数据各账号独立；公共书库与广场无需登录也能浏览。</div>
        </div>
      </div>
    </div>
  );
}
