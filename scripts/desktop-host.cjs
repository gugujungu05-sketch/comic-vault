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
};

fs.rmSync(HOST, { recursive: true, force: true });
fs.mkdirSync(path.join(HOST, 'server'), { recursive: true });

for (const f of fs.readdirSync(path.join(ROOT, 'server'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'server', f), path.join(HOST, 'server', f));
}
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
console.log('[desktop-host] 完成:', HOST);
