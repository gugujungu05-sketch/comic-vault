"""浏览器端到端验证 v2.2：首页动态 / 公告权限 / 公共书库分类排行搜索 / 广场搜索 / 软件下载。

用独立临时数据目录启动后端（CV_NO_DOTENV=1 隔离本地 .env），不碰项目 data/。
依赖 playwright + 本机 Chromium。
"""
import os
import socket
import subprocess
import sys
import tempfile
import time

import requests
from playwright.sync_api import sync_playwright

ROOT = "/workspace/comic-vault"
PORT = 8804
BASE = f"http://127.0.0.1:{PORT}"
CHROMIUM = "/usr/bin/chromium"


def wait_port(port, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main():
    passed, failed = 0, 0

    def ck(name, cond):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"[PASS] {name}")
        else:
            failed += 1
            print(f"[FAIL] {name}")

    data_dir = tempfile.mkdtemp(prefix="cv-discovery-ui-")
    env = os.environ.copy()
    env["CV_DATA_DIR"] = data_dir
    env["PORT"] = str(PORT)
    env["CV_NO_DOTENV"] = "1"
    log = open(f"/tmp/cv-discovery-ui-{PORT}.log", "w")
    proc = subprocess.Popen(
        ["node", "server/index.js"], cwd=ROOT, env=env, stdout=log, stderr=log
    )
    try:
        if not wait_port(PORT):
            print("服务未启动：", open(f"/tmp/cv-discovery-ui-{PORT}.log").read()[-2000:])
            sys.exit(1)
        for _ in range(80):
            comics = requests.get(BASE + "/api/community/comics").json()["comics"]
            ups = requests.get(BASE + "/api/community/uploads").json()["total"]
            if len(comics) >= 6 and ups >= 6:
                break
            time.sleep(0.5)

        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM, args=["--no-sandbox"])
            ctx = browser.new_context(service_workers="block", viewport={"width": 1400, "height": 950})
            page = ctx.new_page()
            page.set_default_timeout(15000)

            # 用 JSON body 注册（后端 express.json 只解析 JSON）
            import json
            r = ctx.request.post(
                BASE + "/api/auth/register",
                data=json.dumps({"email": "owner@test.local", "password": "test123456", "name": "站长"}),
                headers={"Content-Type": "application/json"},
            )
            ck("首个账号注册并自动获得公告权限",
               r.status == 200 and r.json()["user"]["canAnnounce"] is True)

            page.goto(BASE + "/", wait_until="networkidle")
            page.wait_for_selector(".feed-panel")
            ck("首页显示动态流", page.locator(".feed-item").count() >= 5)
            ck("公告发布入口仅授权账号可见",
               page.locator('.feed-head button:has-text("发布公告")').count() == 1)
            page.click('.feed-head button:has-text("发布公告")')
            page.fill(".ann-form input.input", "公共书库上线公告")
            page.fill(".ann-form textarea", "欢迎上传与协作编辑。")
            page.click('.ann-form button:has-text("发布并置顶")')
            page.wait_for_selector(".ann-card")
            ck("公告发布后置顶显示", "公共书库上线公告" in page.locator(".ann-card").first.inner_text())

            page.goto(BASE + "/community", wait_until="networkidle")
            page.wait_for_selector(".cat-bar .chip")
            ck("公共书库显示分类", page.locator(".cat-bar .chip").count() >= 10)
            ck("右侧排行榜有条目", page.locator(".rank-item").count() >= 5)
            ck("右侧上传记录有条目", page.locator(".upload-item").count() >= 5)
            ck("公共书库有示例漫画", page.locator(".comic-card").count() >= 6)
            page.fill(".community-search input.input", "像素")
            page.click('.community-search button:has-text("搜索")')
            page.wait_for_timeout(600)
            ck("书名搜索命中 1 本", page.locator(".comic-card").count() == 1)
            page.click('.cat-bar .chip:has-text("科幻奇幻")')
            page.wait_for_timeout(600)
            ck("分类筛选可激活", page.locator(".cat-bar .chip.active").count() == 1)

            import json as _json
            ctx.request.post(
                BASE + "/api/plaza/posts",
                data=_json.dumps({"content": "求推荐治愈系短篇", "board": "chat"}),
                headers={"Content-Type": "application/json"},
            )
            page.goto(BASE + "/plaza", wait_until="networkidle")
            page.wait_for_selector(".plaza-search")
            page.fill(".plaza-search input.input", "治愈系")
            page.click('.plaza-search button:has-text("搜索")')
            page.wait_for_timeout(600)
            ck("广场全文搜索命中", page.locator(".post-card").count() == 1)

            page.goto(BASE + "/downloads", wait_until="networkidle")
            page.wait_for_selector(".dl-card")
            ck("软件下载页列出安装包", page.locator(".dl-card").count() >= 5)
            ck("软件下载页显示网站地址", BASE in page.locator(".dl-site-url").inner_text())
            page.click('button:has-text("检查更新")')
            page.wait_for_selector(".dl-update")
            ck("检查更新返回版本号", "3.1.0" in page.locator(".dl-update").inner_text())

            page.goto(BASE + "/settings", wait_until="networkidle")
            ck("设置页有软件下载入口", page.locator('a.btn:has-text("软件下载")').count() == 1)
            ck("设置页有公告管理", "站点公告管理" in page.locator(".chapter-list").inner_text())

            browser.close()
        print(f"\n结果：{passed} 通过 / {failed} 失败")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
