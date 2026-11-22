#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模拟 Android Java 桥，验证手机端多选导入网格与 multipart 上传参数。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path('/workspace/comic-vault')
BRIDGE = (ROOT / 'mobile/assets/android-bridge.js').read_text(encoding='utf-8')
DOT = ('data:image/png;base64,'
       'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==')

MOCK = r"""
window.__uploads = [];
window.__files = [{id:'f1',name:'003.jpg'},{id:'f2',name:'001.png'},{id:'f3',name:'002.webp'}];
window.AndroidHost = {
  api: function (spec) {
    var o = JSON.parse(spec), p = o.path || '', d = {};
    if (o.files) window.__uploads.push(o);
    if (p === '/api/auth/status') d = {user:{id:'u1',name:'测试',email:'t@t.local'},hasUsers:1,needsSetup:false};
    else if (p === '/api/comics' && o.method === 'POST') d = {id:'c1',title:'新漫画'};
    else if (p === '/api/comics') d = {comics:[]};
    else if (p.indexOf('/chapters') >= 0 && o.method === 'POST') d = [{id:'ch1',title:'第 1 话',pages:[]}];
    else if (p.indexOf('/categories') >= 0) d = {categories:[]};
    else if (p.indexOf('/community/comics') >= 0) d = {comics:[]};
    else if (p.indexOf('/plaza/posts') >= 0) d = {posts:[],boards:[]};
    return JSON.stringify({status:200,data:d});
  },
  asset: function (p) { return p; },
  getConfig: function () { return JSON.stringify({server:'http://127.0.0.1:8787',theme:'dark',version:'3.1.0'}); },
  setServer: function () { return '{}'; }, setTheme: function () { return '{}'; },
  checkUpdate: function () { return JSON.stringify({ok:true,hasUpdate:false,latest:'3.1.0'}); },
  siteUrl: function () { return 'http://127.0.0.1:8787'; },
  openExternal: function () { return '{}'; }, openDownload: function () { return '{}'; },
  openReader: function () { return '{}'; }, closeReader: function () { return '{}'; },
  pickFiles: function () {
    setTimeout(function () {
      if (window.__cvFilesPicked) window.__cvFilesPicked(JSON.parse(JSON.stringify(window.__files)));
    }, 60);
    return '{}';
  },
  thumb: function () { return '%s'; }
};
""" % DOT

PASS = FAIL = 0


def ck(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print('[PASS]', name)
    else:
        FAIL += 1; print('[FAIL]', name, extra)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCK + '\n' + BRIDGE)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:180]))
    pg.goto((ROOT / 'desktop/app/index.html').as_uri())
    pg.wait_for_timeout(900)
    ck('手机端模拟桥生效（CVAndroid）', pg.evaluate("() => !!window.CVAndroid"))
    ck('手机端书架有「多选导入」按钮',
       pg.locator('[data-action="pick-files"]').count() >= 1,
       pg.locator('#topActions').inner_text())
    ck('手机端无 JS 异常', len(errs) == 0, str(errs[:3]))

    pg.locator('#topActions [data-action="pick-files"]').click()
    pg.wait_for_selector('.imp-grid', timeout=8000)
    ck('弹出章节页式导入网格', pg.locator('.modal.wide .imp-grid').count() == 1)
    ck('网格显示 3 个已选文件', pg.locator('.imp-cell').count() == 3)
    ck('每格带页码编号', pg.locator('.imp-n').all_inner_texts()[:3] == ['1', '2', '3'])
    ck('默认按文件名自然排序', '001.png' in pg.locator('.imp-cell').nth(0).inner_text(),
       pg.locator('.imp-cell').nth(0).inner_text())
    ck('计数显示已选 3 / 3', '3 / 3' in pg.locator('#impCount').inner_text())
    ck('缩略图由宿主桥提供', pg.locator('.imp-thumb img').count() == 3)

    pg.locator('#impInvert').click()
    ck('反选后已选 0', '0 / 3' in pg.locator('#impCount').inner_text())
    pg.locator('#impAll').click()
    ck('全选后已选 3', '3 / 3' in pg.locator('#impCount').inner_text())
    pg.locator('.imp-cell input[type=checkbox]').nth(1).uncheck()
    ck('取消单个文件后已选 2', '2 / 3' in pg.locator('#impCount').inner_text())
    pg.locator('#impReverse').click()
    ck('倒序后首个编号仍为 1 且文件顺序变化',
       pg.locator('.imp-n').first.inner_text() == '1'
       and '003.jpg' in pg.locator('.imp-cell').first.inner_text(),
       pg.locator('.imp-cell').first.inner_text())

    pg.locator('[data-action="do-import"]').click()
    pg.wait_for_timeout(900)
    uploads = pg.evaluate("() => window.__uploads")
    ck('触发了 multipart 上传请求', len(uploads) >= 1, str(len(uploads)))
    if uploads:
        ck('只上传勾选的 2 个文件', len(uploads[0]['files']) == 2, str(uploads[0]['files']))
        ck('上传项使用 content:// 的 id + name（非本地路径）',
           all('id' in f and 'name' in f and 'path' not in f for f in uploads[0]['files']),
           str(uploads[0]['files']))
        ck('上传路径指向章节页面接口',
           '/chapters/ch1/pages' in uploads[0]['path'], uploads[0]['path'])
    ck('导入过程无 JS 异常', len(errs) == 0, str(errs[:3]))
    b.close()

print(f'\n合计 {PASS} 通过 / {FAIL} 失败')
raise SystemExit(0 if FAIL == 0 else 1)
