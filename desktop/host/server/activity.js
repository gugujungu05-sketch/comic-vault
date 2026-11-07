/**
 * 站内动态与公共书库上传记录的统一写入口。
 *
 * 写入点分布在 index.js（漫画 / 章节 / 页面 / 导入 / 导出）与
 * social.js（广场发帖、发布到公共书库）里；这里只负责生成规范化记录，
 * 查询与展示交给 discovery.js。
 */
import { newId } from './store.js';

/** 两类记录各保留最近 400 条，避免 db.json 无限膨胀 */
const KEEP = 400;

const now = () => Date.now();

function push(db, key, item) {
  db[key] = Array.isArray(db[key]) ? db[key] : [];
  db[key].push(item);
  if (db[key].length > KEEP) db[key].splice(0, db[key].length - KEEP);
  return item;
}

/**
 * type: comic | chapter | pages | post | announcement | import | publish
 * payload 常用字段：comicId, comicTitle, chapterId, chapterTitle,
 *                   userId, userName, scope, count, link
 */
export function recordActivity(db, type, payload = {}) {
  return push(db, 'activities', {
    id: newId('act'),
    type,
    at: now(),
    ...payload,
  });
}

/**
 * 公共书库上传记录：谁、在什么时候、往哪本漫画、加了哪一话、多少页。
 * 同时生成一条动态，主页动态流不必再单独扫一遍章节。
 */
export function recordUpload(db, info = {}) {
  const item = push(db, 'uploads', {
    id: newId('up'),
    at: now(),
    comicId: info.comicId || null,
    comicTitle: info.comicTitle || '',
    chapterId: info.chapterId || null,
    chapterTitle: info.chapterTitle || '',
    userId: info.userId || null,
    userName: info.userName || '匿名用户',
    kind: info.kind || 'chapter',
    count: Number(info.count) || 0,
  });
  recordActivity(db, info.kind === 'comic' ? 'comic' : 'upload', {
    comicId: item.comicId,
    comicTitle: item.comicTitle,
    chapterId: item.chapterId,
    chapterTitle: item.chapterTitle,
    userId: item.userId,
    userName: item.userName,
    scope: 'community',
    count: item.count,
  });
  return item;
}

/**
 * 首次启用动态流时，用已有漫画 / 帖子回填一批历史事件，
 * 避免升级后主页动态一片空白（线上已有数据可直接看到内容）。
 */
export function backfillActivities(db) {
  db.activities = Array.isArray(db.activities) ? db.activities : [];
  db.uploads = Array.isArray(db.uploads) ? db.uploads : [];
  if (db.activities.length || db.meta?.activitiesBackfilled) return;
  for (const c of db.comics) {
    if (c.scope !== 'community') continue;
    push(db, 'activities', {
      id: newId('act'),
      type: 'comic',
      at: c.createdAt || now(),
      comicId: c.id,
      comicTitle: c.title,
      userName: db.users.find((u) => u.id === c.createdBy)?.name || '书库贡献者',
      scope: 'community',
    });
    for (const ch of c.chapters || []) {
      push(db, 'uploads', {
        id: newId('up'),
        at: ch.createdAt || c.updatedAt || now(),
        comicId: c.id,
        comicTitle: c.title,
        chapterId: ch.id,
        chapterTitle: ch.title,
        userId: ch.uploadedBy || c.createdBy || null,
        userName: db.users.find((u) => u.id === (ch.uploadedBy || c.createdBy))?.name || '书库贡献者',
        kind: 'chapter',
        count: ch.pages?.length || 0,
      });
    }
  }
  for (const p of db.posts) {
    push(db, 'activities', {
      id: newId('act'),
      type: 'post',
      at: p.createdAt || now(),
      postId: p.id,
      userId: p.authorId,
      userName: p.authorName,
      excerpt: String(p.content || '').slice(0, 60),
    });
  }
  db.meta = db.meta && typeof db.meta === 'object' ? db.meta : {};
  db.meta.activitiesBackfilled = true;
}
