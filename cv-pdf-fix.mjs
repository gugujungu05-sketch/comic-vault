import fs from 'fs';
import { createRequire } from 'module';
const pdfjs = await import('/workspace/comic-vault/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const req = createRequire('/workspace/comic-vault/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const canvasMod = req('@napi-rs/canvas');
const data = new Uint8Array(fs.readFileSync('/tmp/t2.pdf'));
const doc = await pdfjs.getDocument({
  data, useSystemFonts: true, isEvalSupported: false,
  standardFontDataUrl: '/workspace/comic-vault/node_modules/pdfjs-dist/standard_fonts/',
}).promise;
const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 2 });
const canvas = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
fs.writeFileSync('/tmp/t2-fixed.png', canvas.toBuffer('image/png'));
console.log('FIX OK, png bytes:', fs.statSync('/tmp/t2-fixed.png').size);
process.exit(0);
