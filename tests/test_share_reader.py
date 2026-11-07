#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.4 / v3.1 回归：分享落地页、条漫模式、上一话/下一话、桌面独立阅读窗口。

用独立临时数据目录启动服务，注册账号并造一本 2 话漫画，不碰线上数据。
"""
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8811
B = f'http://127.0.0.1:{PORT}'
PASS = FAIL = 0


def ck(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('[PASS]', name)
    else:
        FAIL += 1
        print('[FAIL]', name, extra)


def wait_port(port, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def png(w, h, color):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (w, h), color)
    d = ImageDraw.Draw(im)
    d.rectangle([10, 10, w - 10, h - 10], outline=(255, 255, 255), width=4)
    d.text((24, 24), f'{w}x{h}', fill=(255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def main():
    tmp = tempfile.mkdtemp(prefix='cv-share-reader-')
    env = os.environ.copy()
    env.update({'PORT': str(PORT), 'CV_DATA_DIR': tmp, 'CV_NO_DOTENV': '1',
                'CV_DISABLE_SAMPLES': '1', 'NODE_ENV': 'test'})
    log = open('/tmp/cv-share-reader-server.log', 'w')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=str(ROOT), env=env,
                           stdout=log, stderr=subprocess.STDOUT)
    try:
        if not wait_port(PORT):
            print('服务启动失败:\n', Path('/tmp/cv-share-reader-server.log').read_text()[-1500:])
            return 1
        s = requests.Session()
        r = s.post(B + '/api/auth/register', json={
            'email': 'reader@test.local', 'password': 'test123456', 'name': '阅读测试'})
        ck('测试账号注册成功', r.status_code == 200, r.text[:200])

        cid = s.post(B + '/api/comics', json={
            'title': '条漫与分享测试', 'author': '测试作者',
            'description': '这是用于验证分享落地页与条漫模式的测试漫画。'}).json()['id']
        chapters = []
        for title in ('第 1 话', '第 2 话'):
            data = s.post(B + f'/api/comics/{cid}/chapters', json={'title': title}).json()
            ch = data[-1] if isinstance(data, list) else (data.get('chapters') or [])[-1]
            chapters.append(ch['id'])
        for i, ch in enumerate(chapters):
            files = [('files', (f'{i}-{j}.png', png(400, 900 if j == 0 else 600,
                     (60 + i * 60, 90 + j * 50, 160)), 'image/png')) for j in range(2)]
            r = s.post(B + f'/api/comics/{cid}/chapters/{ch}/pages', files=files)
            ck(f'第 {i + 1} 话上传 2 页', r.status_code == 200, r.text[:160])
        share = s.post(B + f'/api/comics/{cid}/share', json={
            'enabled': True, 'allowDownload': True}).json()
        token = share['token']
        ck('分享链接创建成功', bool(token), str(share)[:160])

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            # ---------- 网站端 ----------
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)[:150]))
            pg.goto(B + f'/s/{token}', wait_until='domcontentloaded')
            pg.wait_for_selector('.share-landing', timeout=15000)
            ck('分享链接打开显示落地页（不再是直接阅读器）', pg.locator('.share-landing').count() == 1)
            ck('落地页显示漫画标题', '条漫与分享测试' in pg.locator('h1').inner_text())
            ck('落地页显示作者与简介', '测试作者' in pg.locator('body').inner_text()
               and '分享落地页' in pg.locator('body').inner_text())
            ck('落地页目录列出 2 话', pg.locator('.share-chapter').count() == 2)
            ck('落地页有开始阅读按钮', pg.locator('.share-actions .btn.primary').count() == 1)
            ck('落地页显示下载权限', '允许下载' in pg.locator('.share-perms').inner_text())
            ck('落地页没有遮挡画面的浮动下载按钮', pg.locator('.share-landing ~ button').count() == 0)

            pg.locator('.share-actions .btn.primary').click()
            pg.wait_for_selector('.reader', timeout=10000)
            ck('点开始阅读进入阅读器', pg.locator('.reader').count() == 1)
            body = pg.locator('.reader-top').inner_text()
            ck('阅读器有「条漫」选项', '条漫' in body)
            bot = pg.locator('.reader-bottom').inner_text()
            ck('阅读器有「上一话」「下一话」按钮', '上一话' in bot and '下一话' in bot)
            prev = pg.locator('.reader-bottom button', has_text='上一话')
            ck('第 1 话时「上一话」禁用', prev.is_disabled())

            pg.locator('.reader-top button', has_text='条漫').click()
            pg.wait_for_timeout(400)
            ck('条漫模式 stage 切换', pg.locator('.reader-stage.webtoon').count() == 1)
            ck('条漫模式渲染全部页面', pg.locator('.webtoon-page').count() == 2)
            ck('条漫模式显示下一话入口', pg.locator('.webtoon-edge').count() >= 1)
            ck('条漫模式隐藏翻页悬浮层', pg.locator('.reader-nav').count() == 0)

            # 通过目录切到第 2 话，验证显式上下话
            pg.locator('.reader-bottom button', has_text='下一话').click()
            pg.wait_for_timeout(400)
            sel = pg.locator('.reader-bottom select').input_value()
            ck('点「下一话」切到第 2 话', sel == '1', f'select={sel}')
            ck('第 2 话时「下一话」禁用',
               pg.locator('.reader-bottom button', has_text='下一话').is_disabled())
            pg.locator('.reader-bottom button', has_text='上一话').click()
            pg.wait_for_timeout(300)
            ck('点「上一话」返回第 1 话', pg.locator('.reader-bottom select').input_value() == '0')
            ck('阅读器顶栏有返回封面', '封面' in pg.locator('.reader-top').inner_text())
            pg.locator('.reader-top button', has_text='封面').click()
            pg.wait_for_selector('.share-landing', timeout=8000)
            ck('返回封面回到落地页', pg.locator('.share-landing').count() == 1)
            ck('网站端无 JS 异常', len(errs) == 0, str(errs[:3]))

            # 手机视口
            m = browser.new_context(viewport={'width': 390, 'height': 844},
                                    is_mobile=True, has_touch=True)
            mp = m.new_page()
            mp.goto(B + f'/s/{token}', wait_until='domcontentloaded')
            mp.wait_for_selector('.share-landing', timeout=15000)
            ck('手机端落地页正常渲染', mp.locator('h1').count() == 1)
            w = mp.evaluate("() => document.documentElement.scrollWidth")
            ck('手机端落地页无横向溢出', w <= 400, f'scrollWidth={w}')
            ck('手机端开始阅读按钮 ≥44px',
               mp.locator('.share-actions .btn.primary').bounding_box()['height'] >= 44)
            mp.locator('.share-actions .btn.primary').click()
            mp.wait_for_selector('.reader', timeout=10000)
            ck('手机端阅读器有上一话/下一话',
               '上一话' in mp.locator('.reader-bottom').inner_text())
            ck('手机端无横向溢出', mp.evaluate("() => document.documentElement.scrollWidth") <= 400)

            # ---------- 桌面独立阅读窗口（离线 mock 桥） ----------
            comic = {
                'id': 'c_test', 'title': '桌面阅读器测试',
                'chapters': [
                    {'id': 'ch1', 'title': '第 1 话', 'pages': [
                        {'id': 'p1', 'file': 'a.png'}, {'id': 'p2', 'file': 'b.png'}]},
                    {'id': 'ch2', 'title': '第 2 话', 'pages': [
                        {'id': 'p3', 'file': 'c.png'}]},
                ],
            }
            dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
            mock = """window.cvApp = {
              version: '3.1.0',
              api: async function () { return { status: 200, data: %s }; },
              asset: function () { return %s; },
              closeReader: function () {}, toggleFullscreen: function () {}
            };""" % (json.dumps(comic, ensure_ascii=False), json.dumps(dot))
            dctx = browser.new_context(viewport={'width': 1100, 'height': 800})
            dctx.add_init_script(mock)
            dp = dctx.new_page()
            derr = []
            dp.on('pageerror', lambda e: derr.append(str(e)[:150]))
            dp.goto((ROOT / 'desktop/app/reader.html').as_uri() + '?comic=c_test&chapter=ch1')
            dp.wait_for_selector('#btnWebtoon', timeout=10000)
            ck('桌面阅读窗口有「条漫」按钮', dp.locator('#btnWebtoon').count() == 1)
            ck('桌面阅读窗口有「上一话/下一话」按钮',
               dp.locator('#btnPrevChapter').count() == 1 and dp.locator('#btnNextChapter').count() == 1)
            dp.locator('#btnWebtoon').click()
            dp.wait_for_timeout(300)
            ck('桌面阅读窗口条漫模式生效', dp.locator('.r-stage.webtoon').count() == 1)
            ck('桌面阅读窗口条漫渲染全部页', dp.locator('.r-stage.webtoon img').count() == 2)
            ck('桌面阅读窗口条漫有下一话入口', dp.locator('.r-webtoon-edge').count() >= 1)
            dp.locator('#btnNextChapter').click()
            dp.wait_for_timeout(300)
            ck('桌面阅读窗口点下一话切章', dp.locator('#chapterSel').input_value() == 'ch2',
               dp.locator('#chapterSel').input_value())
            ck('桌面阅读窗口无 JS 异常', len(derr) == 0, str(derr[:3]))
            browser.close()

        print(f'\n合计 {PASS} 通过 / {FAIL} 失败')
        return 0 if FAIL == 0 else 1
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=8)
        except subprocess.TimeoutExpired:
            srv.kill()
        log.close()


if __name__ == '__main__':
    sys.exit(main())
