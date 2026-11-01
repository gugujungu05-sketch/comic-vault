import fs from 'node:fs';
import path from 'node:path';
const mod = await import('7z-wasm');
const factory = mod.default ?? mod;
console.log('factory type:', typeof factory);
const wasmBinary = fs.readFileSync(path.resolve('node_modules/7z-wasm/7zz.wasm'));
const sz = await factory({ wasmBinary, print: () => {}, printErr: (s) => { if (String(s).length<200) {} }, noExitRuntime: true });
console.log('module keys:', Object.keys(sz).slice(0, 12));
const SRC = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d5f-79c9f5f82000/testdata/test.7z';
const OUT = '/tmp/7zout';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
sz.FS.mkdir('/nodefs');
try { sz.FS.mount(sz.NODEFS, { root: OUT }, '/nodefs'); } catch(e) { console.log('mount err', e.message); }
const data = fs.readFileSync(SRC);
const stream = sz.FS.open('/in.7z', 'w+');
sz.FS.write(stream, data, 0, data.length);
sz.FS.close(stream);
sz.FS.chdir('/');
try {
  sz.callMain(['x', '-y', '/in.7z', '-o/nodefs']);
} catch (e) { console.log('callMain err:', e?.message || e); }
const files = [];
(function walk(d, rel='') {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, rel + e.name + '/');
    else files.push(rel + e.name);
  }
})(OUT);
console.log('解压结果:', files);
