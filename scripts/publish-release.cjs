#!/usr/bin/env node
/**
 * 一键发版 / 网站自动更新安装包
 *
 *   npm run release                  # 扫描成品 → 复制 → 算 sha256 → 生成清单 → 重建合集
 *   npm run release -- --dry-run     # 只看会做什么，不写文件
 *   npm run release -- --apk-only    # 只更新 APK（改手机端后最快路径）
 *   npm run release -- --no-bundle  # 不重建几百 MB 的合集 zip
 *   npm run release -- --manifest-only  # 不碰本地成品，只生成公开清单（GitHub Actions 用）
 *
 * 产物：
 *   data/installers/*          最新安装包（不进 Git），服务端挂到 /files/ 直接下载
 *   data/release.json          服务端热读清单（mtime 变化即生效，无需重启）
 *   docs/release.json          Pages 公开镜像，供入口页 / 外部展示
 *   version.json              更新 releasedAt
 *
 * 发版前先跑：npm run version:bump && 打包两端 && npm run build
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const INSTALLERS = path.join(ROOT, 'data', 'installers');
const DATA_RELEASE = path.join(ROOT, 'data', 'release.json');
const DOCS_RELEASE = path.join(ROOT, 'docs', 'release.json');
const RELEASE_DIR = path.join(ROOT, 'desktop', 'release');

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const DRY = has('--dry-run');
const MANIFEST_ONLY = has('--manifest-only');
const APK_ONLY = has('--apk-only');
const NO_BUNDLE = has('--no-bundle');

const V = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
const now = Date.now();

function log(...a) { console.log('[release]', ...a); }
function human(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}
function newest(pattern, dir) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const n of fs.readdirSync(dir)) {
    if (!pattern.test(n)) continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: p, file: n, mtime: st.mtimeMs };
  }
  return best;
}
function copy(src, dest) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
function zipDir(cwd, out) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('zip', ['-q', '-r', out, '.'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zip 失败：' + (r.stderr || r.stdout || '').slice(0, 200));
}

/** 待发布成品：源候选、目标文件名、是否参与合集 */
const appImageName = `漫画库 ComicVault-${V.buildVersion}.AppImage`;
const SOURCES = [
  {
    id: 'windows-portable', file: '漫画库-便携版.exe', bundle: true,
    candidates: [path.join(RELEASE_DIR, '漫画库-便携版.exe'), path.join(WORKSPACE, '漫画库-便携版.exe')],
  },
  {
    id: 'windows-green', file: '漫画库-Windows绿色版.zip', bundle: true,
    candidates: [path.join(WORKSPACE, '漫画库-Windows绿色版.zip'), path.join(INSTALLERS, '漫画库-Windows绿色版.zip')],
  },
  {
    id: 'linux-appimage', file: appImageName, bundle: true,
    candidates: [path.join(RELEASE_DIR, appImageName), path.join(WORKSPACE, appImageName)],
    fallbackDir: RELEASE_DIR, fallbackPattern: /\.AppImage$/,
  },
  {
    id: 'android-apk', file: 'ComicVault-android.apk', bundle: true,
    bundleName: '漫画库-Android.apk',
    candidates: [
      path.join(ROOT, 'public', 'files', 'ComicVault-android.apk'),
      path.join(WORKSPACE, '漫画库-Android.apk'),
    ],
  },
  {
    id: 'zip-bundle', file: '漫画库-安装包合集.zip', bundle: false,
    candidates: [path.join(WORKSPACE, '漫画库-安装包合集.zip')],
  },
];

function resolveSource(item) {
  for (const c of item.candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 不存在 */ }
  }
  return null;
}

/** Windows 绿色版：没有现成 zip 时用 win-unpacked 现场打包 */
function ensureGreenZip() {
  const dest = path.join(INSTALLERS, '漫画库-Windows绿色版.zip');
  const unpacked = path.join(RELEASE_DIR, 'win-unpacked');
  if (resolveSource(SOURCES[1])) return;
  if (!fs.existsSync(unpacked)) { log('绿色版：未找到 win-unpacked，跳过'); return; }
  log('绿色版：从 win-unpacked 重新打包');
  zipDir(unpacked, dest);
  if (!DRY) fs.copyFileSync(dest, path.join(WORKSPACE, '漫画库-Windows绿色版.zip'));
}

/** 安装说明随版本自动生成，避免每次手写 */
function bundleReadme() {
  const d = new Date(now).toLocaleDateString('zh-CN');
  return `漫画库 ComicVault · 安装包合集
============================================================
版本：桌面 v${V.desktop} / Android v${V.android} / 网站 v${V.web}
构建：#${V.build} · 打包日期：${d}
版本号为四段式「主.次.修.构建」，小改动只加最后一段。

【本次更新】
------------------------------------------------------------
${(V.notes.desktop || []).map((n) => '· ' + n).join('\n')}

【重要说明：网站与软件是两套界面】
------------------------------------------------------------
· 桌面 / Android 客户端是独立界面，不加载网站页面。
  它们只通过 /api 与服务器交换数据，账号、漫画、进度实时互通。
· 网站下载页的安装包清单由 npm run release 自动更新，
  服务端无需重启；清单里的体积与 SHA256 是真实计算值。

【文件说明】
------------------------------------------------------------
漫画库-便携版.exe                  Windows 单文件，双击即用
漫画库-Windows绿色版.zip           Windows 解压即用
${appImageName}   Linux x64，chmod +x 后运行
漫画库-Android.apk                 Android 6.0+，允许未知来源安装

【安装与登录】
------------------------------------------------------------
1. Windows 双击 exe / 解压 zip；Linux chmod +x AppImage；Android 装 APK。
2. 首次打开在设置里确认服务器地址（默认已填线上地址）。
3. 用与网站相同的邮箱账号登录，三个端共用同一份数据。

【导入漫画】
------------------------------------------------------------
桌面：把图片 / 文件夹拖进窗口，或点「导入图片」。
手机：点「多选导入」，可在系统文件选择器里进入
      「使用漫画页面」(Kotatsu 等) 一次多选。
两端都会先显示章节页式网格，勾选页、调整顺序再导入。

【阅读】
------------------------------------------------------------
单页 / 双页 / 连读 / 条漫 四种模式，上一话 / 下一话，
目录、页面缩略图、滤镜、缩放。条漫适合长条竖图。

【检查更新】
------------------------------------------------------------
设置 → 检查更新；网页 / PWA 刷新即最新。
发现新版本时到网站「软件下载」页获取最新安装包。

【注意】
------------------------------------------------------------
· 软件不保存漫画，数据都在服务器上。
· APK 为自签名，覆盖安装需使用同一签名密钥。
· 请只导入你拥有合法权利的漫画资源。
`;
}

/** 重建合集 zip：用刚刚同步到 installers 的最新成品 */
function rebuildBundle(items) {
  if (NO_BUNDLE || APK_ONLY) return;
  const tmp = path.join('/tmp', `cv-bundle-${process.pid}`);
  if (!DRY) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const it of items) {
      if (!it.bundle || !it.local) continue;
      const src = path.join(INSTALLERS, it.file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, it.bundleName || it.file));
    }
    fs.writeFileSync(path.join(tmp, '安装说明.txt'), bundleReadme());
  }
  const out = path.join(WORKSPACE, '漫画库-安装包合集.zip');
  log('重建安装包合集');
  zipDir(tmp, out);
  if (!DRY) {
    fs.copyFileSync(out, path.join(INSTALLERS, '漫画库-安装包合集.zip'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  log(`版本 web ${V.web} · desktop ${V.desktop} · android ${V.android} · build #${V.build}`);
  if (!DRY) fs.mkdirSync(INSTALLERS, { recursive: true });

  if (MANIFEST_ONLY) {
    // CI / Pages 用：没有本地成品，只输出公开清单
    const pkgs = SOURCES.map((s) => ({
      id: s.id, file: s.file, sizeBytes: null, sha256: null,
      local: false, url: V.driveZipUrl, updatedAt: now,
    }));
    const rel = baseRelease(pkgs);
    if (!DRY) writeAll(rel);
    log('公开清单已生成（manifest-only，未复制成品）');
    return;
  }

  if (!APK_ONLY) ensureGreenZip();

  // 1. 同步单件成品
  const items = [];
  for (const s of SOURCES) {
    if (APK_ONLY && s.id !== 'android-apk' && s.id !== 'zip-bundle') continue;
    if (s.id === 'zip-bundle') continue; // 合集最后统一处理
    let src = resolveSource(s);
    let actualFile = s.file;
    if (!src && s.fallbackDir) {
      const f = newest(s.fallbackPattern, s.fallbackDir);
      if (f) { src = f.path; actualFile = f.file; }
    }
    if (!src) { log(`未找到 ${s.id} 的成品，清单将回落到资料库链接`); continue; }
    const dest = path.join(INSTALLERS, actualFile);
    copy(src, dest);
    items.push({ ...s, file: actualFile, src, local: true });
    log(`${s.id} ← ${path.basename(src)} (${human(fs.statSync(src).size)})`);
  }

  // 2. 重建合集
  rebuildBundle(items);

  // 3. 把合集纳入清单
  const bundleSrc = path.join(WORKSPACE, '漫画库-安装包合集.zip');
  if (fs.existsSync(bundleSrc)) {
    items.push({ ...SOURCES.find((s) => s.id === 'zip-bundle'), src: bundleSrc, local: true });
  }

  // 4. 算真实体积与校验和
  const packages = [];
  for (const it of items) {
    const target = path.join(INSTALLERS, it.file);
    const stat = fs.existsSync(target) ? fs.statSync(target) : fs.statSync(it.src);
    packages.push({
      id: it.id,
      file: it.file,
      sizeBytes: stat.size,
      sha256: DRY ? null : await sha256(fs.existsSync(target) ? target : it.src),
      local: true,
      url: `/files/${encodeURIComponent(it.file)}`,
      updatedAt: Math.round(stat.mtimeMs),
    });
  }
  // 未找到成品的条目也列出，指向资料库
  for (const s of SOURCES) {
    if (packages.some((p) => p.id === s.id)) continue;
    packages.push({
      id: s.id, file: s.file, sizeBytes: null, sha256: null,
      local: false, url: V.driveZipUrl, updatedAt: null,
    });
  }
  packages.sort((a, b) => SOURCES.findIndex((s) => s.id === a.id) - SOURCES.findIndex((s) => s.id === b.id));

  const rel = baseRelease(packages);
  if (!DRY) writeAll(rel);

  console.log('\n=== 本次发版清单 ===');
  for (const p of rel.packages) {
    console.log(`  ${p.local ? '●' : '○'} ${p.id.padEnd(18)} ${String(p.sizeBytes ? human(p.sizeBytes) : '—').padStart(10)}  ${p.file}`);
  }
  console.log(`  共 ${rel.packages.length} 项，本地直链 ${rel.packages.filter((p) => p.local).length} 项`);
  console.log(`  发布时间 ${new Date(rel.releasedAt).toLocaleString('zh-CN')}`);
  if (!DRY) console.log('  网站 /api/software 会立即读到新清单（无需重启服务）');
}

function baseRelease(packages) {
  return {
    schema: 1,
    version: V.desktop,
    webVersion: V.web,
    versions: { web: V.web, desktop: V.desktop, android: V.android },
    buildVersion: V.buildVersion,
    build: V.build,
    releasedAt: V.releasedAt || now,
    generatedAt: now,
    driveUrl: V.driveZipUrl,
    versionRule: V.versionRule || null,
    packages,
  };
}

function writeAll(rel) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(DATA_RELEASE, JSON.stringify(rel, null, 2) + '\n');
  // Pages 公开镜像：不含本地直链（Pages 上没有安装包文件）
  const mirror = {
    ...rel,
    mirror: true,
    driveUrl: 'https://github.com/gugujungu05-sketch/comic-vault/releases/latest',
    note: '公开镜像，安装包直链指向 GitHub Releases',
    packages: rel.packages.map((p) => ({ ...p, local: false, url: p.id === 'pwa' ? '/' : V.driveZipUrl })),
  };
  fs.writeFileSync(DOCS_RELEASE, JSON.stringify(mirror, null, 2) + '\n');
  V.releasedAt = rel.releasedAt;
  fs.writeFileSync(VERSION_FILE, JSON.stringify(V, null, 2) + '\n');
}

main().catch((e) => { console.error('[release] 失败：', e.message); process.exit(1); });
