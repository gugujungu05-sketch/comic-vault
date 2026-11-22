/**
 * AI 翻译（生肉漫画 → 中文）
 *
 * 设计取舍：manga-image-translator 这类全流程方案是 Python + PyTorch，无法塞进
 * 本项目「纯 JS / 桌面 / Android / 网页三端共用」的服务端。当前翻译质量天花板是
 * 多模态大模型直接看图翻译（Gemini / GPT-4o 等），它理解上下文、拟声词、专有名词，
 * 质量远超传统「检测 → OCR → 机翻」链路。本模块：
 *   1. 把页面图片交给多模态模型，让它返回「文字框坐标 + 原文 + 译文 + 横竖排」
 *   2. 服务端用 @napi-rs/canvas 对文字框做内容感知底图修补（擦掉原文）
 *   3. 在原位置把译文渲染回去（自动字号、自动换行、横排/竖排、描边）
 *   4. 结果按「图片 hash + 模型 + 目标语言 + prompt 版本」缓存，避免重复扣费
 *
 * 支持三种后端（都走 OpenAI 兼容或 Gemini 原生，方便接自建/中转/本地模型）：
 *   - gemini   : Google Gemini 原生 API（有免费额度）
 *   - openai   : OpenAI 官方
 *   - custom   : 任意 OpenAI 兼容地址（可接 Sakura / 第三方中转 / 本地服务）
 */
import express from 'express';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
/* canvas 是原生模块：桌面 / Android 内置服务为规避原生编译可能不带它。
   这里做可选动态加载——缺依赖时翻译接口返回友好提示，但绝不让服务端启动崩溃。 */
let _canvas = null;
let _canvasTried = false;
async function getCanvas() {
  if (_canvas) return _canvas;
  if (_canvasTried) return null;
  _canvasTried = true;
  try { _canvas = await import('@napi-rs/canvas'); } catch { _canvas = null; }
  return _canvas;
}
import { DATA_DIR, STORE_DIR, loadDb, saveDbSoon } from './store.js';
import { getJsSource, jsImageHeaders } from './js-sources.js';

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const CACHE_DIR = path.join(DATA_DIR, 'translations');
const PROMPT_VERSION = 'v2';
const DEFAULT_PROMPT = `You are a professional manga translator. Look at the image carefully.
Detect EVERY text region (speech bubbles, narration, sound effects, signs) and translate all non-{LANG} text into {LANG}.

Output ONLY a JSON object, no markdown, no explanation, in this exact shape:
{"regions":[{"box":[x1,y1,x2,y2],"original":"source text","translation":"{LANG} translation","vertical":false,"color":"#rrggbb","bold":false}]}

Rules:
- Coordinates are integers 0-1000, normalized to image size. box = [left, top, right, bottom]. Tightly fit the visible text glyphs.
- Include EVERY text region. Do NOT skip sound effects or small text.
- "original" is the exact source text; "translation" is a natural, fluent {LANG} translation.
- "vertical" = true only if the source text is written vertically (top-to-bottom columns).
- "color" = the DOMINANT color of the original text glyphs as a hex value, e.g. "#ffffff" (white on dark bubble) or "#111111" (black on white bubble). Judge from the actual pixels. This is used to render the translation in a matching color.
- "bold" = true if the original text is noticeably bold/heavy (e.g. sound effects).
- Keep character names consistent across regions. Keep it concise to fit the bubble.`;

const PROVIDER_DEFAULTS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  custom: { baseUrl: '', model: '' },
};

function cfg() {
  const db = loadDb();
  const t = (db.settings && db.settings.translate) || {};
  const provider = PROVIDER_DEFAULTS[t.provider] ? t.provider : 'gemini';
  const def = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    apiKey: String(t.apiKey || ''),
    baseUrl: String(t.baseUrl || def.baseUrl || '').replace(/\/+$/, ''),
    model: String(t.model || def.model || ''),
    targetLang: String(t.targetLang || '简体中文'),
    prompt: String(t.prompt || DEFAULT_PROMPT),
    fontFamily: String(t.fontFamily || '"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif'),
    fontSizeOffset: Number(t.fontSizeOffset) || 0,
    inkColor: String(t.inkColor || '#111111'),
    useOutline: t.useOutline !== false,
    // 跟随原文：译文用模型识别到的原文颜色/粗细渲染，更贴近原著；关闭则用下方固定字号/颜色
    autoStyle: t.autoStyle !== false,
  };
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/* ------------------------------ 图片来源解析 ------------------------------ */

async function resolveImageBuffer(url) {
  if (!url) throw new Error('缺少图片地址');
  if (url.startsWith('data:')) {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(url);
    if (!m) throw new Error('无法解析 data 图片');
    return Buffer.from(m[1], 'base64');
  }
  // 本地书库页：/api/files/<comicId>/<chapterId>/<file>
  const fm = /^\/api\/files\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(url);
  if (fm) {
    const full = path.join(STORE_DIR, fm[1], fm[2], fm[3]);
    try { return await fsp.readFile(full); } catch { throw new Error('本地图片不存在'); }
  }
  // 在线来源代理：/api/online/img?sid=&u=
  if (url.startsWith('/api/online/img')) {
    const q = new URL(url, 'http://localhost').searchParams;
    const source = getJsSource(String(q.get('sid') || ''));
    const real = String(q.get('u') || '');
    if (!/^https?:\/\//i.test(real)) throw new Error('在线图片地址无效');
    const headers = { 'User-Agent': UA_DEFAULT, ...(source ? (jsImageHeaders(source, real) || {}) : {}) };
    return await fetchBuffer(real, headers);
  }
  if (/^https?:\/\//i.test(url)) return await fetchBuffer(url, { 'User-Agent': UA_DEFAULT });
  throw new Error('不支持的图片地址格式');
}

async function fetchBuffer(url, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`图片下载失败 HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

/* ------------------------------ 多模态模型调用 ------------------------------ */

function dataUrlOf(buf) {
  // 统一按 png 传输（loadImage 已能识别原格式，这里保持原样更省事）
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function callGemini(conf, buf) {
  const prompt = conf.prompt.replaceAll('{LANG}', conf.targetLang);
  const url = `${conf.baseUrl}/models/${encodeURIComponent(conf.model)}:generateContent?key=${encodeURIComponent(conf.apiKey)}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: buf.toString('base64') } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Gemini 请求失败 HTTP ${r.status}：${slice(text, 300)}`);
    let j; try { j = JSON.parse(text); } catch { throw new Error(`Gemini 返回无法解析：${slice(text, 200)}`); }
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const raw = parts.map((p) => p.text || '').join('');
    if (!raw) throw new Error(j?.promptFeedback?.blockReason ? `内容被拦截：${j.promptFeedback.blockReason}` : 'Gemini 未返回译文');
    return raw;
  } finally { clearTimeout(timer); }
}

async function callOpenAICompatible(conf, buf) {
  const prompt = conf.prompt.replaceAll('{LANG}', conf.targetLang);
  if (!conf.baseUrl) throw new Error('请填写 API 地址');
  const url = `${conf.baseUrl}/chat/completions`;
  const body = {
    model: conf.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrlOf(buf), detail: 'high' } },
      ],
    }],
    temperature: 0.2,
    max_tokens: 4096,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (conf.apiKey) headers.Authorization = `Bearer ${conf.apiKey}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`模型请求失败 HTTP ${r.status}：${slice(text, 300)}`);
    let j; try { j = JSON.parse(text); } catch { throw new Error(`返回无法解析：${slice(text, 200)}`); }
    const content = j?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型未返回译文');
    return typeof content === 'string' ? content : JSON.stringify(content);
  } finally { clearTimeout(timer); }
}

function slice(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function extractJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function parseRegions(raw, width, height) {
  const j = extractJson(raw);
  let arr = j?.regions || j?.items || j?.texts || j?.translations;
  if (!Array.isArray(arr)) {
    if (Array.isArray(j)) arr = j;
    else throw new Error('译文里没有找到 regions 数组');
  }
  const out = [];
  for (const it of arr) {
    let box = it.box || it.bbox || it.rect || it.coords;
    if (!box) continue;
    let x1, y1, x2, y2;
    if (Array.isArray(box)) {
      if (box.length === 4 && typeof box[0] === 'number') [x1, y1, x2, y2] = box;
      else if (box.length === 2 && Array.isArray(box[0]) && Array.isArray(box[1])) {
        [x1, y1] = box[0]; [x2, y2] = box[1];
      } else if (box.length === 4 && Array.isArray(box[0])) {
        x1 = Math.min(...box.map((p) => p[0])); x2 = Math.max(...box.map((p) => p[0]));
        y1 = Math.min(...box.map((p) => p[1])); y2 = Math.max(...box.map((p) => p[1]));
      }
    } else if (typeof box === 'object') {
      if ('x' in box && 'y' in box) { x1 = box.x; y1 = box.y; x2 = box.x + (box.width || box.w || 0); y2 = box.y + (box.height || box.h || 0); }
      else { x1 = box.left ?? box.x1 ?? box.xmin; y1 = box.top ?? box.y1 ?? box.ymin; x2 = box.right ?? box.x2 ?? box.xmax; y2 = box.bottom ?? box.y2 ?? box.ymax; }
    }
    if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) continue;
    // 归一化坐标（0-1000）→ 像素；模型若直接返回像素（都 <= 图片尺寸且 >1000 少见）也能兼容
    const norm = Math.max(x1, y1, x2, y2) <= 1000;
    const sx = norm ? width / 1000 : 1;
    const sy = norm ? height / 1000 : 1;
    let px1 = Math.max(0, Math.min(width, x1 * sx));
    let py1 = Math.max(0, Math.min(height, y1 * sy));
    let px2 = Math.max(0, Math.min(width, x2 * sx));
    let py2 = Math.max(0, Math.min(height, y2 * sy));
    if (px2 < px1) [px1, px2] = [px2, px1];
    if (py2 < py1) [py1, py2] = [py2, py1];
    if (px2 - px1 < 2 || py2 - py1 < 2) continue;
    const translation = String(it.translation ?? it.text ?? it.result ?? '').trim();
    if (!translation) continue;
    const vertical = !!(it.vertical || it.isVertical || it.direction === 'vertical');
    // 原文颜色：只接受合法 hex，供译文跟随原文配色
    let color = '';
    const rawColor = it.color ?? it.textColor ?? it.originalColor;
    if (typeof rawColor === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawColor.trim())) {
      let h = rawColor.trim().slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      color = `#${h.toLowerCase()}`;
    }
    const bold = !!(it.bold || it.isBold);
    out.push({ x1: px1, y1: py1, x2: px2, y2: py2, translation, vertical, color, bold });
  }
  return out;
}

/* ------------------------------ 底图修补 + 原位渲染 ------------------------------ */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 内容感知填充：用文字框四边外的像素做双线性插值，抹掉原文。对漫画气泡（多为纯色）效果尤其好。 */
function inpaintRegions(ctx, width, height, regions, pad = 2) {
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const at = (x, y) => {
    x = clamp(x | 0, 0, width - 1); y = clamp(y | 0, 0, height - 1);
    const i = (y * width + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const set = (x, y, c) => {
    const i = (y * width + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  };
  for (const r of regions) {
    const x1 = clamp(Math.floor(r.x1), 0, width - 1);
    const y1 = clamp(Math.floor(r.y1), 0, height - 1);
    const x2 = clamp(Math.ceil(r.x2), 0, width - 1);
    const y2 = clamp(Math.ceil(r.y2), 0, height - 1);
    const W = Math.max(1, x2 - x1), H = Math.max(1, y2 - y1);
    // 轻微外扩，连文字描边一起擦掉
    const ox1 = Math.max(0, x1 - pad), oy1 = Math.max(0, y1 - pad);
    const ox2 = Math.min(width - 1, x2 + pad), oy2 = Math.min(height - 1, y2 + pad);
    for (let y = oy1; y <= oy2; y++) {
      for (let x = ox1; x <= ox2; x++) {
        const tx = clamp((x - x1) / W, 0, 1);
        const ty = clamp((y - y1) / H, 0, 1);
        const top = at(x, y1 - pad), bottom = at(x, y2 + pad);
        const left = at(x1 - pad, y), right = at(x2 + pad, y);
        const v = [0, 1, 2].map((k) => {
          const vert = top[k] * (1 - ty) + bottom[k] * ty;
          const horiz = left[k] * (1 - tx) + right[k] * tx;
          return (vert + horiz) / 2;
        });
        set(x, y, v);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 相对亮度：>0.5 视为浅色字（配深色描边），否则深色字（配浅色描边）。 */
function isLightColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

/** 在修补后的画面上把译文渲染回原位置。字号贴合原文框，颜色默认跟随原文。 */
function renderRegions(ctx, regions, conf) {
  ctx.save();
  ctx.textBaseline = 'top';
  for (const r of regions) {
    // 跟随原文：用模型识别到的原文颜色；关闭或识别不到时用全局设置色
    const ink = conf.autoStyle && r.color ? r.color : conf.inkColor;
    const family = r.bold && conf.autoStyle ? `bold ${conf.fontFamily}` : conf.fontFamily;
    const outline = isLightColor(ink) ? '#000000' : '#ffffff';
    const W = r.x2 - r.x1, H = r.y2 - r.y1;
    const text = r.translation;
    if (r.vertical) {
      // 竖排：从右到左分列，每列从上到下
      const cols = Math.max(1, Math.ceil(text.length / Math.max(1, Math.floor(H / 14))));
      const fontSize = clamp(Math.floor(Math.min(W / cols, H / Math.max(2, Math.ceil(text.length / cols)))) + conf.fontSizeOffset, 8, Math.max(8, Math.floor(W / cols)));
      ctx.font = `${fontSize}px ${family}`;
      const perCol = Math.max(1, Math.floor((H - 2) / (fontSize + 1)));
      const chars = [...text];
      let idx = 0;
      for (let c = 0; c < cols && idx < chars.length; c++) {
        const cx = r.x2 - (c + 1) * (fontSize + 1);
        for (let row = 0; row < perCol && idx < chars.length; row++, idx++) {
          drawChar(ctx, chars[idx], cx, r.y1 + row * (fontSize + 1), ink, outline, conf);
        }
      }
    } else {
      // 横排：自动换行，字号自适应框宽高
      const chars = [...text];
      let fontSize = clamp(Math.floor(Math.min(H * 0.82, W / Math.max(2, chars.length) * 1.5)) + conf.fontSizeOffset, 8, Math.max(8, Math.floor(H * 0.95)));
      ctx.font = `${fontSize}px ${family}`;
      while (fontSize > 8) {
        const perLine = Math.max(1, Math.floor((W - 4) / fontSize));
        const lines = Math.ceil(chars.length / perLine);
        if (lines * (fontSize + 2) <= H + 2) break;
        fontSize -= 1;
        ctx.font = `${fontSize}px ${family}`;
      }
      const perLine = Math.max(1, Math.floor((W - 4) / fontSize));
      let idx = 0, line = 0;
      const lineH = fontSize + 2;
      const blockH = Math.ceil(chars.length / perLine) * lineH;
      let y = r.y1 + Math.max(0, (H - blockH) / 2);
      while (idx < chars.length) {
        const seg = chars.slice(idx, idx + perLine).join('');
        const tw = ctx.measureText(seg).width;
        const x = r.x1 + (W - tw) / 2;
        drawChar(ctx, seg, x, y, ink, outline, conf);
        idx += perLine; y += lineH; line++;
      }
    }
  }
  ctx.restore();
}

function drawChar(ctx, text, x, y, ink, outline, conf) {
  if (conf.useOutline) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = outline;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y);
}

/* ------------------------------ 主流程与缓存 ------------------------------ */

function cacheKey(buf, conf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
  const meta = crypto.createHash('sha256')
    .update(JSON.stringify([conf.provider, conf.model, conf.targetLang, PROMPT_VERSION, conf.fontSizeOffset, conf.inkColor, conf.useOutline, conf.autoStyle]))
    .digest('hex').slice(0, 10);
  return `${hash}-${meta}`;
}

async function translateBuffer(buf, conf) {
  const cv = await getCanvas();
  if (!cv) throw new Error('当前运行环境未安装图像处理模块，无法翻译（桌面/安卓内置服务暂不支持，请用网页版）');
  const { loadImage, createCanvas } = cv;
  const img = await loadImage(buf);
  const width = img.width, height = img.height;
  const raw = conf.provider === 'gemini'
    ? await callGemini(conf, buf)
    : await callOpenAICompatible(conf, buf);
  const regions = parseRegions(raw, width, height);
  if (!regions.length) throw new Error('没有识别到可翻译的文字');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  inpaintRegions(ctx, width, height, regions);
  renderRegions(ctx, regions, conf);
  return { png: await canvas.toBuffer('image/png'), count: regions.length };
}

export function registerTranslation(app) {
  const router = express.Router();

  // 读取配置（密钥打码）
  router.get('/config', (_req, res) => {
    const c = cfg();
    res.json({
      provider: c.provider,
      apiKey: maskKey(c.apiKey),
      hasKey: !!c.apiKey,
      baseUrl: c.baseUrl,
      model: c.model,
      targetLang: c.targetLang,
      fontFamily: c.fontFamily,
      fontSizeOffset: c.fontSizeOffset,
      inkColor: c.inkColor,
      useOutline: c.useOutline,
      autoStyle: c.autoStyle,
      defaults: PROVIDER_DEFAULTS,
    });
  });

  // 保存配置
  router.post('/config', (req, res) => {
    const db = loadDb();
    const b = req.body || {};
    const prev = (db.settings && db.settings.translate) || {};
    const next = { ...prev };
    const fields = ['provider', 'apiKey', 'baseUrl', 'model', 'targetLang', 'prompt', 'fontFamily', 'fontSizeOffset', 'inkColor', 'useOutline', 'autoStyle'];
    for (const f of fields) if (f in b) next[f] = b[f];
    // 前端回传打码串时保留原 key
    if (b.apiKey && /••••/.test(String(b.apiKey))) next.apiKey = prev.apiKey;
    db.settings = db.settings || {};
    db.settings.translate = next;
    saveDbSoon();
    res.json({ ok: true });
  });

  // 连接测试：翻译一张纯文字测试图（用最小 PNG），只验证链路
  router.post('/test', async (_req, res) => {
    try {
      const c = cfg();
      if (c.provider !== 'gemini' && !c.apiKey) return res.status(400).json({ error: '请先填写 API Key' });
      if (c.provider === 'gemini' && !c.apiKey) return res.status(400).json({ error: '请先填写 API Key' });
      const cv = await getCanvas();
      if (!cv) return res.status(400).json({ error: '当前环境未安装图像处理模块，无法测试翻译' });
      const { createCanvas } = cv;
      // 一张带 "HELLO" 的小图，验证模型能返回译文
      const test = createCanvas(240, 120);
      const tc = test.getContext('2d');
      tc.fillStyle = '#ffffff'; tc.fillRect(0, 0, 240, 120);
      tc.fillStyle = '#000000'; tc.font = 'bold 48px sans-serif'; tc.textBaseline = 'middle';
      tc.fillText('HELLO', 20, 60);
      const buf = await test.toBuffer('image/png');
      const raw = c.provider === 'gemini' ? await callGemini(c, buf) : await callOpenAICompatible(c, buf);
      const regions = parseRegions(raw, 240, 120);
      res.json({ ok: true, regions: regions.length, model: c.model, provider: c.provider });
    } catch (err) {
      res.status(502).json({ error: err?.message || '测试失败' });
    }
  });

  // 翻译一页：body { url } → { url: 译文图, count, cached }
  router.post('/page', async (req, res) => {
    try {
      const c = cfg();
      if (!c.apiKey && c.provider !== 'custom') return res.status(400).json({ error: '请先在设置里填写翻译 API Key' });
      const src = String(req.body?.url || '');
      const buf = await resolveImageBuffer(src);
      const key = cacheKey(buf, c);
      const outPath = path.join(CACHE_DIR, `${key}.png`);
      try {
        await fsp.access(outPath);
        return res.json({ url: `/api/translate/image/${key}.png`, count: -1, cached: true });
      } catch { /* 未缓存，继续翻译 */ }
      const { png, count } = await translateBuffer(buf, c);
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      // 原子写，避免半截文件被命中缓存
      const tmp = `${outPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, png);
      await fsp.rename(tmp, outPath);
      res.json({ url: `/api/translate/image/${key}.png`, count, cached: false });
    } catch (err) {
      res.status(502).json({ error: err?.message || '翻译失败' });
    }
  });

  // 读取缓存译文图
  router.get('/image/:file', async (req, res) => {
    const name = path.basename(String(req.params.file || ''));
    if (!/^[a-f0-9-]+\.png$/i.test(name)) return res.status(400).end('bad request');
    const full = path.join(CACHE_DIR, name);
    try { await fsp.access(full); } catch { return res.status(404).end('not found'); }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(full);
  });

  app.use('/api/translate', router);
}
