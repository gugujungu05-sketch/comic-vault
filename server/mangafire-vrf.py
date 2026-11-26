#!/usr/bin/env python3
"""MangaFire VRF token 生成器（书源后端辅助服务）。

站点 2025 改版后 API 全部需要动态 VRF token（VM 混淆算法，浏览器端生成），
且带 Cloudflare JS 挑战。纯 HTTP 无法生成。本服务用无头浏览器加载站点，
让页面自己触发对应 API 请求，从 XHR 里截获带 vrf 的真实 URL 返回给 Node 宿主。

VRF 由站点固定配置确定性生成、长期有效，Node 侧会按 (action,value) 做磁盘缓存，
因此本服务只在缓存未命中时被调用，浏览器常驻复用、开销可控。

协议：stdin 逐行 JSON {"action": "search|detail|chapters|images", "value": "...", "page": 1}
      stdout 逐行 JSON {"ok": true, "url": "<带 vrf 的 /api/... 路径>"} 或 {"ok": false, "error": "..."}
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
HOME = 'https://mangafire.to/'

PW = None
BROWSER = None
CTX = None
PAGE = None
LOCK = asyncio.Lock()


async def ensure_browser():
    global BROWSER, CTX, PAGE
    if PAGE is not None:
        return
    BROWSER = await PW.chromium.launch(
        headless=True,
        args=['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    )
    CTX = await BROWSER.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800})
    # 每次导航后都注入捕获器：记录页面发出的所有 /api/ 请求 URL
    await CTX.add_init_script("""
      window.__mfCap = [];
      var _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(m, u) {
        var s = String(u || '');
        if (s.indexOf('/api/') >= 0) window.__mfCap.push(s);
        return _open.apply(this, arguments);
      };
      var _fetch = window.fetch;
      window.fetch = function(u) {
        var s = String((u && u.url) || u || '');
        if (s.indexOf('/api/') >= 0) window.__mfCap.push(s);
        return _fetch.apply(this, arguments);
      };
    """)
    PAGE = await CTX.new_page()
    await PAGE.goto(HOME, wait_until='domcontentloaded', timeout=60000)
    await PAGE.wait_for_timeout(6000)  # 等 Cloudflare 挑战通过


async def captured():
    try:
        return await PAGE.evaluate('window.__mfCap || []')
    except Exception:
        return []


def pick(urls, predicate):
    for u in reversed(urls):
        if predicate(u) and 'vrf=' in u:
            return u
    return None


async def gen_search(value, page):
    kw = str(value or '').strip()
    await PAGE.goto('https://mangafire.to/filter', wait_until='domcontentloaded', timeout=60000)
    await PAGE.wait_for_timeout(2200)
    inp = PAGE.locator('input[placeholder*="earch" i]').first
    await inp.fill(kw)
    await inp.press('Enter')
    await PAGE.wait_for_timeout(4500)
    urls = await captured()
    return pick(urls, lambda u: '/api/titles?' in u and 'keyword=' in u)


async def gen_detail(hid):
    # detail action 需要的只是 /api/titles/{hid} 的 vrf（同 hid 的 chapters/volumes vrf 前缀一致，
    # 但签名按路径不同）；打开详情页能一次拿到 detail + chapters + volumes 全部 vrf。
    await PAGE.goto('https://mangafire.to/title/' + str(hid), wait_until='domcontentloaded', timeout=60000)
    await PAGE.wait_for_timeout(4500)
    urls = await captured()
    # 精确匹配 /api/titles/{hid}? 而非 /api/titles/{hid}/chapters?
    import re
    pat = re.compile(r'/api/titles/' + re.escape(str(hid)) + r'\?')
    return pick(urls, lambda u: bool(pat.search(u)))


# 每本书所有分页的 chapters VRF 内存缓存：{hid: {page: full_url}}
# 一次导航循环点完所有分页即可缓存全部页，避免逐页重新导航（11 页书逐页导航要 2 分钟）。
CHAPTER_VRF = {}


def _page_of(url):
    import re
    m = re.search(r'[?&]page=(\d+)', str(url))
    return int(m.group(1)) if m else None


async def gen_chapters(hid, page):
    hid = str(hid)
    cache = CHAPTER_VRF.get(hid)
    if cache and page in cache:
        return cache[page]

    # 首次：导航详情页，等待 page=1 请求，然后循环点「下一页」捕获所有分页 VRF。
    await PAGE.goto('https://mangafire.to/title/' + hid, wait_until='domcontentloaded', timeout=60000)
    await PAGE.wait_for_timeout(4500)

    urls = await captured()
    store = {}
    for u in urls:
        if '/api/titles/' + hid + '/chapters?' in u and 'vrf=' in u:
            p = _page_of(u)
            if p:
                store[p] = u

    async def harvest():
        """把当前已捕获的 chapters 请求按页号存入 store"""
        for u in await captured():
            if '/api/titles/' + hid + '/chapters?' in u and 'vrf=' in u:
                p = _page_of(u)
                if p:
                    store[p] = u

    # 站点分页控件有个坑：一路点 Next 到第 21 页后 Next 按钮会消失，
    # 但 API 实际还有更多页（meta.lastPage 可能到 23+）。
    # 因此改为：先点「Last page」跳到最后一页，再一路点「Previous page」回到第 1 页，
    # 这样每一页的 API 请求都会被捕获，覆盖所有分页。
    clicked_last = await PAGE.evaluate("""() => {
      var b = document.querySelector('button.npager__nav[aria-label="Last page"]');
      if (!b || b.disabled) return false;
      b.click(); return true;
    }""")
    if clicked_last:
        await PAGE.wait_for_timeout(1600)
        await harvest()
        # 从最后一页往回点 Previous，直到第 1 页（按钮禁用）
        for _ in range(1, 70):
            has_prev = await PAGE.evaluate("""() => {
              var b = document.querySelector('button.npager__nav[aria-label="Previous page"]');
              if (!b || b.disabled) return false;
              b.click(); return true;
            }""")
            if not has_prev:
                break
            await PAGE.wait_for_timeout(1200)
            await harvest()
    # 反向遍历（Last→Previous）通常已覆盖全部页；回到第 1 页后，
    # 对开头几页显式点数字按钮，补上被 Previous 跳过的页（如 page=2）。
    await PAGE.evaluate("""() => {
      var b = document.querySelector('button.npager__nav[aria-label="First page"]');
      if (b && !b.disabled) b.click();
    }""")
    await PAGE.wait_for_timeout(1200)
    await harvest()
    for n in range(2, 6):
        if n in store:
            continue
        clicked = await PAGE.evaluate("""(n) => {
          var b = Array.from(document.querySelectorAll('button.npager__num')).find(function(e){ return e.textContent.trim() === String(n); });
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        }""", n)
        if clicked:
            await PAGE.wait_for_timeout(1000)
            await harvest()

    CHAPTER_VRF[hid] = store
    # 一次返回所有页，让 Node 侧一次性缓存全部；避免逐页重复导航浏览器。
    return {"__all__": {str(k): v for k, v in store.items()}}


async def gen_images(hid, slug, chapter_id):
    url = 'https://mangafire.to/title/%s-%s/chapter/%s' % (hid, slug, chapter_id)
    await PAGE.goto(url, wait_until='domcontentloaded', timeout=60000)
    await PAGE.wait_for_timeout(4500)
    urls = await captured()
    return pick(urls, lambda u: '/api/chapters/' + str(chapter_id) + '?' in u)


async def generate(req):
    action = req.get('action', '')
    value = req.get('value', '')
    page = int(req.get('page') or 1)
    await ensure_browser()
    if action == 'search':
        return await gen_search(value, page)
    if action == 'detail':
        return await gen_detail(value)
    if action == 'chapters':
        return await gen_chapters(value, page)
    if action == 'images':
        # value 形如 "hid|slug|chapterId"
        parts = str(value).split('|')
        if len(parts) < 3:
            raise ValueError('images 需要 hid|slug|chapterId')
        return await gen_images(parts[0], parts[1], parts[2])
    raise ValueError('未知 action: ' + str(action))


async def main():
    global PW
    async with async_playwright() as pw:
        PW = pw
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            req_id = None
            try:
                req = json.loads(line)
                req_id = req.get('id')
                async with LOCK:
                    url = await generate(req)
                if url:
                    print(json.dumps({'ok': True, 'id': req_id, 'url': url}, ensure_ascii=False), flush=True)
                else:
                    print(json.dumps({'ok': False, 'id': req_id, 'error': '未捕获到 VRF URL'}), flush=True)
            except Exception as e:
                print(json.dumps({'ok': False, 'id': req_id, 'error': str(e)[:300]}), flush=True)
        if BROWSER:
            await BROWSER.close()


if __name__ == '__main__':
    asyncio.run(main())
