import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDb, saveDbSoon, newId, getComic, comicDir, coverOf, PLAZA_DIR, ensureAnnouncer } from './store.js';
import { sendCodeMail, mailConfigured, mailChannel } from './mailer.js';
import { recordActivity } from './activity.js';

const COOKIE = 'cv_sid';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CODE_MS = 10 * 60 * 1000;
// 验证码发送冷却：同一邮箱 60 秒内只允许发一次
const CODE_COOLDOWN_MS = 60 * 1000;
const codeCooldown = new Map();

const now = () => Date.now();

/** 广场分区：预设版块。'all' 只用于筛选，不写进帖子；旧帖子默认归到综合讨论 */
export const PLAZA_BOARDS = [
  { id: 'all', name: '全部', icon: '✨', desc: '所有动态' },
  { id: 'chat', name: '综合讨论', icon: '💬', desc: '聊漫画、聊日常' },
  { id: 'recommend', name: '漫画推荐', icon: '📚', desc: '安利好作品' },
  { id: 'seek', name: '求书求助', icon: '🔎', desc: '找资源、找名字' },
  { id: 'spoiler', name: '剧情吐槽', icon: '🔥', desc: '剧透慎入' },
  { id: 'share', name: '资源分享', icon: '📦', desc: '分享漫画与链接' },
  { id: 'sticker', name: '斗图表情', icon: '😆', desc: '表情包交流' },
  { id: 'offtopic', name: '闲聊灌水', icon: '☕', desc: '随便聊聊' },
];
const DEFAULT_BOARD = 'chat';

/** 广场附件允许的扩展名：拒绝 html/js/svg 等可携带脚本的类型 */
const PLAZA_ALLOWED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp',
  'mp4', 'webm', 'mov', 'm4v', 'ogv',
  'mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac',
  'pdf', 'zip', 'cbz', 'rar', '7z', 'epub', 'txt', 'json',
]);

function mediaKind(mime, name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const m = String(mime || '');
  if (/^image\//.test(m) || /^(jpg|jpeg|png|gif|webp|avif|bmp)$/.test(ext)) return 'image';
  if (/^video\//.test(m) || /^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return 'video';
  if (/^audio\//.test(m) || /^(mp3|m4a|wav|ogg|aac|flac)$/.test(ext)) return 'audio';
  return 'file';
}

/** 客户端可能把带 ?sharecode= 的地址原样回传，这里统一归一化，避免把托管凭据写进数据库 */
function normalizeMediaUrl(v) {
  const m = String(v || '').match(/^\/api\/plaza\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)/);
  return m ? `/api/plaza/media/${m[1]}` : null;
}

function safeMediaFile(s) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(String(s || ''));
}

function boardOf(p) {
  return PLAZA_BOARDS.some((b) => b.id !== 'all' && b.id === p?.board) ? p.board : DEFAULT_BOARD;
}

/** RFC 5987 中文下载名 */
function attachmentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    bio: u.bio || '',
    avatar: u.avatar || '',
    isAdmin: !!u.isAdmin,
    /** 单独授予的公告发布权限，只有站点公告账号为 true */
    canAnnounce: !!u.canAnnounce,
    emailVerified: !!u.emailVerified,
    createdAt: u.createdAt,
  };
}

function userName(id) {
  return loadDb().users.find((u) => u.id === id)?.name || '已注销用户';
}

function hashPwd(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

/** 帖子「密码可见」：sha256 即可（低敏场景，只为挡路人，不是挡攻击者） */
function hashPostPass(pwd) {
  return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

function setPassword(u, password) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.passwordHash = hashPwd(password, u.salt);
}

function checkPassword(u, password) {
  if (!u?.passwordHash || !u?.salt) return false;
  const a = Buffer.from(hashPwd(password, u.salt), 'hex');
  const b = Buffer.from(u.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueSession(res, userId) {
  const db = loadDb();
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions.push({ token, userId, createdAt: now(), expiresAt: now() + SESSION_MS });
  // 只保留最近 500 个会话
  if (db.sessions.length > 500) db.sessions.splice(0, db.sessions.length - 500);
  saveDbSoon();
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MS,
    path: '/',
  });
}

/** 每个请求解析登录态 */
export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.sessionToken = token || null;
  req.user = null;
  if (token) {
    const db = loadDb();
    const s = db.sessions.find((x) => x.token === token && x.expiresAt > now());
    if (s) req.user = db.users.find((u) => u.id === s.userId) || null;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录', needLogin: true });
  next();
}

function shareQueryValid(req, comic) {
  const token = req.query?.share || req.headers['x-share-token'];
  return !!(
    token &&
    comic.share?.enabled &&
    comic.share.token === token &&
    (!comic.share.expiresAt || comic.share.expiresAt > now())
  );
}

function isOwner(u, comic) {
  return !!u && (comic.ownerId === u.id || comic.createdBy === u.id);
}

/** 漫画级权限：读按可见性，写按归属，删除严格「谁传的谁删」 */
export function comicGuard(req, res, next) {
  const comic = getComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  req.comic = comic;
  const u = req.user;
  const owner = isOwner(u, comic);
  const community = comic.scope === 'community';
  const p = req.path || '/';

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (owner || community || comic.visibility === 'public' || shareQueryValid(req, comic)) {
      return next();
    }
    return res.status(403).json({ error: '这是私密漫画，需要分享链接才能查看' });
  }

  if (!u) return res.status(401).json({ error: '请先登录', needLogin: true });
  req.isOwner = owner;
  req.isAdmin = !!u.isAdmin;
  // 管理员也没有跨用户读写/删除特权：数据严格隔离，谁传的谁删
  req.canCollaborate = owner || community;

  // 仅创建者可改归属、公开范围、分享设置、删除整本
  const sensitive =
    (req.method === 'PATCH' && (p === '/' || p === '') &&
      req.body && (req.body.visibility !== undefined || req.body.scope !== undefined || req.body.ownerId !== undefined)) ||
    /^\/share(\/|$)/.test(p) ||
    (req.method === 'DELETE' && (p === '/' || p === ''));
  if (sensitive) {
    if (!owner) {
      return res.status(403).json({ error: '只有漫画创建者可以执行此操作' });
    }
    if (req.method === 'DELETE' && (p === '/' || p === '')) {
      const others = (comic.chapters || []).some((c) => c.uploadedBy && c.uploadedBy !== u.id);
      if (others) {
        return res.status(403).json({ error: '这本书包含他人上传的话，请由各自上传者删除对应话' });
      }
    }
    return next();
  }

  // 删除话：只有上传这一话的人可以删
  const chapterDelete = req.method === 'DELETE' && /^\/chapters\/[^/]+$/.test(p);
  if (chapterDelete) {
    const chId = p.split('/')[2];
    const ch = (comic.chapters || []).find((c) => c.id === chId);
    if (!ch) return res.status(404).json({ error: '章节不存在' });
    if (ch.uploadedBy && ch.uploadedBy !== u.id) {
      return res.status(403).json({ error: '只有上传这一话的人可以删除它' });
    }
    return next();
  }

  // 删除协作条目（别名 / 标签 / 封面）：由各路由按条目 by 再校验
  if (req.method === 'DELETE' && /^\/(aliases|tags|covers)\//.test(p)) return next();

  if (!req.canCollaborate) {
    return res.status(403).json({ error: '这是别人的私密漫画，无法修改' });
  }
  next();
}

/** 图片 / 导出等资源的访问控制 */
export function assetGuard(req, res, next) {
  const id = req.params.comicId || req.params.id;
  const comic = getComic(id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const u = req.user;
  req.isOwner = isOwner(u, comic);
  if (req.isOwner) return next();
  if (comic.scope === 'community' || comic.visibility === 'public') return next();
  if (shareQueryValid(req, comic)) return next();
  return res.status(403).json({ error: '无权访问该文件' });
}

/**
 * 验证码按用途隔离：登录码不能拿去验证邮箱或重置密码，反之亦然。
 * 发信实现见 mailer.js：SMTP / Resend 双通道，未配置时回退开发模式。
 */
const CODE_PURPOSES = new Set(['login', 'verify', 'reset']);

function issueCode(db, email, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.codes = db.codes.filter((c) => c.expiresAt > now());
  const entry = {
    email,
    purpose: CODE_PURPOSES.has(purpose) ? purpose : 'login',
    hash: crypto.createHash('sha256').update(code).digest('hex'),
    expiresAt: now() + CODE_MS,
    attempts: 0,
  };
  db.codes.push(entry);
  return { code, entry };
}

function takeCode(db, email, purpose) {
  return [...db.codes].reverse().find(
    (c) => c.email === email && c.expiresAt > now() && (c.purpose || 'login') === purpose,
  );
}

/** 校验并累计尝试次数；调用方在失败时负责 saveDbSoon() */
function verifyCode(entry, code) {
  if (!entry) return 'expired';
  if (entry.attempts >= 5) return 'tooMany';
  entry.attempts += 1;
  const a = Buffer.from(crypto.createHash('sha256').update(String(code || '').trim()).digest('hex'), 'hex');
  const b = Buffer.from(entry.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'wrong';
  return 'ok';
}

function codeError(res, result) {
  if (result === 'expired') return res.status(400).json({ error: '验证码已过期，请重新获取' });
  if (result === 'tooMany') return res.status(429).json({ error: '尝试次数过多，请重新获取' });
  return res.status(401).json({ error: '验证码不正确' });
}

/** 统一发信出口：已配置发信但投递失败时撤销验证码并返回 502，绝不回传明文 */
async function deliverCode(db, entry, email, code, purpose, res, okHint) {
  const mail = await sendCodeMail(email, code, purpose);
  if (mailConfigured() && !mail.sent) {
    db.codes = db.codes.filter((c) => c !== entry);
    saveDbSoon();
    return res.status(502).json({ error: '验证码邮件发送失败，请稍后重试' });
  }
  return res.json({
    ok: true,
    sent: mail.sent,
    // 仅开发模式返回明文验证码；真实发信模式下恒为 null
    devCode: mail.devCode || null,
    hint: mail.sent ? (okHint || '验证码已发送到邮箱') : '未配置邮件服务，已在本页显示开发验证码',
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerSocial(app, ctx) {
  const { summarize, uploadSingle, uploadPlaza, extOf, nanoid } = ctx;

  /* ------------------------------ 账号 ------------------------------ */

  app.get('/api/auth/status', (req, res) => {
    const db = loadDb();
    res.json({
      user: publicUser(req.user),
      needsSetup: db.users.length === 0,
      hasUsers: db.users.length,
      codeLogin: {
        emailEnabled: mailConfigured(),
        devMode: !mailConfigured(),
        channel: mailChannel(),
        // 找回密码必须依赖真实邮件；开发模式下禁用，防止明文码被拿来冒领账号
        recoveryEnabled: mailConfigured(),
      },
    });
  });

  app.post('/api/auth/register', (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim() || email.split('@')[0] || '漫友';
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (db.users.some((u) => u.email === email)) return res.status(409).json({ error: '该邮箱已注册' });

    const first = db.users.length === 0;
    const u = {
      id: newId('u'),
      email,
      name: name.slice(0, 30),
      bio: '',
      avatar: '',
      isAdmin: first,
      createdAt: now(),
      // 注册不强制验证邮箱：先让人用起来，之后可在设置里补验证
      emailVerified: false,
    };
    setPassword(u, password);
    db.users.push(u);
    // 空库启动时还没有用户，首个注册的账号在这里补齐公告权限
    ensureAnnouncer(db);

    // 第一个账号接管升级前的单机数据
    if (first) {
      for (const c of db.comics) {
        if (!c.ownerId) c.ownerId = u.id;
        if (!c.createdBy) c.createdBy = u.id;
        for (const ch of c.chapters || []) if (!ch.uploadedBy) ch.uploadedBy = u.id;
      }
    }
    saveDbSoon();
    issueSession(res, u.id);
    res.json({ user: publicUser(u), first });
  });

  app.post('/api/auth/login', (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    const u = db.users.find((x) => x.email === email);
    if (!u || !checkPassword(u, req.body?.password)) {
      return res.status(401).json({ error: '邮箱或密码不正确' });
    }
    issueSession(res, u.id);
    res.json({ user: publicUser(u) });
  });

  app.post('/api/auth/send-code', async (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    const waitMs = CODE_COOLDOWN_MS - (now() - (codeCooldown.get(email) || 0));
    if (waitMs > 0) {
      return res.status(429).json({ error: `发送太频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试` });
    }
    codeCooldown.set(email, now());
    const { code, entry } = issueCode(db, email, 'login');
    saveDbSoon();
    return deliverCode(db, entry, email, code, 'login', res);
  });

  app.post('/api/auth/login-code', (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    const entry = takeCode(db, email, 'login');
    const result = verifyCode(entry, req.body?.code);
    if (result !== 'ok') {
      saveDbSoon();
      return codeError(res, result);
    }
    db.codes = db.codes.filter((c) => c !== entry);
    let u = db.users.find((x) => x.email === email);
    let created = false;
    if (!u) {
      const first = db.users.length === 0;
      u = {
        id: newId('u'), email, name: email.split('@')[0], bio: '', avatar: '',
        isAdmin: first, createdAt: now(), emailVerified: false,
      };
      db.users.push(u);
      created = true;
      if (first) {
        for (const c of db.comics) {
          if (!c.ownerId) c.ownerId = u.id;
          if (!c.createdBy) c.createdBy = u.id;
          for (const ch of c.chapters || []) if (!ch.uploadedBy) ch.uploadedBy = u.id;
        }
      }
    }
    saveDbSoon();
    issueSession(res, u.id);
    res.json({ user: publicUser(u), created });
  });

  /* ---------- 邮箱验证：注册时可跳过，之后在设置里补做 ---------- */

  app.post('/api/auth/email/send-code', requireUser, async (req, res) => {
    const db = loadDb();
    if (req.user.emailVerified) return res.status(400).json({ error: '这个邮箱已经验证过了' });
    const email = normalizeEmail(req.user.email);
    const waitMs = CODE_COOLDOWN_MS - (now() - (codeCooldown.get(email) || 0));
    if (waitMs > 0) {
      return res.status(429).json({ error: `发送太频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试` });
    }
    codeCooldown.set(email, now());
    const { code, entry } = issueCode(db, email, 'verify');
    saveDbSoon();
    return deliverCode(db, entry, email, code, 'verify', res);
  });

  app.post('/api/auth/email/verify', requireUser, (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.user.email);
    const entry = takeCode(db, email, 'verify');
    const result = verifyCode(entry, req.body?.code);
    if (result !== 'ok') {
      saveDbSoon();
      return codeError(res, result);
    }
    db.codes = db.codes.filter((c) => c !== entry);
    req.user.emailVerified = true;
    req.user.emailVerifiedAt = now();
    saveDbSoon();
    res.json({ ok: true, user: publicUser(req.user) });
  });

  /* ---------- 找回密码：仅限已验证邮箱 + 已配置真实发信 ---------- */

  /** 未配置发信时不能开放找回密码，否则开发模式的明文码可被用来重置任意账号 */
  function requireRecovery(_req, res, next) {
    if (!mailConfigured()) {
      return res.status(503).json({
        error: '邮件服务尚未配置，暂不支持找回密码。请先用密码登录，或联系站点管理员。',
      });
    }
    next();
  }

  app.post('/api/auth/forgot/send', requireRecovery, async (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    // 防邮箱枚举：无论账号是否存在 / 是否验证，都返回同样的结果与提示
    const generic = {
      ok: true,
      sent: true,
      hint: '若该邮箱已验证，验证码已发送到邮箱；未验证或不存在则不会发送。',
    };
    const u = db.users.find((x) => x.email === email && x.emailVerified);
    if (!u) return res.json(generic);
    const { code, entry } = issueCode(db, email, 'reset');
    saveDbSoon();
    return deliverCode(db, entry, email, code, 'reset', res, generic.hint);
  });

  app.post('/api/auth/forgot/reset', requireRecovery, (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    if (password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const entry = takeCode(db, email, 'reset');
    const result = verifyCode(entry, req.body?.code);
    if (result !== 'ok') {
      saveDbSoon();
      return codeError(res, result);
    }
    const u = db.users.find((x) => x.email === email && x.emailVerified);
    if (!u) {
      saveDbSoon();
      return res.status(400).json({ error: '该邮箱尚未验证，无法用于找回密码' });
    }
    db.codes = db.codes.filter((c) => c !== entry);
    setPassword(u, password);
    // 密码已变：让该账号所有旧会话立即失效
    db.sessions = db.sessions.filter((s) => s.userId !== u.id);
    saveDbSoon();
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true, hint: '密码已重置，请用新密码登录' });
  });

  app.post('/api/auth/logout', (req, res) => {
    const db = loadDb();
    if (req.sessionToken) db.sessions = db.sessions.filter((s) => s.token !== req.sessionToken);
    saveDbSoon();
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: '请先登录', needLogin: true });
    const db = loadDb();
    res.json({
      user: publicUser(req.user),
      comics: db.comics.filter((c) => c.ownerId === req.user.id).map(summarize),
      postCount: db.posts.filter((p) => p.authorId === req.user.id).length,
    });
  });

  app.patch('/api/me', requireUser, (req, res) => {
    const u = req.user;
    const b = req.body || {};
    if (b.name !== undefined) u.name = String(b.name).trim().slice(0, 30) || u.name;
    if (b.bio !== undefined) u.bio = String(b.bio).slice(0, 300);
    if (b.avatar !== undefined) u.avatar = String(b.avatar).slice(0, 500);
    if (b.password) {
      if (String(b.password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      setPassword(u, b.password);
    }
    saveDbSoon();
    res.json({ user: publicUser(u) });
  });

  app.get('/api/users/:id', (req, res) => {
    const db = loadDb();
    const u = db.users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const comics = db.comics
      .filter((c) => c.ownerId === u.id && (c.visibility === 'public' || c.scope === 'community'))
      .map(summarize);
    const posts = db.posts.filter((p) => p.authorId === u.id).slice(0, 30).map(postView);
    res.json({ user: publicUser(u), comics, posts });
  });

  /* ------------------------------ 公共书库 ------------------------------ */

  app.get('/api/community/comics', (req, res) => {
    const db = loadDb();
    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const sort = String(req.query.sort || 'updated');
    let list = db.comics.filter((c) => c.scope === 'community');
    if (category && category !== 'all') {
      list = list.filter((c) => (c.category || 'other') === category);
    }
    if (q) {
      list = list.filter((c) => {
        const names = [c.title, ...(c.aliases || []).map((a) => a.value || '')];
        return names.some((n) => String(n).toLowerCase().includes(q))
          || String(c.author || '').toLowerCase().includes(q)
          || String(c.description || '').toLowerCase().includes(q)
          || (c.tags || []).some((t) => String(t).toLowerCase().includes(q))
          || (c.tagEntries || []).some((t) => String(t.value || '').toLowerCase().includes(q));
      });
    }
    const pagesOf = (c) => (c.chapters || []).reduce((n, x) => n + (x.pages?.length || 0), 0);
    list = [...list].sort((a, b) => {
      if (sort === 'views') return (b.views || 0) - (a.views || 0);
      if (sort === 'likes') return (b.likes?.length || 0) - (a.likes?.length || 0);
      if (sort === 'new') return (b.createdAt || 0) - (a.createdAt || 0);
      if (sort === 'pages') return pagesOf(b) - pagesOf(a);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const comics = list.map((c) => ({
      ...summarize(c),
      ownerName: userName(c.ownerId),
      createdBy: c.createdBy,
      aliasNames: (c.aliases || []).map((a) => a.value),
      aliases: c.aliases || [],
      covers: c.covers || [],
      tagEntries: c.tagEntries || [],
      activeCoverId: c.activeCoverId || null,
      activeAliasId: c.activeAliasId || null,
      category: c.category || 'other',
      views: Number(c.views) || 0,
      downloads: Number(c.downloads) || 0,
      likes: Array.isArray(c.likes) ? c.likes.length : 0,
      likedBy: Array.isArray(c.likes) ? c.likes : [],
      sample: !!c.sample,
      license: c.license || null,
      sourceUrl: c.sourceUrl || null,
      chapters: (c.chapters || []).map((ch) => ({
        id: ch.id, title: ch.title, number: ch.number ?? null,
        pageCount: ch.pages?.length || 0,
        uploadedBy: ch.uploadedBy || null,
        uploadedByName: ch.uploadedBy ? userName(ch.uploadedBy) : '未知',
      })),
    }));
    res.json({ comics, category: category || 'all', sort, query: q });
  });

  /* ------------------------------ 协作元数据 ------------------------------ */

  const entryList = { aliases: 'aliases', tags: 'tagEntries', covers: 'covers' };

  app.post('/api/comics/:id/aliases', requireUser, (req, res) => {
    const comic = req.comic;
    const value = String(req.body?.value || '').trim().slice(0, 80);
    if (!value) return res.status(400).json({ error: '名称不能为空' });
    comic.aliases = comic.aliases || [];
    const entry = { id: newId('al'), value, by: req.user.id, byName: req.user.name, at: now() };
    comic.aliases.push(entry);
    comic.updatedAt = now();
    saveDbSoon();
    res.json({ entries: comic.aliases, id: entry.id });
  });

  app.post('/api/comics/:id/tags', requireUser, (req, res) => {
    const comic = req.comic;
    const value = String(req.body?.value || '').trim().slice(0, 30);
    if (!value) return res.status(400).json({ error: '标签不能为空' });
    comic.tagEntries = comic.tagEntries || [];
    if (comic.tagEntries.some((t) => t.value === value)) {
      return res.status(409).json({ error: '这个标签已经有了' });
    }
    const entry = { id: newId('tg'), value, by: req.user.id, byName: req.user.name, at: now() };
    comic.tagEntries.push(entry);
    comic.updatedAt = now();
    saveDbSoon();
    res.json({ entries: comic.tagEntries, id: entry.id });
  });

  app.post('/api/comics/:id/covers/page', requireUser, (req, res) => {
    const comic = req.comic;
    const { chapterId, pageId } = req.body || {};
    const ch = (comic.chapters || []).find((c) => c.id === chapterId);
    const pg = ch?.pages?.find((p) => p.id === pageId);
    if (!ch || !pg) return res.status(404).json({ error: '页面不存在' });
    comic.covers = comic.covers || [];
    const entry = {
      id: newId('cv'), type: 'page',
      url: `/api/files/${comic.id}/${ch.id}/${pg.file}`,
      by: req.user.id, byName: req.user.name, at: now(),
    };
    comic.covers.push(entry);
    comic.activeCoverId = entry.id;
    comic.updatedAt = now();
    saveDbSoon();
    res.json({ entries: comic.covers, id: entry.id });
  });

  app.post('/api/comics/:id/covers/upload', uploadSingle, async (req, res) => {
    const comic = req.comic;
    if (!req.file) return res.status(400).json({ error: '请选择图片' });
    try {
      const ext = extOf(req.file.originalname) || 'jpg';
      const name = `cover_${nanoid(8)}.${ext}`;
      const dir = path.join(comicDir(comic.id), '_cover');
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(req.file.path, path.join(dir, name)).catch(async () => {
        await fs.copyFile(req.file.path, path.join(dir, name));
        await fs.rm(req.file.path, { force: true });
      });
      comic.covers = comic.covers || [];
      const entry = {
        id: newId('cv'), type: 'file',
        url: `/api/files/${comic.id}/_cover/${name}`,
        by: req.user.id, byName: req.user.name, at: now(),
      };
      comic.covers.push(entry);
      comic.activeCoverId = entry.id;
      comic.updatedAt = now();
      saveDbSoon();
      res.json({ entries: comic.covers, id: entry.id });
    } catch (err) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/comics/:id/covers/:coverId/activate', requireUser, (req, res) => {
    const comic = req.comic;
    if (!(comic.covers || []).some((c) => c.id === req.params.coverId)) {
      return res.status(404).json({ error: '封面不存在' });
    }
    comic.activeCoverId = req.params.coverId;
    comic.updatedAt = now();
    saveDbSoon();
    res.json({ ok: true, activeCoverId: comic.activeCoverId });
  });

  app.post('/api/comics/:id/aliases/:aliasId/activate', requireUser, (req, res) => {
    const comic = req.comic;
    if (!(comic.aliases || []).some((a) => a.id === req.params.aliasId)) {
      return res.status(404).json({ error: '名称不存在' });
    }
    comic.activeAliasId = req.params.aliasId;
    comic.updatedAt = now();
    saveDbSoon();
    res.json({ ok: true, activeAliasId: comic.activeAliasId });
  });

  // 删除协作条目：只能删自己添加的那一条
  for (const [route, field] of Object.entries(entryList)) {
    app.delete(`/api/comics/:id/${route}/:entryId`, requireUser, (req, res) => {
      const comic = req.comic;
      const list = comic[field] || [];
      const idx = list.findIndex((e) => e.id === req.params.entryId);
      if (idx < 0) return res.status(404).json({ error: '条目不存在' });
      if (list[idx].by !== req.user.id) {
        return res.status(403).json({ error: '只能删除自己添加的内容' });
      }
      const [removed] = list.splice(idx, 1);
      if (field === 'covers' && comic.activeCoverId === removed.id) comic.activeCoverId = null;
      if (field === 'aliases' && comic.activeAliasId === removed.id) comic.activeAliasId = null;
      comic.updatedAt = now();
      saveDbSoon();
      res.json({ entries: list });
    });
  }

  /* ------------------------------ 广场 ------------------------------ */

  /* ------------------------------ 广场：分区 ------------------------------ */

  app.get('/api/plaza/boards', (_req, res) => {
    const db = loadDb();
    const boards = PLAZA_BOARDS.map((b) => ({
      ...b,
      count: b.id === 'all'
        ? db.posts.length
        : db.posts.filter((p) => boardOf(p) === b.id).length,
    }));
    res.json({ boards });
  });

  /* ------------------------------ 广场：附件 ------------------------------ */

  app.post('/api/plaza/upload', requireUser, uploadPlaza, async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: '请选择要上传的文件' });
    const attachments = [];
    const rejected = [];
    try {
      await fs.mkdir(PLAZA_DIR, { recursive: true });
      for (const f of files) {
        const ext = String(f.originalname || '').split('.').pop().toLowerCase();
        if (!PLAZA_ALLOWED_EXT.has(ext)) {
          rejected.push(f.originalname);
          await fs.rm(f.path, { force: true }).catch(() => {});
          continue;
        }
        const name = `p_${nanoid(12)}.${ext}`;
        await fs.rename(f.path, path.join(PLAZA_DIR, name)).catch(async () => {
          await fs.copyFile(f.path, path.join(PLAZA_DIR, name));
          await fs.rm(f.path, { force: true });
        });
        attachments.push({
          id: newId('att'),
          kind: mediaKind(f.mimetype, f.originalname),
          name: String(f.originalname || '附件').slice(0, 120),
          url: `/api/plaza/media/${name}`,
          size: Number(f.size) || 0,
          mime: String(f.mimetype || '').slice(0, 100),
        });
      }
    } catch (err) {
      for (const f of files) await fs.rm(f.path, { force: true }).catch(() => {});
      return res.status(500).json({ error: err.message });
    }
    if (!attachments.length) {
      return res.status(400).json({ error: '文件类型不支持（仅图片 / 视频 / 音频 / 常见文档与压缩包）' });
    }
    res.json({ attachments, rejected });
  });

  /** 广场附件公开可读；图片/视频/音频内联展示，其余作为下载。文件名随机且经白名单校验。 */
  app.get('/api/plaza/media/:file', (req, res) => {
    const file = req.params.file;
    if (!safeMediaFile(file)) return res.status(400).json({ error: '非法文件名' });
    const full = path.join(PLAZA_DIR, file);
    const kind = mediaKind('', file);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (kind === 'file') {
      const label = String(req.query.name || '').slice(0, 120);
      res.setHeader('Content-Disposition', label ? attachmentDisposition(label) : 'attachment');
    }
    res.sendFile(full, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '附件不存在' });
    });
  });

  /* ------------------------------ 广场：表情包 ------------------------------ */

  function emojiView(e) {
    return {
      id: e.id,
      name: e.name,
      tags: e.tags || [],
      url: e.url,
      file: String(e.url || '').split('/').pop(),
      by: e.by,
      byName: e.byName || userName(e.by),
      at: e.at,
    };
  }

  app.get('/api/plaza/emojis', (req, res) => {
    const db = loadDb();
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
    let list = db.emojis || [];
    if (q) list = list.filter((e) => `${e.name} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q));
    res.json({ emojis: [...list].reverse().slice(0, 300).map(emojiView) });
  });

  app.post('/api/plaza/emojis', requireUser, async (req, res) => {
    const db = loadDb();
    const name = String(req.body?.name || '').trim().slice(0, 24);
    const url = normalizeMediaUrl(req.body?.url);
    if (!name || !url) return res.status(400).json({ error: '请填写名称并先上传表情包图片' });
    const file = url.split('/').pop();
    if (!safeMediaFile(file) || mediaKind('', file) !== 'image') {
      return res.status(400).json({ error: '表情包只支持图片格式' });
    }
    try {
      await fs.access(path.join(PLAZA_DIR, file));
    } catch {
      return res.status(404).json({ error: '表情包图片不存在，请重新上传' });
    }
    const tags = String(req.body?.tags || '')
      .split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const e = {
      id: newId('emo'), name, tags, url,
      by: req.user.id, byName: req.user.name, at: now(),
    };
    db.emojis = db.emojis || [];
    db.emojis.push(e);
    saveDbSoon();
    res.json({ emoji: emojiView(e) });
  });

  app.delete('/api/plaza/emojis/:id', requireUser, (req, res) => {
    const db = loadDb();
    const idx = (db.emojis || []).findIndex((e) => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '表情包不存在' });
    // 与漫画协作条目一致：只能删除自己添加的那一条，管理员也不豁免
    if (db.emojis[idx].by !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己添加的表情包' });
    }
    db.emojis.splice(idx, 1);
    // 不删磁盘文件：历史帖子里可能还引用着这张图
    saveDbSoon();
    res.json({ ok: true });
  });

  /* ------------------------------ GIF 表情包搜索（Tenor）与收录 ------------------------------ */

  const TENOR_KEY = process.env.CV_TENOR_KEY || 'LIVDSRZULELA'; // Tenor 公开匿名 key
  let gifCache = { q: '', at: 0, items: [] };

  app.get('/api/plaza/emojis/gif', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 40);
    if (!q) return res.json({ gifs: [] });
    if (gifCache.q === q && Date.now() - gifCache.at < 10 * 60 * 1000) {
      return res.json({ gifs: gifCache.items });
    }
    try {
      const r = await fetch(
        `https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=24&media_filter=minimal`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'ComicVault' } },
      );
      if (!r.ok) throw new Error(`Tenor ${r.status}`);
      const d = await r.json();
      const gifs = (d.results || []).map((x) => {
        const gif = x.media?.[0]?.gif || {};
        const preview = x.media?.[0]?.tinygif || gif;
        return {
          id: x.id,
          desc: String(x.content_description || '').slice(0, 40) || q,
          url: gif.url || '',
          preview: preview.url || gif.url || '',
        };
      }).filter((g) => g.url);
      gifCache = { q, at: Date.now(), items: gifs };
      res.json({ gifs });
    } catch (err) {
      res.status(502).json({ error: `GIF 搜索失败：${err.message || err}` });
    }
  });

  /* 把搜索到的 GIF 下载成站内表情包，之后就能像普通表情包一样反复使用 */
  app.post('/api/plaza/emojis/gif', requireUser, async (req, res) => {
    const db = loadDb();
    const gifUrl = String(req.body?.url || '');
    const term = String(req.body?.term || '').trim().slice(0, 20) || 'gif';
    if (!/^https:\/\/[^/]+/.test(gifUrl)) return res.status(400).json({ error: 'GIF 地址不合法' });
    let buf;
    try {
      const r = await fetch(gifUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'Mozilla/5.0 ComicVault', Referer: 'https://tenor.com/' },
      });
      if (!r.ok) throw new Error(`下载失败 (${r.status})`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      return res.status(502).json({ error: `GIF 下载失败：${err.message || err}` });
    }
    if (!buf || buf.length < 100 || buf.subarray(0, 3).toString() !== 'GIF') {
      return res.status(422).json({ error: '下载的内容不是 GIF 图片' });
    }
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'GIF 超过 20MB，换一个吧' });
    const file = `gif_${newId('g')}.gif`;
    await fs.writeFile(path.join(PLAZA_DIR, file), buf);
    const e = {
      id: newId('emo'), name: term, tags: [term],
      url: `/api/plaza/media/${file}`, by: req.user.id, byName: req.user.name, at: now(),
    };
    db.emojis = db.emojis || [];
    db.emojis.push(e);
    saveDbSoon();
    res.json({ emoji: emojiView(e) });
  });

  function postView(p, { withContent = true } = {}) {
    const locked = !!p.visibilityPassHash;
    return {
      id: p.id,
      authorId: p.authorId,
      authorName: p.authorName || userName(p.authorId),
      board: boardOf(p),
      // 密码可见的帖子：未解锁时不下发正文与附件
      content: withContent ? p.content : '',
      locked,
      attachments: withContent ? (Array.isArray(p.attachments) ? p.attachments : []) : [],
      comic: withContent ? (p.comic || null) : null,
      shareUrl: withContent ? (p.shareUrl || null) : null,
      likes: p.likes || [],
      comments: withContent ? (p.comments || []).map((c) => ({
        id: c.id, by: c.by, byName: c.byName || userName(c.by), content: c.content, at: c.at,
      })) : [],
      createdAt: p.createdAt,
    };
  }

  app.get('/api/plaza/posts', (req, res) => {
    const db = loadDb();
    const wanted = typeof req.query.board === 'string' ? req.query.board : 'all';
    const active = PLAZA_BOARDS.some((b) => b.id === wanted) ? wanted : 'all';
    const q = String(req.query.q || '').trim().toLowerCase();
    const all = [...db.posts].sort((a, b) => b.createdAt - a.createdAt);
    const scoped = active === 'all' ? all : all.filter((p) => boardOf(p) === active);
    const matched = q ? scoped.filter((p) => {
      const hay = [
        p.content || '', p.authorName || userName(p.authorId), p.comic?.title || '',
        ...(p.comments || []).map((c) => `${c.byName || ''} ${c.content || ''}`),
        ...(p.attachments || []).map((a) => a.name || ''),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    }) : scoped;
    const boards = PLAZA_BOARDS.map((b) => ({
      ...b,
      count: b.id === 'all' ? all.length : all.filter((p) => boardOf(p) === b.id).length,
    }));
    // 搜索不下发加锁帖子的正文（feed 已处理，这里保持一致）
    res.json({
      posts: matched.slice(0, 100).map((p) => postView(p, { withContent: !p.visibilityPassHash })),
      boards, board: active,
      query: q, count: matched.length,
    });
  });

  app.post('/api/plaza/posts', requireUser, (req, res) => {
    const db = loadDb();
    const content = String(req.body?.content || '').trim().slice(0, 2000);
    // 附件地址统一归一化，不信任客户端，避免把托管 sharecode 写进数据库
    const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
      .slice(0, 12)
      .map((a) => {
        const url = normalizeMediaUrl(a?.url);
        if (!url) return null;
        const name = String(a?.name || '附件').slice(0, 120);
        const kind = ['image', 'video', 'audio', 'file'].includes(a?.kind)
          ? a.kind : mediaKind(a?.mime, name);
        return {
          id: newId('att'), kind, name, url,
          size: Number(a?.size) || 0,
          mime: String(a?.mime || '').slice(0, 100),
        };
      })
      .filter(Boolean);
    if (!content && !req.body?.comicId && !attachments.length) {
      return res.status(400).json({ error: '写点什么，或添加图片 / 文件后再发吧' });
    }
    const board = PLAZA_BOARDS.some((b) => b.id !== 'all' && b.id === req.body?.board)
      ? req.body.board : DEFAULT_BOARD;
    let comicSnap = null;
    let shareUrl = null;
    if (req.body?.comicId) {
      const c = getComic(req.body.comicId);
      if (c) {
        const cover = coverOf(c);
        comicSnap = {
          id: c.id, title: c.title, coverUrl: cover?.url || null,
          chapterCount: (c.chapters || []).length,
        };
        if (c.share?.enabled && c.share.token) shareUrl = `/s/${c.share.token}`;
        else if (c.visibility === 'public' || c.scope === 'community') shareUrl = `/comic/${c.id}`;
      }
    }
    const p = {
      id: newId('post'),
      authorId: req.user.id,
      authorName: req.user.name,
      board,
      content,
      attachments,
      comic: comicSnap,
      shareUrl: req.body?.shareUrl ? String(req.body.shareUrl).slice(0, 500) : shareUrl,
      // 可见方式：'public'（默认，所有人可见）| 'password'（凭密码解锁）
      visibility: req.body?.visibility === 'password' ? 'password' : 'public',
      visibilityPassHash: req.body?.visibility === 'password' && req.body?.password
        ? hashPostPass(req.body.password) : null,
      likes: [],
      comments: [],
      createdAt: now(),
    };
    db.posts.push(p);
    recordActivity(db, 'post', {
      postId: p.id, userId: req.user.id, userName: req.user.name,
      excerpt: content.slice(0, 60),
    });
    saveDbSoon();
    res.json({ post: postView(p) });
  });

  /** 帖子解锁（密码可见）：校验通过后本次会话可读（前端存 localStorage） */
  app.post('/api/plaza/posts/:id/unlock', (req, res) => {
    const p = loadDb().posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '帖子不存在' });
    if (!p.visibilityPassHash) return res.json({ post: postView(p) });
    const pwd = String(req.body?.password || '');
    if (!pwd || hashPostPass(pwd) !== p.visibilityPassHash) {
      return res.status(401).json({ error: '密码不正确' });
    }
    res.json({ post: postView(p) });
  });

  /** 作者改可见方式 / 关闭密码可见 */
  app.post('/api/plaza/posts/:id/visibility', requireUser, (req, res) => {
    const p = loadDb().posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '帖子不存在' });
    if (p.authorId !== req.user.id) return res.status(403).json({ error: '只能修改自己的帖子' });
    if (req.body?.visibility === 'password') {
      const pwd = String(req.body?.password || '');
      if (!pwd) return res.status(400).json({ error: '请填写可见密码' });
      p.visibility = 'password';
      p.visibilityPassHash = hashPostPass(pwd);
    } else {
      p.visibility = 'public';
      p.visibilityPassHash = null;
    }
    saveDbSoon();
    res.json({ post: postView(p) });
  });

  app.post('/api/plaza/posts/:id/like', requireUser, (req, res) => {
    const p = loadDb().posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '帖子不存在' });
    p.likes = p.likes || [];
    const i = p.likes.indexOf(req.user.id);
    if (i >= 0) p.likes.splice(i, 1);
    else p.likes.push(req.user.id);
    saveDbSoon();
    res.json({ post: postView(p) });
  });

  app.post('/api/plaza/posts/:id/comments', requireUser, (req, res) => {
    const p = loadDb().posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '帖子不存在' });
    const content = String(req.body?.content || '').trim().slice(0, 1000);
    if (!content) return res.status(400).json({ error: '评论不能为空' });
    p.comments = p.comments || [];
    p.comments.push({
      id: newId('cm'), by: req.user.id, byName: req.user.name, content, at: now(),
    });
    saveDbSoon();
    res.json({ post: postView(p) });
  });

  app.delete('/api/plaza/posts/:id/comments/:cid', requireUser, (req, res) => {
    const p = loadDb().posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '帖子不存在' });
    const idx = (p.comments || []).findIndex((c) => c.id === req.params.cid);
    if (idx < 0) return res.status(404).json({ error: '评论不存在' });
    if (p.comments[idx].by !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己的评论' });
    }
    p.comments.splice(idx, 1);
    saveDbSoon();
    res.json({ post: postView(p) });
  });

  app.delete('/api/plaza/posts/:id', requireUser, (req, res) => {
    const db = loadDb();
    const idx = db.posts.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '帖子不存在' });
    if (db.posts[idx].authorId !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己发的帖子' });
    }
    db.posts.splice(idx, 1);
    saveDbSoon();
    res.json({ ok: true });
  });
}
