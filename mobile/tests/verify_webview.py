"""复现「手机端 WebView 兼容性」验证。

Android WebView 与 Chrome 的关键差异在 Service Worker。本脚本用
service_workers='block' 模拟手机 App 内的纯网络模式，逐个检查线上站点
的页面渲染、接口、图片与凭据注入。

依赖：
    pip install playwright && playwright install chromium
    （脚本默认使用 /usr/bin/chromium，可用 CV_CHROMIUM 覆盖）

用法：
    python3 mobile/tests/verify_webview.py
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CV_BASE", "https://a3375579f1d0038dc.app.workbuddy.host")
CODE = os.environ.get("CV_SHARECODE", "HDZTNNHTBW")
CHROMIUM = os.environ.get("CV_CHROMIUM", "/usr/bin/chromium")
Q = f"sharecode={CODE}"

PAGES = [
    ("首页", f"/?{Q}", False),
    ("设置页", f"/settings?{Q}", False),
    ("公共书库", f"/community?{Q}", True),
    ("漫画详情", "/comic/c_TziK0bd8-XUh?" + Q, True),
    ("阅读器", "/read/c_TziK0bd8-XUh?" + Q, True),
]

UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 "
    "ComicVaultAndroid/1.0"
)


def check(pw, name, path, expect_images):
    browser = pw.chromium.launch(
        headless=True,
        executable_path=CHROMIUM,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    ctx = browser.new_context(
        service_workers="block",  # 关键：模拟 App 内禁用 SW 的纯网络模式
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        user_agent=UA,
    )
    page = ctx.new_page()
    errors, failed, bad = [], [], []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("requestfailed", lambda r: failed.append(r.url))
    page.on("response", lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)

    page.goto(BASE + path, wait_until="networkidle", timeout=90000)
    page.wait_for_timeout(3000)

    info = page.evaluate(
        """() => ({
            bodyLen: (document.body.innerText || '').length,
            swController: !!navigator.serviceWorker?.controller,
            images: [...document.images].map(i => ({
                src: i.currentSrc || i.src,
                ok: i.complete && i.naturalWidth > 0,
            })),
        })"""
    )
    runtime = page.evaluate(
        """async () => {
            try { const r = await fetch('/api/runtime'); return r.status; }
            catch (e) { return -1; }
        }"""
    )
    browser.close()

    # 未登录时保存阅读进度会返回 401，属正常业务行为，不算兼容性问题
    ignorable = lambda e: "Failed to load resource" in e
    real_errors = [e for e in errors if not ignorable(e)]
    missing = [i["src"] for i in info["images"]
               if "/api/" in i["src"] and "sharecode=" not in i["src"]]
    broken = [i for i in info["images"] if not i["ok"]]
    real_bad = [(s, u) for s, u in bad if s != 401]

    problems = []
    if info["bodyLen"] < 20:
        problems.append("页面疑似白屏")
    if info["swController"]:
        problems.append("Service Worker 未被禁用")
    if runtime != 200:
        problems.append(f"/api/runtime 返回 {runtime}")
    if real_errors:
        problems.append(f"控制台/页面异常 {len(real_errors)} 条")
    if failed:
        problems.append(f"请求失败 {len(failed)} 条")
    if real_bad:
        problems.append(f"HTTP 错误 {real_bad[:3]}")
    if missing:
        problems.append(f"图片缺 sharecode {len(missing)} 张")
    if broken:
        problems.append(f"图片加载失败 {len(broken)} 张")
    if expect_images and not info["images"]:
        problems.append("预期有图片但页面没有 <img>")

    ok = not problems
    print(f"[{'PASS' if ok else 'FAIL'}] {name:<8} 文本 {info['bodyLen']:>4} 字 | "
          f"图片 {len(info['images'])} 张 | SW {info['swController']} | "
          f"runtime {runtime} | 4xx {len(real_bad)}")
    for p in problems:
        print("        - " + p)
    return ok


def main():
    with sync_playwright() as pw:
        results = [check(pw, *args) for args in PAGES]
    print("-" * 66)
    print(f"合计 {sum(results)}/{len(results)} 项通过（禁用 Service Worker 的 WebView 场景）")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
