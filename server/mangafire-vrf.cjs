/**
 * MangaFire VRF 桥接：管理常驻 Python Playwright 子进程，生成站点 API 所需的 vrf。
 * - 磁盘缓存：vrf 长期有效，按 (action,value,page) 缓存 7 天，缓存命中零开销
 * - 子进程复用：浏览器只启动一次，跨请求复用；空闲 5 分钟自动退出，下次按需拉起
 * - 并发串行：Python 侧单浏览器，Node 侧用 promise 队列串行化
 * - 容错：请求超时/进程崩溃自动丢弃并重启
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PY = path.join(__dirname, 'mangafire-vrf.py');
const CACHE_FILE = path.join(process.env.CV_DATA_DIR || path.join(__dirname, '..', 'data'), 'mangafire-vrf-cache.json');
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const REQ_TIMEOUT = 70000;
const IDLE_EXIT = 5 * 60 * 1000;

let child = null;
let queue = Promise.resolve();
let pending = new Map(); // id -> {resolve,reject,timer}
let seq = 0;
let idleTimer = null;
let cache = null;
let envChecked = null; // null=未检查, true=可用, Error=不可用
let lastErrorAt = 0;

/** 预检 python3 + playwright 是否可用（桌面端打包环境通常没有，避免每次等 70s 超时）。
 *  结果缓存 5 分钟；缓存命中时无需再检查。 */
function checkEnv() {
  if (envChecked instanceof Error && Date.now() - lastErrorAt < 5 * 60 * 1000) throw envChecked;
  if (envChecked === true) return;
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('python3', ['-c', 'import playwright.async_api'], { timeout: 8000 });
  if (probe.status !== 0) {
    envChecked = new Error('MangaFire 源需要服务端 Python 浏览器组件（云端可用，桌面端暂不支持）');
    lastErrorAt = Date.now();
    throw envChecked;
  }
  envChecked = true;
}

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch { /* 忽略写盘失败 */ }
}
function cacheKey(action, value, page) { return `${action}|${value}|${page || 1}`; }

function ensureChild() {
  if (child && child.exitCode === null) return child;
  child = spawn('python3', ['-u', PY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id;
      const p = pending.get(id);
      if (!p) continue;
      clearTimeout(p.timer); pending.delete(id);
      if (msg.ok) p.resolve(msg.url);
      else p.reject(new Error(msg.error || 'VRF 生成失败'));
    }
  });
  child.stderr.on('data', () => { /* 吞掉 python stderr，避免噪音 */ });
  child.on('exit', () => {
    child = null;
    // 进程异常退出时拒绝所有在途请求
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('VRF 服务已退出')); }
    pending.clear();
  });
  armIdle();
  return child;
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (child && child.exitCode === null) { try { child.kill(); } catch {} }
    child = null; idleTimer = null;
  }, IDLE_EXIT);
  if (idleTimer.unref) idleTimer.unref();
}

function callPython(action, value, page) {
  ensureChild();
  if (idleTimer) clearTimeout(idleTimer); // 忙时不触发空闲退出
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      if (child && child.exitCode === null) { try { child.kill(); } catch {} }
      child = null;
      reject(new Error('VRF 生成超时'));
    }, REQ_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, action, value, page }) + '\n');
    armIdle();
  });
}

/** 生成带 vrf 的 API 路径（形如 /api/titles?keyword=...&vrf=...） */
async function generate(action, value, page) {
  const key = cacheKey(action, value, page);
  const c = loadCache();
  const hit = c[key];
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.url;
  checkEnv(); // 环境不可用快速失败
  // 串行化：Python 侧是单浏览器
  const run = queue.then(() => callPython(action, value, page));
  queue = run.catch(() => {});
  const url = await run;
  c[key] = { t: Date.now(), url };
  saveCache();
  return url;
}

module.exports = { generate };
