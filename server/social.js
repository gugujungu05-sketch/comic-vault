import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDb, saveDbSoon, newId, getComic, comicDir, coverOf } from './store.js';

const COOKIE = 'cv_sid';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CODE_MS = 10 * 60 * 1000;

const now = () => Date.now();

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
    createdAt: u.createdAt,
  };
}

function userName(id) {
  return loadDb().users.find((u) => u.id === id)?.name || '已注销用户';
}

function hashPwd(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
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

async function sendCodeEmail(email, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, devCode: code };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'ComicVault <onboarding@resend.dev>',
        to: email,
        subject: 'ComicVault 登录验证码',
        text: `你的登录验证码是 ${code}，10 分钟内有效。若非本人操作请忽略。`,
      }),
    });
    if (!r.ok) return { sent: false, devCode: code, warn: await r.text() };
    return { sent: true };
  } catch {
    return { sent: false, devCode: code };
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerSocial(app, ctx) {
  const { summarize, uploadSingle, extOf, nanoid } = ctx;

  /* ------------------------------ 账号 ------------------------------ */

  app.get('/api/auth/status', (req, res) => {
    const db = loadDb();
    res.json({
      user: publicUser(req.user),
      needsSetup: db.users.length === 0,
      hasUsers: db.users.length,
      codeLogin: { emailEnabled: !!process.env.RESEND_API_KEY, devMode: !process.env.RESEND_API_KEY },
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
    };
    setPassword(u, password);
    db.users.push(u);

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
    const code = String(crypto.randomInt(100000, 1000000));
    db.codes = db.codes.filter((c) => c.expiresAt > now());
    db.codes.push({
      email,
      hash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: now() + CODE_MS,
      attempts: 0,
    });
    saveDbSoon();
    const mail = await sendCodeEmail(email, code);
    res.json({
      ok: true,
      sent: mail.sent,
      // 未配置邮件服务时，前端直接展示验证码，保证功能立即可用
      devCode: mail.devCode || null,
      hint: mail.sent ? '验证码已发送到邮箱' : '未配置邮件服务，已启用开发模式验证码',
    });
  });

  app.post('/api/auth/login-code', (req, res) => {
    const db = loadDb();
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!validEmail(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    const entry = [...db.codes].reverse().find((c) => c.email === email && c.expiresAt > now());
    if (!entry) return res.status(400).json({ error: '验证码已过期，请重新获取' });
    if (entry.attempts >= 5) return res.status(429).json({ error: '尝试次数过多，请重新获取' });
    entry.attempts += 1;
    if (!crypto.timingSafeEqual(
      Buffer.from(crypto.createHash('sha256').update(code).digest('hex'), 'hex'),
      Buffer.from(entry.hash, 'hex'),
    )) {
      saveDbSoon();
      return res.status(401).json({ error: '验证码不正确' });
    }
    db.codes = db.codes.filter((c) => c !== entry);
    let u = db.users.find((x) => x.email === email);
    let created = false;
    if (!u) {
      const first = db.users.length === 0;
      u = {
        id: newId('u'), email, name: email.split('@')[0], bio: '', avatar: '',
        isAdmin: first, createdAt: now(),
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
    const comics = db.comics.filter((c) => c.scope === 'community').map((c) => ({
      ...summarize(c),
      ownerName: userName(c.ownerId),
      createdBy: c.createdBy,
      aliasNames: (c.aliases || []).map((a) => a.value),
      aliases: c.aliases || [],
      covers: c.covers || [],
      tagEntries: c.tagEntries || [],
      activeCoverId: c.activeCoverId || null,
      activeAliasId: c.activeAliasId || null,
      chapters: (c.chapters || []).map((ch) => ({
        id: ch.id, title: ch.title, number: ch.number ?? null,
        pageCount: ch.pages?.length || 0,
        uploadedBy: ch.uploadedBy || null,
        uploadedByName: ch.uploadedBy ? userName(ch.uploadedBy) : '未知',
      })),
    }));
    res.json({ comics });
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

  function postView(p) {
    return {
      id: p.id,
      authorId: p.authorId,
      authorName: p.authorName || userName(p.authorId),
      content: p.content,
      comic: p.comic || null,
      shareUrl: p.shareUrl || null,
      likes: p.likes || [],
      comments: (p.comments || []).map((c) => ({
        id: c.id, by: c.by, byName: c.byName || userName(c.by), content: c.content, at: c.at,
      })),
      createdAt: p.createdAt,
    };
  }

  app.get('/api/plaza/posts', (_req, res) => {
    const db = loadDb();
    res.json({ posts: [...db.posts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(postView) });
  });

  app.post('/api/plaza/posts', requireUser, (req, res) => {
    const db = loadDb();
    const content = String(req.body?.content || '').trim().slice(0, 1000);
    if (!content && !req.body?.comicId) return res.status(400).json({ error: '写点什么再发吧' });
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
      content,
      comic: comicSnap,
      shareUrl: req.body?.shareUrl ? String(req.body.shareUrl).slice(0, 500) : shareUrl,
      likes: [],
      comments: [],
      createdAt: now(),
    };
    db.posts.push(p);
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
    const content = String(req.body?.content || '').trim().slice(0, 500);
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
