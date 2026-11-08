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
// sharp 是原生模块，桌面端内置的 host 服务未打包它。
// 这里改为按需动态引入：缺 sharp 时自动降级为纯文本验证码，不影响服务启动与发信。

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

/** 品牌（邮件里所有展示名统一用 ComicVault 漫画库，不引用任何第三方） */
const BRAND = 'ComicVault';
const BRAND_CN = '漫画库';

/**
 * 把验证码渲染成图片（PNG → base64 data URI）。
 * 卡片式设计：深色渐变底 + 光晕 + 每位数字一个圆角方块，既美观也能防简单机读。
 * 图片内不放中文（避免邮件端字体缺失变豆腐块），中文说明放在 HTML 正文里。
 */
async function renderCodeImage(code) {
  const chars = String(code).split('');
  const n = chars.length;
  const boxW = 56, gap = 10, boxH = 74, radius = 12;
  const totalW = n * boxW + (n - 1) * gap;
  const startX = (440 - totalW) / 2;
  const boxes = chars.map((c, i) => {
    const x = startX + i * (boxW + gap);
    return `<g>
      <rect x="${x}" y="72" width="${boxW}" height="${boxH}" rx="${radius}" fill="#ffffff" fill-opacity="0.08" stroke="#a99cff" stroke-opacity="0.35"/>
      <text x="${x + boxW / 2}" y="122" text-anchor="middle" font-family="'DejaVu Sans Mono','Courier New',monospace" font-size="42" font-weight="700" fill="#ffffff">${c}</text>
    </g>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="196" viewBox="0 0 440 196">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6c5ce7"/>
      <stop offset="0.55" stop-color="#4a3fb0"/>
      <stop offset="1" stop-color="#241d52"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.2" cy="0.1" r="0.9">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="440" height="196" rx="20" fill="url(#bg)"/>
  <rect width="440" height="196" rx="20" fill="url(#glow)"/>
  <circle cx="392" cy="24" r="70" fill="#ffffff" fill-opacity="0.05"/>
  <circle cx="44" cy="182" r="46" fill="#ffffff" fill-opacity="0.05"/>
  <text x="28" y="42" font-family="'DejaVu Sans','Arial',sans-serif" font-size="14" font-weight="700" letter-spacing="3" fill="#e8e3ff">COMICVAULT</text>
  <text x="412" y="42" text-anchor="end" font-family="'DejaVu Sans','Arial',sans-serif" font-size="11" letter-spacing="1" fill="#cbc2ff">SECURITY CODE</text>
  <line x1="28" y1="54" x2="412" y2="54" stroke="#ffffff" stroke-opacity="0.18"/>
  ${boxes}
  <text x="220" y="178" text-anchor="middle" font-family="'DejaVu Sans','Arial',sans-serif" font-size="12" letter-spacing="1" fill="#d7d0ff">VALID FOR 5 MINUTES</text>
</svg>`;
  try {
    const sharp = (await import('sharp')).default;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    // 无 sharp（桌面内置服务）→ 无图片，邮件正文仍保留大号可复制的纯文本验证码
    return null;
  }
}

/** 生成带图片验证码 + 大号可复制文本的 HTML 邮件正文（表格布局，兼容主流邮箱客户端） */
async function buildHtml(email, code, scene) {
  const img = await renderCodeImage(code);
  const label = SCENE_LABEL[scene] || '账号验证';
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const imgTag = img
    ? `<img src="${img}" width="440" height="196" alt="ComicVault 验证码" style="display:block;width:100%;max-width:440px;height:auto;border-radius:14px;" />`
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef0f6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f6;padding:28px 12px;"><tr><td align="center">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 32px rgba(38,29,82,.10);">

    <!-- 品牌条 -->
    <tr><td style="background:#0f1115;padding:20px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;">
          <span style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;background:#6c5ce7;border-radius:9px;font-size:17px;color:#fff;font-weight:700;">C</span>
        </td>
        <td style="vertical-align:middle;padding-left:11px;">
          <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.3px;">${BRAND} <span style="color:#a99cff;font-weight:500;font-size:13px;">${BRAND_CN}</span></div>
        </td>
      </tr></table>
    </td></tr>

    <!-- 标题与场景 -->
    <tr><td style="padding:28px 30px 0;">
      <div style="font-size:21px;font-weight:700;color:#1c2030;">验证码确认</div>
      <div style="font-size:14px;color:#6b7285;line-height:1.8;margin-top:8px;">
        你好，你正在进行 <b style="color:#6c5ce7;">${label}</b> 操作。<br>
        请在 5 分钟内使用下方验证码完成验证。
      </div>
    </td></tr>

    <!-- 图片型验证码 -->
    <tr><td style="padding:20px 30px 0;">
      ${imgTag || `<div style="background:#4a3fb0;color:#fff;border-radius:14px;padding:24px;text-align:center;font-size:34px;letter-spacing:10px;font-weight:700;">${esc(code)}</div>`}
    </td></tr>

    <!-- 大号可单独复制的纯文本验证码：纯色深紫底 + 白字，兼容 QQ/163/Outlook/Gmail -->
    <tr><td style="padding:18px 30px 0;">
      <div style="font-size:12.5px;color:#8a90a3;text-align:center;margin-bottom:10px;">👇 如无法查看图片，可直接复制下方验证码</div>
      <div style="text-align:center;">
        <span style="display:inline-block;font-family:'Courier New',Consolas,monospace;font-size:44px;font-weight:800;letter-spacing:12px;color:#ffffff;background:#5a49c9;border:2px solid #6c5ce7;padding:14px 26px;border-radius:14px;user-select:all;-webkit-user-select:all;-webkit-touch-callout:default;white-space:nowrap;word-break:keep-all;">${esc(code)}</span>
      </div>
      <div style="font-size:12.5px;color:#6c5ce7;font-weight:600;text-align:center;margin-top:10px;">长按 / 双击即可一次选中并复制完整验证码</div>
    </td></tr>

    <!-- 安全提示 -->
    <tr><td style="padding:22px 30px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9ff;border-left:3px solid #6c5ce7;border-radius:8px;"><tr><td style="padding:12px 14px;">
        <div style="font-size:12.5px;color:#7a7f92;line-height:1.9;">
          · 验证码仅用于本次 <b>${label}</b>，请勿转发或告知他人。<br>
          · 如果这不是你本人的操作，请忽略本邮件，账号仍然安全。<br>
          · ComicVault 工作人员不会向你索取验证码。
        </div>
      </td></tr></table>
    </td></tr>

    <!-- 页脚 -->
    <tr><td style="padding:24px 30px 26px;">
      <div style="border-top:1px solid #eef0f4;padding-top:16px;font-size:11.5px;color:#a6adbd;line-height:1.8;text-align:center;">
        本邮件由 <b style="color:#6c5ce7;">${BRAND}</b> 系统自动发送，请勿直接回复。<br>
        © ${new Date().getFullYear()} ${BRAND} · 存储 · 分话 · 阅读 · 分享
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
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
