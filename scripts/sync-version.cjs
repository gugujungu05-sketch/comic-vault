#!/usr/bin/env node
/**
 * 单一版本源同步器 —— 版本号只写在根目录 version.json，其余文件全部由本脚本生成。
 *
 *   npm run version:sync                  # 把 version.json 同步到全仓库（幂等）
 *   npm run version:sync -- --bump       # 小改动：第 4 段 +1（最常用）
 *   npm run version:sync -- --bump 2     # 一次完整发版：第 3 段 +1，后面归零
 *   npm run version:sync -- --bump 1     # 成体系新功能：第 2 段 +1
 *   npm run version:sync -- --set-web 2.4.0.2
 *   npm run version:sync -- --show       # 只看当前版本，不写文件
 *   npm run version:sync -- --check      # 只检查是否有文件没同步（CI 可用）
 *
 * 四段式 主.次.修.构建：日常小改动只加最后一段，主版本不再频繁跳动。
 * 注意：Electron 的 package.json 必须是合法三段 semver，所以桌面构建号
 * 使用 version.json 的 buildVersion（前三段），应用内显示四段版本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const read = () => JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
const write = (v) => fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + '\n');
const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const first3 = (v) => parts(v).slice(0, 3).join('.');
const first2 = (v) => parts(v).slice(0, 2).join('.');

function bump(v, idx) {
  const p = parts(v);
  while (p.length < 4) p.push(0);
  p[idx] = (p[idx] || 0) + 1;
  for (let i = idx + 1; i < p.length; i += 1) p[i] = 0;
  return p.join('.');
}

let V = read();
let changedVersion = false;

if (opt('--set-web')) { V.web = opt('--set-web'); changedVersion = true; }
if (opt('--set-client')) { V.desktop = V.android = opt('--set-client'); changedVersion = true; }
if (opt('--set-desktop')) { V.desktop = opt('--set-desktop'); changedVersion = true; }
if (opt('--set-android')) { V.android = opt('--set-android'); changedVersion = true; }

if (has('--bump')) {
  let idx = 3;
  const raw = opt('--bump');
  if (raw && /^[0-3]$/.test(raw)) idx = Number(raw);
  V.web = bump(V.web, idx);
  V.desktop = bump(V.desktop, idx);
  V.android = bump(V.android, idx);
  V.build = (Number(V.build) || 0) + 1;
  V.androidVersionCode = (Number(V.androidVersionCode) || 4) + 1;
  V.releasedAt = Date.now();
  changedVersion = true;
}

// 构建号恒等于桌面版本前三段，避免手工维护漂移
V.buildVersion = first3(V.desktop);
if (changedVersion && !V.releasedAt) V.releasedAt = Date.now();

if (has('--show')) {
  console.log('web      =', V.web);
  console.log('desktop  =', V.desktop);
  console.log('android  =', V.android);
  console.log('build    =', V.buildVersion, '(Electron 三段)', '| build #' + V.build, '| versionCode', V.androidVersionCode);
  process.exit(0);
}

if (changedVersion) { write(V); console.log('[version] version.json →', V.web, '/', V.desktop); }

/**
 * 同步规则：正则必须能反复命中（幂等），每项都校验命中次数。
 * 值统一从 V 生成，绝不写死版本号。
 */
const RULES = [
  {
    file: 'desktop/package.json', label: 'Electron 构建版本（三段）',
    re: /^(\s*"version"\s*:\s*")[^"]+(")/m,
    val: () => V.buildVersion,
  },
  {
    file: 'desktop/main.js', label: '桌面主进程显示版本（四段）',
    re: /(const VERSION = ')[^']*(')/,
    val: () => V.desktop,
  },
  {
    file: 'desktop/preload.js', label: '桌面宿主桥版本（四段）',
    re: /(const VERSION = ')[^']*(')/,
    val: () => V.desktop,
  },
  {
    file: 'mobile/src/AndroidManifest.xml', label: 'Android versionName',
    re: /(android:versionName=")[^"]*(")/,
    val: () => V.android,
  },
  {
    file: 'mobile/src/AndroidManifest.xml', label: 'Android versionCode',
    re: /(android:versionCode=")\d+(")/,
    val: () => String(V.androidVersionCode),
  },
  {
    file: 'mobile/src/java/cn/comicvault/app/MainActivity.java', label: 'Android 应用内版本',
    re: /(private static final String APP_VERSION = ")[^"]*(";)/,
    val: () => V.android,
  },
  {
    file: 'mobile/src/java/cn/comicvault/app/MainActivity.java', label: 'Android UA 版本',
    re: /(ComicVaultAndroid\/)[\d.]+/,
    val: () => first2(V.android),
  },
  {
    file: 'mobile/assets/android-bridge.js', label: 'Android 桥版本',
    re: /(version: ')[^']*(',)/,
    val: () => V.android,
  },
  {
    file: 'README.md', label: 'README 版本对照表',
    re: /^\| 版本 \|.*$/m, plain: true,
    val: () => `| 版本 | ${V.web}（随服务器） | ${V.desktop} | ${V.android} |`,
  },
  {
    file: 'README.md', label: 'README 客户端章节标题',
    re: /^## 独立客户端 v[\d.]+（不再是网站套壳）$/m, plain: true,
    val: () => `## 独立客户端 v${first2(V.desktop)}（不再是网站套壳）`,
  },
  {
    file: 'README.md', label: 'README 新增说明标题',
    re: /^\*\*v[\d.]+ 新增（与网站 [\d.]+ 同步）\*\*$/m, plain: true,
    val: () => `**v${first2(V.desktop)} 新增（与网站 ${first3(V.web)} 同步）**`,
  },
];

let fail = 0;
let changed = 0;
for (const r of RULES) {
  const p = path.join(ROOT, r.file);
  if (!fs.existsSync(p)) { console.error(`[version] 缺少文件 ${r.file}`); fail += 1; continue; }
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.match(new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g'));
  if (!hits || hits.length !== 1) {
    console.error(`[version] ${r.label} (${r.file}) 命中 ${hits ? hits.length : 0} 次，应为 1 次`);
    fail += 1;
    continue;
  }
  const out = src.replace(r.re, (...m) => {
    if (r.plain) return r.val();
    const g = m.slice(1, -2); // 捕获组（去掉 match / offset / string）
    return `${g[0] ?? ''}${r.val()}${g[1] ?? ''}`;
  });
  if (out !== src) {
    if (has('--check')) {
      console.error(`[version] 未同步：${r.label} (${r.file})`);
      fail += 1;
    } else {
      fs.writeFileSync(p, out);
      changed += 1;
    }
  }
}

if (fail) {
  console.error(`[version] ${fail} 项异常，请检查`);
  process.exit(1);
}
console.log(`[version] 同步完成：${changed} 个文件有变更，${RULES.length} 项规则全部匹配`);
console.log(`[version] web ${V.web} · desktop ${V.desktop} · android ${V.android} · build ${V.buildVersion}`);
