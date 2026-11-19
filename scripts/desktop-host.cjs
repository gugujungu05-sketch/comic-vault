'use strict';
/**
 * 组装桌面端内置服务器 desktop/host/
 * 结构：host/server/*.js（服务端源码）+ host/package.json + host/node_modules（纯 JS 依赖）
 * Electron 主进程以 ELECTRON_RUN_AS_NODE 子进程方式运行它，端口随机、数据目录在 userData。
 * 用法：node scripts/desktop-host.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = path.join(ROOT, 'desktop', 'host');

// sharp 是原生模块（Electron 下需另编译），服务端已做无 sharp 降级，这里不打包
const DEPS = {
  express: '^4.21.2',
  multer: '^2.0.1',
  cheerio: '^1.2.0',
  nanoid: '^5.0.9',
  archiver: '^7.0.1',
  'pdf-lib': '^1.17.1',
  nodemailer: '^10.3.1',
  '7z-wasm': '^1.2.0',
  'iconv-lite': '^0.6.3',
  // AI 翻译底图修补/原位渲染需要图像画布。@napi-rs/canvas 是纯 N-API（跨 Node/Electron ABI 稳定），
  // 有各平台预编译二进制，不需要本地编译。见下方多平台二进制打包逻辑。
  '@napi-rs/canvas': '1.1.0',
};

fs.rmSync(HOST, { recursive: true, force: true });
fs.mkdirSync(path.join(HOST, 'server'), { recursive: true });

for (const f of fs.readdirSync(path.join(ROOT, 'server'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'server', f), path.join(HOST, 'server', f));
}
// 在线书源脚本目录（js-sources.js 引擎按此目录加载 Ciallo 书源），必须整目录带上
const JS_SRC = path.join(ROOT, 'server', 'js-sources');
if (fs.existsSync(JS_SRC)) fs.cpSync(JS_SRC, path.join(HOST, 'server', 'js-sources'), { recursive: true });
// 服务端启动读取的版本源与发版清单（软件内检查更新用）
fs.copyFileSync(path.join(ROOT, 'version.json'), path.join(HOST, 'version.json'));
for (const rel of ['data/release.json', 'docs/release.json']) {
  const src = path.join(ROOT, rel);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.join(HOST, rel, '..'), { recursive: true });
    fs.copyFileSync(src, path.join(HOST, rel));
  }
}
fs.writeFileSync(path.join(HOST, 'package.json'), JSON.stringify({
  name: 'comic-vault-host', private: true, type: 'module', version: '1.0.0',
  description: 'ComicVault 内置本地服务（桌面端随包运行）',
  dependencies: DEPS,
}, null, 2));

console.log('[desktop-host] 安装依赖（npmmirror）…');
execSync('npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com', {
  cwd: HOST, stdio: 'inherit',
});

/* npm 只装当前构建机的平台二进制；桌面包要同时支持 Windows/Linux，
   这里把两平台的 canvas .node 都下载并放进对应平台包目录，让翻译在本机模式也可用。 */
const MODULES_DIR = path.join(HOST, 'node_modules');
const CANVAS_VER = '1.1.0';
const PLATFORM_PKGS = [
  ['@napi-rs/canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node'],
  ['@napi-rs/canvas-win32-x64-gnu', 'skia.win32-x64-gnu.node'],
  ['@napi-rs/canvas-linux-x64-gnu', 'skia.linux-x64-gnu.node'],
  ['@napi-rs/canvas-linux-x64-musl', 'skia.linux-x64-musl.node'],
  ['@napi-rs/canvas-darwin-x64', 'skia.darwin-x64.node'],
  ['@napi-rs/canvas-darwin-arm64', 'skia.darwin-arm64.node'],
  ['@napi-rs/canvas-win32-arm64-msvc', 'skia.win32-arm64-msvc.node'],
  ['@napi-rs/canvas-linux-arm64-gnu', 'skia.linux-arm64-gnu.node'],
];
const TMP = path.join(HOST, '.napi-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const [pkg, binName] of PLATFORM_PKGS) {
  // pkg 形如 @napi-rs/canvas-win32-x64-msvc，直接落在 node_modules 下即被 require 解析到
  const dest = path.join(MODULES_DIR, pkg);
  if (fs.existsSync(path.join(dest, binName))) { console.log('[desktop-host] 已有:', binName); continue; }
  try {
    execSync(`npm pack ${pkg}@${CANVAS_VER} --registry=https://registry.npmmirror.com --silent`, {
      cwd: TMP, stdio: 'pipe',
    });
    const tgz = fs.readdirSync(TMP).find((f) => f.endsWith('.tgz'));
    if (!tgz) { console.warn('[desktop-host] 下载失败:', pkg); continue; }
    fs.mkdirSync(dest, { recursive: true });
    // 平台二进制包内是 package/<binName> 与 package/package.json
    execSync(`tar -xzf "${path.join(TMP, tgz)}" -C "${dest}" --strip-components=1`, { stdio: 'pipe' });
    fs.rmSync(path.join(TMP, tgz), { force: true });
    console.log('[desktop-host] 打包平台二进制:', binName);
  } catch (e) {
    console.warn('[desktop-host] 跳过平台二进制:', pkg, e.message.slice(0, 80));
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log('[desktop-host] 完成:', HOST);
