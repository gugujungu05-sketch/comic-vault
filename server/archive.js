/**
 * RAR / 7z / CBR / CB7 解压：基于 7-Zip WASM（支持 7-Zip CLI 的全部格式）。
 * 前端 zip.js 只认 zip/cbz，剩下的压缩包一律走这里在服务端解压，
 * 避免把几百 MB 解压后的图片再回传给浏览器。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './store.js';

/** 7-Zip 能吃的压缩包格式（含 rar 分卷 r00/r01…、ace、arj、lzh、cab 等） */
export const SEVENZ_RE =
  /\.(7z|rar|cbr|cb7|r\d{2}|zip|cbz|tar|tgz|gz|bz2|xz|ace|arj|lzh|lha|cab|iso)$/i;
/** 只有 7-Zip 能解的（浏览器 zip.js 处理不了，必须交给服务端） */
export const SEVENZ_ONLY_RE = /\.(7z|rar|cbr|cb7|r\d{2}|ace|arj|lzh|lha|cab|iso)$/i;

const WASM_FILE = path.join(ROOT, 'node_modules', '7z-wasm', '7zz.wasm');

let szPromise = null;
let szModule = null;

async function getModule() {
  if (szModule) return szModule;
  if (!szPromise) {
    szPromise = (async () => {
      const mod = await import('7z-wasm');
      const factory = mod.default || mod;
      const wasmBinary = fs.readFileSync(WASM_FILE);
      const m = await factory({
        wasmBinary,
        print: () => {},
        printErr: () => {},
        noExitRuntime: true,
      });
      if (!m?.FS?.mount) throw new Error('7-Zip WASM 初始化失败');
      return m;
    })();
  }
  szModule = await szPromise;
  return szModule;
}

/** 预热：提前编译 wasm，首次解压就不用等 */
export function warmup() {
  return getModule().then(
    () => true,
    (err) => {
      console.warn('[archive] 7-Zip 引擎不可用:', err.message);
      return false;
    },
  );
}

const MOUNT = '/cvfs';
const IN_DIR = '/cvin';

/**
 * 把归档解压到 outDir（真实磁盘目录）。
 * 通过 NODEFS 把 outDir 挂进 wasm 虚拟文件系统，7-Zip 直接落盘，不占内存。
 */
export async function extractWith7z(srcPath, outDir) {
  const sz = await getModule();
  await fsp.mkdir(outDir, { recursive: true });

  if (!fs.existsSync(MOUNT)) {
    try {
      sz.FS.mkdir(MOUNT);
    } catch {
      /* 已存在 */
    }
  }
  try {
    sz.FS.mount(sz.NODEFS, { root: outDir }, MOUNT);
  } catch (err) {
    if (!/already|exist/i.test(String(err?.message))) throw err;
    sz.FS.unmount(MOUNT);
    sz.FS.mount(sz.NODEFS, { root: outDir }, MOUNT);
  }

  const ext = path.extname(srcPath).slice(1).toLowerCase() || '7z';
  const inName = `input.${ext}`;
  const inPath = `${IN_DIR}/${inName}`;
  try {
    sz.FS.mkdir(IN_DIR);
  } catch {
    /* 已存在 */
  }

  return (async () => {
    const data = await fsp.readFile(srcPath);
    const stream = sz.FS.open(inPath, 'w+');
    sz.FS.write(stream, data, 0, data.length);
    sz.FS.close(stream);
    sz.FS.chdir('/');
    try {
      sz.callMain(['x', '-y', inPath, `-o${MOUNT}`]);
    } catch (err) {
      // 部分情况下 7-Zip 以非 0 状态退出，只要解出了内容就当作成功
      if (!String(err?.message || '').includes('unwind')) console.warn('[archive] callMain:', err?.message);
    }
  })()
    .catch((err) => {
      throw new Error('解压失败: ' + (err?.message || err));
    })
    .finally(async () => {
      try {
        sz.FS.unlink(inPath);
      } catch {
        /* ignore */
      }
      try {
        sz.FS.unmount(MOUNT);
      } catch {
        /* ignore */
      }
    });
}

/** 引擎可用性（启动预热后用于 /api/stats 展示） */
export async function engineStatus() {
  try {
    await getModule();
    return { available: true, formats: ['7z', 'rar', 'cbr', 'cb7', 'zip', 'tar', 'gz', 'ace', 'arj', 'lzh', 'cab', 'iso'] };
  } catch (err) {
    return { available: false, error: err.message };
  }
}
