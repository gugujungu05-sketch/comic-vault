#!/usr/bin/env node
/**
 * 一键发版 / 网站自动更新安装包
 *
 *   npm run release                    扫描成品 → 复制 → 算 sha256 → 生成清单
 *   npm run release -- --dry-run       只看会做什么，不写文件
 *   npm run release -- --apk-only      只更新 APK（其余条目沿用现有清单）
 *   npm run release -- --manifest-only 不碰本地成品，只生成公开镜像清单（GitHub Actions 用）
 *
 * 产物：
 *   data/release.json          服务端热读清单（mtime 变化即生效，无需重启）
 *   docs/release.json          Pages 公开镜像
 *   dist-pages/release.json    Pages 部署目录内的同一份公开镜像
 *
 * 约定：包 id 必须与 server/discovery.js 的 SOFTWARE_TEMPLATE 一致，
 * 文件名带完整版本号（ComicVault-<版本>-<平台>-<架构>.<后缀>），
 * 不带任何「合集包 / 绿色版」——按平台与架构分文件是用户明确要求。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const INSTALLERS = path.join(ROOT, 'data', 'installers');
const ASSETS = path.join(WORKSPACE, 'release-assets');
const DATA_RELEASE = path.join(ROOT, 'data', 'release.json');
const DOCS_RELEASE = path.join(ROOT, 'docs', 'release.json');
const PAGES_RELEASE = path.join(ROOT, 'dist-pages', 'release.json');

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const DRY = has('--dry-run');
const MANIFEST_ONLY = has('--manifest-only');
const APK_ONLY = has('--apk-only');

const V = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
const now = Date.now();
const TAG = `v${V.desktop}`;
const RELEASE_DOWNLOAD_BASE = 'https://github.com/gugujungu05-sketch/comic-vault/releases/download';
/** GitHub Release 资产直链；releases/latest 是网页，绝不能当下载地址 */
const publicUrl = (file) => `${RELEASE_DOWNLOAD_BASE}/${TAG}/${encodeURIComponent(file)}`;

const SOURCES = [
  { id: 'windows-x64-setup', platform: 'win', arch: 'x64',
    file: `ComicVault-${V.desktop}-windows-x64-setup.exe` },
  { id: 'windows-x64-portable', platform: 'win', arch: 'x64',
    file: `ComicVault-${V.desktop}-windows-x64-portable.exe` },
  { id: 'linux-x64', platform: 'linux', arch: 'x64',
    file: `ComicVault-${V.desktop}-linux-x64.AppImage` },
  { id: 'android-apk', platform: 'android', arch: 'universal',
    file: `ComicVault-${V.android}-android.apk`,
    legacy: ['ComicVault-android.apk', path.join(WORKSPACE, '漫画库-Android.apk')] },
];

function log(...a) { console.log('[release]', ...a); }
function human(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function existingPackages() {
  try {
    return Object.fromEntries(
      (JSON.parse(fs.readFileSync(DATA_RELEASE, 'utf8')).packages || []).map((p) => [p.id, p]),
    );
  } catch { return {}; }
}
function candidates(s) {
  const list = [path.join(ASSETS, s.file), path.join(INSTALLERS, s.file)];
  for (const l of s.legacy || []) {
    list.push(path.isAbsolute(l) ? l : path.join(ROOT, 'public', 'files', l));
  }
  return list;
}
function resolveSource(s) {
  for (const c of candidates(s)) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 不存在 */ }
  }
  return null;
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

/** 公开镜像：Pages 上没有安装包实体，直链一律指向 GitHub Release 资产文件 */
function mirrorOf(rel) {
  return {
    ...rel,
    mirror: true,
    note: '公开镜像，安装包直链指向 GitHub Release 资产文件',
    packages: rel.packages.map((p) => ({
      ...p, local: false, url: publicUrl(p.file),
    })),
  };
}

function writeOutputs(rel) {
  const mirror = mirrorOf(rel);
  fs.mkdirSync(path.dirname(DATA_RELEASE), { recursive: true });
  fs.mkdirSync(path.dirname(DOCS_RELEASE), { recursive: true });
  fs.mkdirSync(path.dirname(PAGES_RELEASE), { recursive: true });
  // CI 的 --manifest-only 只写公开镜像，不能覆盖服务端正在热读的本地直链清单
  if (!MANIFEST_ONLY) fs.writeFileSync(DATA_RELEASE, JSON.stringify(rel, null, 2) + '\n');
  fs.writeFileSync(DOCS_RELEASE, JSON.stringify(mirror, null, 2) + '\n');
  fs.writeFileSync(PAGES_RELEASE, JSON.stringify(mirror, null, 2) + '\n');
  if (!MANIFEST_ONLY) {
    V.releasedAt = rel.releasedAt;
    fs.writeFileSync(VERSION_FILE, JSON.stringify(V, null, 2) + '\n');
  }
}

async function main() {
  log(`版本 web ${V.web} · desktop ${V.desktop} · android ${V.android} · build #${V.build}`);
  if (!DRY && !MANIFEST_ONLY) fs.mkdirSync(INSTALLERS, { recursive: true });

  if (MANIFEST_ONLY) {
    const pkgs = SOURCES.map((s) => ({
      id: s.id, platform: s.platform, arch: s.arch, file: s.file,
      sizeBytes: null, sha256: null, local: false,
      url: publicUrl(s.file), updatedAt: now,
    }));
    if (!DRY) writeOutputs(baseRelease(pkgs));
    log('公开镜像清单已生成（未触碰本地成品）');
    return;
  }

  const prior = existingPackages();
  const packages = [];
  for (const s of SOURCES) {
    if (APK_ONLY && s.id !== 'android-apk') {
      if (prior[s.id]) { packages.push(prior[s.id]); log(`${s.id} 沿用现有清单`); }
      continue;
    }
    const src = resolveSource(s);
    if (!src) {
      log(`未找到 ${s.id} 成品，清单回落到 GitHub Release 资产直链`);
      const p = prior[s.id];
      packages.push(p ? { ...p, platform: s.platform, arch: s.arch, file: s.file }
        : { id: s.id, platform: s.platform, arch: s.arch, file: s.file,
            sizeBytes: null, sha256: null, local: false, url: publicUrl(s.file), updatedAt: null });
      continue;
    }
    const dest = path.join(INSTALLERS, s.file);
    if (!DRY && path.resolve(src) !== path.resolve(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const stat = fs.statSync(src);
    packages.push({
      id: s.id, platform: s.platform, arch: s.arch, file: s.file,
      sizeBytes: stat.size,
      sha256: DRY ? null : sha256(src),
      local: true,
      url: `/files/${encodeURIComponent(s.file)}`,
      updatedAt: Math.round(stat.mtimeMs),
    });
    log(`${s.id} ← ${path.basename(src)} (${human(stat.size)})`);
  }

  const rel = baseRelease(packages);
  if (!DRY) writeOutputs(rel);

  console.log('\n=== 本次发版清单 ===');
  for (const p of rel.packages) {
    console.log(`  ${p.local ? '●' : '○'} ${p.id.padEnd(22)} ${String(p.sizeBytes ? human(p.sizeBytes) : '—').padStart(10)}  ${p.file}`);
  }
  console.log(`  共 ${rel.packages.length} 项，本地直链 ${rel.packages.filter((p) => p.local).length} 项`);
  if (!DRY) log('网站 /api/software 立即读到新清单（服务端无需重启）');
}

main().catch((e) => { console.error('[release] 失败：', e.message); process.exit(1); });
