"""浏览器端到端验证：广场分区/富媒体/表情包 + 导入多选排序。"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = "/workspace/comic-vault"
PORT = 8801
BASE = f"http://127.0.0.1:{PORT}"
TMP = "/tmp/cv-ui-files"
CHROMIUM = "/usr/bin/chromium"


def make_files():
    os.makedirs(TMP, exist_ok=True)
    for i, name in enumerate(["01.png", "02.png", "03.png", "04.png"]):
        Image.new("RGB", (20, 26), (60 + i * 40, 90, 180)).save(os.path.join(TMP, name))
    return [os.path.join(TMP, n) for n in ["01.png", "02.png", "03.png", "04.png"]]


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
    files = make_files()
    data_dir = tempfile.mkdtemp(prefix="cv-plaza-ui-")
    env = os.environ.copy()
    env["CV_DATA_DIR"] = data_dir
    env["PORT"] = str(PORT)
    log = open("/tmp/cv-plaza-ui-server.log", "w")
    proc = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env, stdout=log, stderr=log)
    passed, failed = 0, 0

    def ck(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"[PASS] {name}")
        else:
            failed += 1
            print(f"[FAIL] {name}  {detail}")

    try:
        if not wait_port(PORT):
            print(open("/tmp/cv-plaza-ui-server.log").read()[-2500:])
            sys.exit(1)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True, executable_path=CHROMIUM,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            ctx = browser.new_context(viewport={"width": 1280, "height": 920})
            page = ctx.new_page()
            page_errors, console_errors = [], []
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            r = page.request.post(
                f"{BASE}/api/auth/register",
                headers={"Content-Type": "application/json"},
                data=json.dumps({"email": "ui@test.local", "password": "test123456", "name": "测试员"}),
            )
            ck("注册测试账号", r.ok, f"{r.status} {r.text()[:150]}")

            page.goto(f"{BASE}/plaza?sharecode=", wait_until="networkidle")
            page.wait_for_timeout(900)
            ck("广场页加载且无白屏", page.locator(".plaza-page").count() == 1 and
               len(page.locator("body").inner_text()) > 50, page.locator("body").inner_text()[:120])
            ck("分区栏 8 个版块", page.locator(".board-chip").count() == 8,
               str(page.locator(".board-chip").count()))

            # 打字自动搜索表情包
            ta = page.locator(".composer-text")
            ta.fill("哈哈哈 大笑")
            page.wait_for_timeout(350)
            sugg = page.locator(".post-composer .emoji-suggestions")
            ck("打字出现自动搜索表情候选", sugg.count() == 1 and
               sugg.locator(".emoji-suggest-item").count() > 0,
               f"sugg={sugg.count()}")
            before = ta.input_value()
            sugg.locator(".emoji-suggest-item").first.click()
            after = ta.input_value()
            ck("点击候选替换触发词并插入表情", after != before and not after.endswith("大笑"),
               f"before={before!r} after={after!r}")

            # 关闭 / 重新开启（重新输入触发词让候选条再次出现）
            ta.fill("哈哈哈")
            page.wait_for_timeout(350)
            ck("重新输入后候选条再次出现", page.locator(".post-composer .emoji-suggestions").count() == 1)
            page.locator(".post-composer .emoji-suggest-off").click()
            ck("关闭后候选消失", page.locator(".post-composer .emoji-suggestions").count() == 0)
            ck("关闭偏好已保存", page.evaluate("localStorage.getItem('cv-emoji-auto')") == "off")
            page.locator(".composer-tools .chip").click()
            ck("可重新开启自动搜索", page.evaluate("localStorage.getItem('cv-emoji-auto')") == "on")

            # 表情包面板：内置 + 添加自定义
            page.locator(".composer-tools button", has_text="表情包").click()
            ck("表情包面板打开", page.locator(".emoji-panel").count() == 1)
            ck("内置表情网格有内容", page.locator(".emoji-builtin").count() > 10,
               str(page.locator(".emoji-builtin").count()))
            page.locator(".emoji-tabs button", has_text="图片表情包").click()
            ck("添加表情包表单可见", page.locator(".emoji-add").count() == 1)
            page.locator(".emoji-add input[type=file]").set_input_files(files[0])
            page.locator(".emoji-add input.input").nth(0).fill("捧腹大笑")
            page.locator(".emoji-add input.input").nth(1).fill("笑,哈哈,开心")
            page.locator(".emoji-add button", has_text="添加").click()
            page.wait_for_timeout(900)
            ck("自定义表情包添加成功", page.locator(".emoji-cell").count() >= 1,
               f"cells={page.locator('.emoji-cell').count()}")
            page.locator(".emoji-cell > button").first.click()
            ck("正文插入 [emoji:] 标记", "[emoji:" in page.locator(".composer-text").input_value(),
               page.locator(".composer-text").input_value()[:120])
            page.locator(".emoji-panel-head button").last.click()

            # 多选附件
            page.locator(".composer-tools input[type=file]").set_input_files([files[0], files[1]])
            page.wait_for_timeout(900)
            ck("一次多选 2 个图片附件", page.locator(".composer-att").count() == 2,
               str(page.locator(".composer-att").count()))

            # 选分区并发布
            page.locator(".board-select").select_option("sticker")
            page.locator(".composer-bottom button.btn.primary").click()
            page.wait_for_timeout(1400)
            ck("帖子发布成功", page.locator(".post-card").count() == 1,
               str(page.locator(".post-card").count()))
            ck("显示分区徽章", "斗图表情" in page.locator(".post-board-badge").first.inner_text(),
               page.locator(".post-board-badge").first.inner_text())
            ck("图片附件渲染为网格", page.locator(".post-image-grid img").count() == 2,
               str(page.locator(".post-image-grid img").count()))
            ck("正文表情包渲染为图片", page.locator(".post-content .inline-emoji").count() >= 1,
               str(page.locator(".post-content .inline-emoji").count()))

            # 分区筛选
            page.locator(".board-chip", has_text="斗图表情").click()
            page.wait_for_timeout(700)
            ck("sticker 分区包含该帖", page.locator(".post-card").count() == 1,
               str(page.locator(".post-card").count()))
            page.locator(".board-chip", has_text="综合讨论").click()
            page.wait_for_timeout(700)
            ck("chat 分区不含该帖", page.locator(".post-card").count() == 0,
               str(page.locator(".post-card").count()))
            page.locator(".board-chip", has_text="全部").click()
            page.wait_for_timeout(700)

            # 评论表情包
            ci = page.locator(".comment-composer input.input").first
            ci.fill("笑")
            page.wait_for_timeout(350)
            ck("评论框也支持自动搜索", page.locator(".comment-composer .emoji-suggestions").count() == 1)
            page.locator(".comment-composer .emoji-suggest-item").first.click()
            page.locator(".comment-composer button", has_text="发送").click()
            page.wait_for_timeout(1000)
            ck("评论渲染表情包图片", page.locator(".comment .inline-emoji").count() >= 1,
               str(page.locator(".comment .inline-emoji").count()))

            # 导入：多选 + 排序
            page.goto(f"{BASE}/", wait_until="networkidle")
            page.wait_for_timeout(600)
            page.locator("button", has_text="导入漫画").first.click()
            page.wait_for_timeout(400)
            ck("导入对话框打开", page.locator(".modal .dropzone, .modal-body .dropzone").count() >= 1 or
               page.locator("#cv-import-images").count() == 1,
               f"dropzone={page.locator('.dropzone').count()}")
            page.locator("#cv-import-images").set_input_files([files[2], files[0], files[1], files[3]])
            page.wait_for_timeout(1000)
            ck("排序面板出现", page.locator(".sort-panel").count() == 1)
            ck("多选 4 个文件", page.locator(".sort-item").count() == 4,
               str(page.locator(".sort-item").count()))
            names = [n.strip() for n in page.locator(".sort-name").all_inner_texts()]
            ck("默认按名称自然排序", names == ["01.png", "02.png", "03.png", "04.png"], str(names))
            page.locator(".sort-item").first.locator(".sort-ops button").nth(1).click()
            page.wait_for_timeout(300)
            names2 = [n.strip() for n in page.locator(".sort-name").all_inner_texts()]
            ck("下移按钮改变顺序", names2 == ["02.png", "01.png", "03.png", "04.png"], str(names2))
            ck("切换为自定义顺序", "自定义顺序" in page.locator(".sort-mode").inner_text(),
               page.locator(".sort-mode").inner_text())
            page.locator(".sort-panel-head .chip", has_text="反转").click()
            page.wait_for_timeout(250)
            names3 = [n.strip() for n in page.locator(".sort-name").all_inner_texts()]
            ck("反转按钮生效", names3 == ["04.png", "03.png", "01.png", "02.png"], str(names3))
            # 恢复成后移后的顺序，再导入，验证服务端页序
            page.locator(".sort-panel-head .chip", has_text="反转").click()
            page.wait_for_timeout(250)

            page.locator(".modal-foot button", has_text="开始导入").click()
            page.wait_for_timeout(3500)
            url = page.url
            ck("导入后跳转到漫画详情", "/comic/" in url, url)
            if "/comic/" in url:
                cid = url.split("/comic/")[-1].split("?")[0]
                detail = page.request.get(f"{BASE}/api/comics/{cid}").json()
                pages = detail["chapters"][0]["pages"]
                got = [p.get("name", "") for p in pages]
                ck("服务端页序与手动排序一致", got == ["02.png", "01.png", "03.png", "04.png"], str(got))

            ck("无页面异常", len(page_errors) == 0, str(page_errors[:3]))
            ck("无控制台错误", len(console_errors) == 0, str(console_errors[:3]))
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print("\n服务日志尾部：")
        print(open("/tmp/cv-plaza-ui-server.log").read()[-1000:])

    print(f"\n合计 {passed} 通过 / {failed} 失败")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
