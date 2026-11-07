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
import sharp from 'sharp';

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

/**
 * 把验证码渲染成图片（PNG，base64 data URI）。
 * 用作邮件里的「图片型验证码」——既好看又能防简单的机读 scraping，
 * 同时下方仍附有大号可复制的纯文本验证码，方便用户直接复制。
 */
async function renderCodeImage(code) {
  const digits = String(code)
    .split('')
    .map((d, i) => `<tspan dx="${i === 0 ? 0 : 14}">${d}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="190" viewBox="0 0 440 190">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1530"/>
      <stop offset="1" stop-color="#0f1115"/>
    </linearGradient>
  </defs>
  <rect width="440" height="190" rx="20" fill="url(#g)"/>
  <rect x="8" y="8" width="424" height="174" rx="14" fill="none" stroke="#7c6cff" stroke-opacity="0.45"/>
  <text x="220" y="50" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="20" font-weight="600" fill="#b9a9ff">ComicVault 验证码</text>
  <text x="220" y="128" text-anchor="middle" font-family="'Courier New',monospace" font-size="62" font-weight="800" letter-spacing="14" fill="#ffffff">${digits}</text>
  <text x="220" y="166" text-anchor="middle" font-family="'PingFang SC',sans-serif" font-size="13" fill="#8b93a3">5 分钟内有效 · 请勿泄露给他人</text>
</svg>`;
  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** 生成带图片验证码 + 大号可复制文本的 HTML 邮件正文 */
async function buildHtml(email, code, scene) {
  const img = await renderCodeImage(code);
  const imgTag = img
    ? `<img src="${img}" alt="验证码 ${code}" width="440" height="190" style="display:block;max-width:100%;border-radius:14px;margin:10px auto;" />`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08);">
    <div style="background:#0f1115;color:#fff;padding:18px 22px;font-size:18px;font-weight:700;">漫狐漫画</div>
    <div style="padding:22px;">
      <p style="margin:0 0 12px;color:#333;font-size:15px;line-height:1.7;">尊敬的用户，您好：您正在进行<b style="color:#e23b6b;">${SCENE_LABEL[scene]}</b>操作，请复制下方验证码完成验证。</p>
      ${imgTag}
      <div style="text-align:center;margin:8px 0 4px;">
        <span style="display:inline-block;font-family:'Courier New',monospace;font-size:34px;font-weight:800;letter-spacing:8px;color:#0f1115;background:#f0eefe;padding:10px 18px;border-radius:12px;user-select:text;">${code}</span>
      </div>
      <p style="margin:10px 0 0;color:#888;font-size:13px;line-height:1.7;">如非本人操作，请立即修改密码并检查账号安全。工作人员不会向您索取验证码，请勿泄漏。此为系统邮件，请勿回复。</p>
    </div>
  </div></body></html>`;
}

const SCENE_LABEL = { login: '登录账号', verify: '验证邮箱', reset: '重置密码' };

async function sendViaResend(email, code, scene) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'ComicVault <onboarding@resend.dev>';
  const html = await buildHtml(email, code, scene);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: email,
      subject: SCENES[scene].subject,
      text: SCENES[scene].text(code),
      html,
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
      html: await buildHtml(email, code, scene),
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
