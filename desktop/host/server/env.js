/**
 * 极简 .env 加载器：把项目根目录 .env 里的 KEY=VALUE 注入 process.env。
 *
 * - 不覆盖外部已注入的环境变量（方便测试时用命令行临时指定配置）。
 * - 没有 .env 文件完全正常，此时所有配置走系统环境变量。
 * - .env 已在 .gitignore 中，发信密钥不会进入仓库。
 * - 测试脚本可设 CV_NO_DOTENV=1 跳过文件加载，保证「未配置发信」场景可复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env');

if (process.env.CV_NO_DOTENV !== '1') {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const key = s.slice(0, i).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = s.slice(i + 1).trim();
      if (value.length >= 2 &&
          ((value[0] === '"' && value.at(-1) === '"') ||
           (value[0] === "'" && value.at(-1) === "'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* 没有 .env：正常，使用系统环境变量 */
  }
}
