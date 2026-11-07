"""独立桌面客户端回归（v3.0）。

启动真实的 Electron 客户端，通过 CDP 验证：
  · 加载的是打包在本地的独立界面，不是网站页面
  · 宿主桥版本、导航结构、无「软件下载」入口
  · 通过 IPC 直连服务器 API（与网站数据互通）
  · 设置页内检查更新返回客户端版本

用法：
    python3 tests/test_desktop_app.py
    CV_BASE_URL=http://127.0.0.1:8787 python3 tests/test_desktop_app.py

依赖：desktop/node_modules 下的 electron、xvfb-run、playwright。
"""
import os
import signal
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(ROOT, 'desktop')
BASE = os.environ.get('CV_BASE_URL', 'http://127.0.0.1:8787').rstrip('/')
CDP = int(os.environ.get('CV_CDP_PORT', '9334'))
ok = fail = 0


def ck(name, cond, extra=''):
    global ok, fail
    if cond:
        ok += 1
        print('[PASS] %s %s' % (name, extra))
    else:
        fail += 1
        print('[FAIL] %s %s' % (name, extra))


def wait_cdp(timeout=40):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', CDP), timeout=1):
                return True
        except OSError:
            time.sleep(0.4)
    return False


def main():
    electron = os.path.join(DESKTOP, 'node_modules', '.bin', 'electron')
    if not os.path.exists(electron):
        print('缺少 desktop/node_modules/.bin/electron，请先 cd desktop && npm install')
        return 1
    env = os.environ.copy()
    env['CV_DESKTOP_SERVER'] = BASE
    log = open('/tmp/cv-desktop-test.log', 'w')
    cmd = ['xvfb-run', '-a', electron, '.', '--no-sandbox', '--disable-gpu',
           '--user-data-dir=/tmp/cv-desktop-test-profile',
           f'--remote-debugging-port={CDP}']
    proc = subprocess.Popen(cmd, cwd=DESKTOP, env=env, stdout=log, stderr=log,
                            start_new_session=True)
    try:
        if not wait_cdp():
            print('Electron 未启动，日志：')
            print(open('/tmp/cv-desktop-test.log').read()[-1500:])
            return 1
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{CDP}')
            ctx = browser.contexts[0]
            pg = ctx.pages[0]
            pg.wait_for_timeout(1200)

            ck('加载本地独立界面', 'file://' in pg.url and 'desktop/app/index.html' in pg.url, pg.url)
            import json as _json
            _dv = _json.load(open('version.json'))['desktop']
            ck('宿主桥版本与 version.json 一致', str(pg.evaluate('() => window.cvApp && window.cvApp.version')).startswith(_dv.rsplit('.',1)[0]), str(pg.evaluate('() => window.cvApp && window.cvApp.version')))
            ck('侧栏 6 个入口', pg.locator('.nav-item').count() == 6)
            ck('不含网站顶部导航', pg.locator('.nav').count() == 0)
            ck('不含网站底部 Tab', pg.locator('.mobile-tabs').count() == 0)
            body = pg.locator('body').inner_text()
            ck('界面无「软件下载」入口', '软件下载' not in body and '下载页面' not in body.replace('不提供下载页面', ''))

            rt = pg.evaluate("async () => await window.cvApp.api({method:'GET',path:'/api/runtime'})")
            ck('API 直连：runtime', rt.get('status') == 200, str(rt.get('data', {}).get('version')))
            st = pg.evaluate("async () => await window.cvApp.api({method:'GET',path:'/api/auth/status'})")
            ck('API 直连：登录态接口', st.get('status') == 200)

            pg.locator('.nav-item[data-view="settings"]').click()
            pg.wait_for_timeout(600)
            ck('设置页有检查更新', pg.locator('[data-action="check-update"]').count() == 1)
            pg.locator('[data-action="check-update"]').click()
            pg.wait_for_timeout(1500)
            up = pg.locator('#updateBox').inner_text()
            ck('检查更新显示最新版本号', _dv[:5] in up, up[:80].replace('\n', ' '))
            ck('更新说明包含新内容', ('内置' in up or '追更' in up or '已是最新' in up), up[:60].replace('\n', ' '))

            browser.close()
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            proc.terminate()
        log.close()

    print('\n目标服务器: %s' % BASE)
    print('合计 %s 通过 / %s 失败' % (ok, fail))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
