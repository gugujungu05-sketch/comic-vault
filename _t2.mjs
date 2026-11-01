import { extractWith7z, supportedFormats, warmup } from './server/archive.js';
import fs from 'node:fs';
import path from 'node:path';
console.log('warmup:', await warmup());
const SRC = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d5f-79c9f5f82000/testdata/test.7z';
for (const i of [1,2]) {
  const out = `/tmp/7zout${i}`;
  fs.rmSync(out, { recursive: true, force: true });
  await extractWith7z(SRC, out);
  const files = [];
  (function walk(d, rel=''){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p, rel+e.name+'/'); else files.push(rel+e.name);} })(out);
  console.log(`第${i}次解压:`, files.length, files.slice(0,3));
}
const info = await supportedFormats();
console.log('RAR 在支持列表:', /RAR/i.test(info));
console.log(info.split('\n').filter(l=>/RAR|7z|Zip/i.test(l)).slice(0,6).join(' | '));
