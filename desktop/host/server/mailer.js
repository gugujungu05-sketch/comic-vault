/**
 * 验证码发信：三条通道，按优先级自动选择。
 *
 *   1. RESEND_API_KEY                       → Resend HTTP API
 *   2. SMTP_HOST + SMTP_USER + SMTP_PASS    → 通用 SMTP（QQ / 163 / Gmail 授权码等）
 *   3. 都未配置                            → 开发模式（验证码直接显示在页面）
 *
 * 配置可来自系统环境变量，或项目根目录的 .env（见 env.js）。
 * 验证码按用途（登录 / 验证邮箱 / 重置密码）使用不同文案，便于用户分辨。
 */
import './env.js';
import nodemailer from 'nodemailer';

/** 不同用途的邮件标题与正文；「验证码是 xxxxxx」格式被测试脚本用于取码 */
const SCENES = {
  login: {
    subject: 'ComicVault 登录验证码',
    text: (c) => `你的登录验证码是 ${c}，10 分钟内有效。若非本人操作请忽略。`,
  },
  verify: {
    subject: 'ComicVault 邮箱验证',
    text: (c) => `你正在验证 ComicVault 账号邮箱，验证码是 ${c}，10 分钟内有效。验证完成后，这个邮箱可用于找回密码。`,
  },
  reset: {
    subject: 'ComicVault 重置密码',
    text: (c) => `你正在重置 ComicVault 账号密码，验证码是 ${c}，10 分钟内有效。若非本人操作请忽略，并尽快登录修改密码。`,
  },
};

/** 当前生效的发信通道，供 /api/auth/status 与错误提示使用。 */
export function mailChannel() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return 'dev';
}

export function mailConfigured() {
  return mailChannel() !== 'dev';
}

async function sendViaResend(email, code, scene) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'ComicVault <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: email,
      subject: SCENES[scene].subject,
      text: SCENES[scene].text(code),
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new Error(`Resend ${r.status}: ${detail}`);
  }
}

async function sendViaSmtp(email, code, scene) {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE === undefined
    ? port === 465
    : /^(1|true|yes|on)$/i.test(process.env.SMTP_SECURE);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // 自签名证书的内网 SMTP 可按需设 SMTP_TLS_INSECURE=1
    ...(process.env.SMTP_TLS_INSECURE === '1' ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 25000,
  });
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || `ComicVault <${process.env.SMTP_USER}>`,
      to: email,
      subject: SCENES[scene].subject,
      text: SCENES[scene].text(code),
    });
  } finally {
    transporter.close();
  }
}

/**
 * 发送验证码。
 * 返回 { sent, channel, devCode?, error? }：
 *  - 开发模式：sent=false 且带 devCode，前端直接展示；
 *  - 已配置但发送失败：sent=false 且不带 devCode，接口应报错而不是泄露验证码。
 */
export async function sendCodeMail(email, code, purpose = 'login') {
  const scene = SCENES[purpose] ? purpose : 'login';
  const channel = mailChannel();
  if (channel === 'dev') return { sent: false, channel, devCode: code };
  try {
    if (channel === 'resend') await sendViaResend(email, code, scene);
    else await sendViaSmtp(email, code, scene);
    return { sent: true, channel };
  } catch (err) {
    return { sent: false, channel, error: String(err?.message || err) };
  }
}

/** 兼容原有登录验证码调用 */
export const sendLoginCode = (email, code) => sendCodeMail(email, code, 'login');
