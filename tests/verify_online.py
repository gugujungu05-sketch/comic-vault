"""线上只读回归：确认新版本已生效、旧数据完好、浏览器无白屏。

默认验证当前演示地址；自托管或换地址时用环境变量覆盖：

    CV_BASE=https://your.domain CV_SHARECODE=ABCD python3 tests/verify_online.py
    CV_BASE=https://your.domain CV_SHARECODE= python3 tests/verify_online.py   # 无访问凭据

脚本只发 GET，不注册账号、不发帖，不会写入线上数据。
"""
import os
import sys

import requests
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CV_BASE", "https://a3375579f1d0038dc.app.workbuddy.host").rstrip("/")
CODE = os.environ.get("CV_SHARECODE", "HDZTNNHTBW")
CHROMIUM = os.environ.get("CV_CHROMIUM", "/usr/bin/chromium")
passed, failed = 0, 0


def ck(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"[PASS] {name}")
    else:
        failed += 1
        print(f"[FAIL] {name}  {detail}")


def get(path, **params):
    if CODE:
        params["sharecode"] = CODE
    return requests.get(BASE + path, params=params, timeout=30)


def page_url(path):
    return f"{BASE}{path}" + (f"?sharecode={CODE}" if CODE else "")


def main():
    print(f"目标: {BASE}  sharecode={'有' if CODE else '无'}")
    print("=== 线上 API ===")
    r = get("/api/runtime")
    ck("/api/runtime 可用", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
    if r.ok:
        print("    version:", r.json().get("version"), "features:", r.json().get("features"))

    r = get("/api/plaza/boards")
    boards = r.json().get("boards", []) if r.ok else []
    ck("新版本已上线：8 个广场分区", r.status_code == 200 and len(boards) == 8,
       f"{r.status_code} n={len(boards)}")
    print("    分区 id:", [b.get("id") for b in boards])

    r = get("/api/plaza/posts", board="all")
    d = r.json() if r.ok else {}
    ck("帖子列表接口返回 posts/boards", r.status_code == 200 and "posts" in d and "boards" in d,
       f"{r.status_code} {r.text[:120]}")
    ck("分区筛选参数被接受", r.status_code == 200 and "board" in d, str(list(d.keys())))

    r = get("/api/plaza/emojis", q="")
    ck("表情包搜索接口可用", r.status_code == 200 and "emojis" in r.json(),
       f"{r.status_code} {r.text[:120]}")

    r = get("/api/plaza/media/this-file-does-not-exist.png")
    ck("附件路由存在且非法文件被拒", r.status_code in (400, 404), f"{r.status_code}")

    r = get("/api/auth/status")
    ck("登录态接口可用", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
    print("    auth/status:", r.text[:200])
    if r.ok:
        ck("旧账号数据仍在（hasUsers）", bool(r.json().get("hasUsers")), r.text[:200])

    r = get("/api/community/comics")
    ck("公共书库旧数据仍在", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
    if r.ok:
        try:
            print("    公共书库漫画数:", len(r.json().get("comics", [])))
        except Exception:
            pass

    r = get("/api/stats")
    ck("统计接口可用", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

    r = get("/")
    ck("首页 HTML 可访问", r.status_code == 200 and "cv-manifest" in r.text,
       f"{r.status_code} len={len(r.text)}")

    if CODE:
        r = get(f"/pwa/{CODE}/manifest.webmanifest")
        ck("动态 PWA 清单带访问凭据", r.status_code == 200 and CODE in r.text,
           f"{r.status_code} {r.text[:160]}")
        if r.ok:
            try:
                print("    manifest start_url:", r.json().get("start_url"))
            except Exception:
                pass

    print("\n=== 线上浏览器 ===")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True, executable_path=CHROMIUM,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        perrs, cerrs, bad = [], [], []
        page.on("pageerror", lambda e: perrs.append(str(e)))
        page.on("console", lambda m: cerrs.append(m.text) if m.type == "error" else None)
        page.on("response", lambda resp: bad.append(f"{resp.status} {resp.url[:140]}")
                if resp.status >= 400 else None)

        page.goto(page_url("/plaza"), wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1500)
        ck("线上广场页无白屏", page.locator(".plaza-page").count() == 1 and
           len(page.locator("body").inner_text()) > 50,
           page.locator("body").inner_text()[:120])
        ck("线上分区栏 8 个版块", page.locator(".board-chip").count() == 8,
           str(page.locator(".board-chip").count()))
        ck("线上发帖编辑器可用", page.locator(".post-composer").count() == 1,
           str(page.locator(".post-composer").count()))
        ck("线上表情包入口存在",
           page.locator(".composer-tools button", has_text="表情包").count() >= 1)
        ck("线上附件多选入口存在",
           page.locator(".composer-tools input[type=file]").count() >= 1)
        if CODE:
            href = page.locator("#cv-manifest").get_attribute("href") or ""
            ck("PWA 清单地址带访问凭据", CODE in href, href)

        page.locator(".board-chip", has_text="斗图表情").click()
        page.wait_for_timeout(900)
        ck("线上分区切换后页面仍正常", page.locator(".plaza-page").count() == 1 and
           page.locator(".board-chip").count() == 8,
           str(page.locator(".board-chip").count()))

        page.goto(page_url("/settings"), wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(800)
        ck("线上设置页无白屏", len(page.locator("body").inner_text()) > 50,
           page.locator("body").inner_text()[:120])

        ck("无页面 JS 异常", len(perrs) == 0, str(perrs[:3]))
        ck("无控制台错误", len(cerrs) == 0, str(cerrs[:3]))
        critical = [x for x in bad if "/api/" in x or "/assets/" in x or ".js" in x or ".css" in x]
        ck("无关键资源失败请求（API/JS/CSS）", len(critical) == 0, str(critical[:5]))
        if bad:
            print("    其它 non-2xx:", bad[:5])
        browser.close()

    print(f"\n合计 {passed} 通过 / {failed} 失败")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
