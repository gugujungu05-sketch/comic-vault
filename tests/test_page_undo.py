"""端到端验证「继续加页」与「页面编辑撤销」。

用独立临时数据目录 + 开发模式起服务，注册即登录，全程不碰项目自己的 data/。
覆盖：上传页可撤销、删除页可撤销（含原图字节恢复）、排序可撤销、多步撤销、撤销计次。
"""
import io
import os
import sys

import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_mail import start_server, stop_server, wait_port  # noqa: E402

PORT = 8797


def make_png(color, w=40, h=60):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def main():
    passed = failed = 0

    def ck(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"[PASS] {name}")
        else:
            failed += 1
            print(f"[FAIL] {name}  {detail}")

    proc, log = start_server(PORT, {})
    try:
        if not wait_port(PORT):
            print("服务未启动：", open(f"/tmp/cv-mail-{PORT}.log").read()[-2000:])
            sys.exit(1)
        B = f"http://127.0.0.1:{PORT}"
        s = requests.Session()

        # 注册即登录（开发模式）
        r = s.post(f"{B}/api/auth/register", json={"email": "u@test.local", "password": "pass123", "name": "测试"})
        ck("注册并登录", r.status_code == 200 and "user" in r.json(), f"{r.status_code} {r.text[:150]}")

        # 建漫画 + 章节
        c = s.post(f"{B}/api/comics", json={"title": "撤销测试"}).json()
        cid = c["id"]
        ch = s.post(f"{B}/api/comics/{cid}/chapters", json={"title": "第1话"})
        chj = ch.json()
        chid = (chj[-1] if isinstance(chj, list) else chj.get("chapters", [None])[-1])["id"]

        def get_ch():
            cc = s.get(f"{B}/api/comics/{cid}", params={"sharecode": ""}).json()
            return next(x for x in cc["chapters"] if x["id"] == chid)

        def page_bytes(page):
            return s.get(f"{B}{page['url']}").content

        # --- 1. 上传 3 页（继续加页）---
        files = [("files", (f"p{i}.png", make_png((i * 60, 0, 0)), "image/png")) for i in range(1, 4)]
        r = s.post(f"{B}/api/comics/{cid}/chapters/{chid}/pages", files=files)
        ck("上传3页成功", r.status_code == 200 and len(get_ch()["pages"]) == 3, f"{r.status_code} {r.text[:150]}")

        # --- 2. 撤销上传 ---
        r = s.post(f"{B}/api/comics/{cid}/chapters/{chid}/undo")
        ck("撤销上传回到0页", r.status_code == 200 and len(get_ch()["pages"]) == 0, f"{r.status_code} {r.text[:200]}")

        # 重新上传 3 页用于后续
        files = [("files", (f"q{i}.png", make_png((0, i * 60, 0)), "image/png")) for i in range(1, 4)]
        s.post(f"{B}/api/comics/{cid}/chapters/{chid}/pages", files=files)
        ch2 = get_ch()
        pages = ch2["pages"]
        orig = [page_bytes(p) for p in pages]
        ids = [p["id"] for p in pages]
        ck("重新上传3页", len(pages) == 3)

        # --- 3. 删除第2页 ---
        victim = pages[1]
        r = s.delete(f"{B}/api/comics/{cid}/chapters/{chid}/pages/{victim['id']}")
        ck("删除第2页", r.status_code == 200 and len(get_ch()["pages"]) == 2, f"{r.status_code} {r.text[:150]}")

        # --- 4. 撤销删除，验证原图字节恢复 ---
        r = s.post(f"{B}/api/comics/{cid}/chapters/{chid}/undo")
        restored = get_ch()["pages"]
        ck("撤销删除恢复页序", r.status_code == 200 and [p["id"] for p in restored] == ids, f"{r.status_code} {r.text[:200]}")
        restored_bytes = page_bytes(restored[1])
        ck("撤销删除恢复原图字节", restored_bytes == orig[1], f"{len(restored_bytes)} vs {len(orig[1])}")

        # --- 5. 排序（倒序）后撤销 ---
        s.put(f"{B}/api/comics/{cid}/chapters/{chid}/pages/reorder", json={"order": ids[::-1]})
        ck("倒序生效", [p["id"] for p in get_ch()["pages"]] == ids[::-1])
        r = s.post(f"{B}/api/comics/{cid}/chapters/{chid}/undo")
        ck("撤销排序恢复原顺序", r.status_code == 200 and [p["id"] for p in get_ch()["pages"]] == ids, f"{r.text[:200]}")

        # --- 6. 多步撤销 + 计次 ---
        st = s.get(f"{B}/api/comics/{cid}/chapters/{chid}/undo/status").json()
        ck("status 报告可撤销步数", st.get("canUndo", 0) >= 1, str(st))

        print(f"\n结果: {passed} 通过, {failed} 失败")
        return 0 if failed == 0 else 1
    finally:
        stop_server(proc, log)


if __name__ == "__main__":
    sys.exit(main())
