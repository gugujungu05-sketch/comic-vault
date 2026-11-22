"""移动端 / 桌面端布局回归（v2.3 底部 Tab 栏）。

用法：先 `npm start`（或让服务监听 8787），再：
    python3 tests/test_mobile_ui.py
也可用 CV_BASE_URL 指向其它地址：
    CV_BASE_URL=https://your-domain.example python3 tests/test_mobile_ui.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get('CV_BASE_URL', 'http://127.0.0.1:8787').rstrip('/')
ok = fail = 0


def ck(name, cond, extra=''):
    global ok, fail
    if cond:
        ok += 1
        print('[PASS] %s %s' % (name, extra))
    else:
        fail += 1
        print('[FAIL] %s %s' % (name, extra))


KEY_JS = """(sels) => {
  const out = {};
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)]
      .filter(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none');
    out[s] = els.length ? Math.round(Math.min(...els.map(e => e.getBoundingClientRect().height))) : null;
  }
  return out;
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])

        # 手机 390x844
        m = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                                is_mobile=True, has_touch=True)
        pg = m.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:100]))
        pg.goto(BASE + '/community', wait_until='load', timeout=30000)
        pg.wait_for_timeout(1200)

        tabs = pg.locator('.mobile-tabs')
        ck('底栏存在且可见', tabs.count() == 1 and tabs.is_visible())
        ck('底栏 5 个入口', tabs.locator('a').count() == 5)
        ck('顶部横向导航已隐藏', pg.locator('.nav').evaluate('e => getComputedStyle(e).display') == 'none')
        ck('书库项高亮', 'active' in (tabs.locator('a').nth(1).get_attribute('class') or ''))
        ck('书库页无横向溢出', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'))
        pb = pg.evaluate('getComputedStyle(document.querySelector(".page")).paddingBottom')
        ck('内容底部为 Tab 预留空间', int(pb.replace('px', '').split('.')[0]) >= 80, '(%s)' % pb)
        heights = pg.evaluate(KEY_JS, ['.mobile-tabs a', '.cat-bar button', '.rank-tabs button',
                                       'button.chip', '.btn', '.input'])
        ck('关键控件触摸目标 >= 44px', all(v is None or v >= 43 for v in heights.values()), str(heights))

        tabs.locator('a').nth(2).click()
        pg.wait_for_timeout(900)
        ck('点「广场」完成路由切换', pg.url.endswith('/plaza'))
        ck('广场项高亮', 'active' in (tabs.locator('a').nth(2).get_attribute('class') or ''))
        ck('广场页无横向溢出', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'))
        ph = pg.evaluate(KEY_JS, ['.board-chip', '.mobile-tabs a'])
        ck('分区按钮 >= 44px', all(v is None or v >= 43 for v in ph.values()), str(ph))

        for idx, path in [(3, '/downloads'), (4, '/settings'), (1, '/community')]:
            tabs.locator('a').nth(idx).click()
            pg.wait_for_timeout(700)
            ck('底栏可达 %s' % path, path in pg.url)
            ck('%s 底栏仍在' % path, tabs.is_visible())

        tabs.locator('a').nth(0).click()
        pg.wait_for_timeout(800)
        ck('未登录点书架进入登录页', '登录' in pg.locator('body').inner_text())
        ck('登录页不显示底栏', pg.locator('.mobile-tabs').count() == 0 or not pg.locator('.mobile-tabs').is_visible())
        ck('手机端无页面异常', len(errs) == 0, str(errs[:2]))
        m.close()

        # 桌面 1280x900
        d = browser.new_context(viewport={'width': 1280, 'height': 900})
        dp = d.new_page()
        dp.goto(BASE + '/community', wait_until='load', timeout=30000)
        dp.wait_for_timeout(1000)
        ck('桌面端顶部导航可见', dp.locator('.nav').evaluate('e => getComputedStyle(e).display') != 'none')
        ck('桌面端顶部导航宽度正常', dp.locator('.nav').evaluate('e => e.clientWidth') > 200)
        ck('桌面端无底栏', dp.locator('.mobile-tabs').count() == 0 or not dp.locator('.mobile-tabs').is_visible())
        ck('桌面端无横向溢出', dp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'))
        d.close()
        browser.close()

    print('\n目标: %s' % BASE)
    print('合计 %s 通过 / %s 失败' % (ok, fail))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
