"""端到端验证「章节合并」与「撤销合并」。

独立临时数据目录起服务，注册即登录，不碰项目 data/。
覆盖：小说合并拼正文与标题、漫画合并拼页面与文件搬移、
合并后撤销（章节列表与内容恢复）、撤销计次状态。
"""
import io
import os
import sys

import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_mail import start_server, stop_server, wait_port  # noqa: E402

PORT = 8798


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
        s.post(f"{B}/api/auth/register", json={"email": "m@test.local", "password": "pass123", "name": "合并测试"})

        # ---------- 1. 小说合并 ----------
        chapters = [
            {"title": "第一章 起程", "text": "第一章正文内容AAA"},
            {"title": "第二章 遇敌", "text": "第二章正文内容BBB"},
            {"title": "第三章 决意", "text": "第三章正文内容CCC"},
        ]
        r = s.post(f"{B}/api/import/novel", json={"title": "合并测试小说", "chapters": chapters, "mergeShort": False})
        novel = r.json()["comic"]
        nid = novel["id"]
        nch = [c["id"] for c in novel["chapters"]]
        ck("小说导入 3 章", len(nch) == 3, f"{len(nch)}")

        r = s.get(f"{B}/api/comics/{nid}/chapters/merge/undo/status")
        ck("初始无可撤销合并", r.json()["canUndo"] == 0, r.text[:100])

        r = s.post(f"{B}/api/comics/{nid}/chapters/merge", json={"chapterIds": nch, "title": "第一~三章 合并"})
        ck("小说合并成功", r.status_code == 200 and r.json()["merged"] == 3, r.text[:200])
        merged = r.json()["comic"]
        ck("合并后只剩 1 章", len(merged["chapters"]) == 1, f"{len(merged['chapters'])}")
        ck("合并后标题正确", merged["chapters"][0]["title"] == "第一~三章 合并", merged["chapters"][0]["title"])

        txt = s.get(f"{B}/api/novel/{nid}/{merged['chapters'][0]['id']}").json()["text"]
        ck("正文按顺序拼接", "第一章正文内容AAA" in txt and "第二章正文内容BBB" in txt and "第三章正文内容CCC" in txt, txt[:120])

        r = s.get(f"{B}/api/comics/{nid}/chapters/merge/undo/status")
        ck("合并后可撤销", r.json()["canUndo"] == 1, r.text[:100])

        # ---------- 2. 撤销小说合并 ----------
        r = s.post(f"{B}/api/comics/{nid}/chapters/merge/undo")
        ck("撤销合并成功", r.status_code == 200 and r.json()["ok"], r.text[:200])
        restored = r.json()["comic"]
        ck("撤销后恢复 3 章", len(restored["chapters"]) == 3, f"{len(restored['chapters'])}")
        ck("撤销后标题恢复", [c["title"] for c in restored["chapters"]] == [c["title"] for c in chapters],
           [c["title"] for c in restored["chapters"]])
        t1 = s.get(f"{B}/api/novel/{nid}/{restored['chapters'][1]['id']}").json()["text"]
        ck("撤销后第 2 章正文完整恢复", t1.strip() == "第二章 遇敌\n\n第二章正文内容BBB" or "第二章正文内容BBB" in t1, t1[:120])
        r = s.get(f"{B}/api/comics/{nid}/chapters/merge/undo/status")
        ck("撤销后计次清零", r.json()["canUndo"] == 0, r.text[:100])

        # ---------- 3. 漫画合并（图片章节） ----------
        r = s.post(f"{B}/api/comics", json={"title": "合并测试漫画"})
        cid = r.json()["id"]
        ch_ids = []
        for i in range(3):
            ch = s.post(f"{B}/api/comics/{cid}/chapters", json={"title": f"第{i+1}话"}).json()
            ch = ch[-1] if isinstance(ch, list) else ch
            ch_ids.append(ch["id"])
            for j in range(2):
                png = make_png((255 * (i + 1) % 256, 60, 200 * j + 30))
                s.post(f"{B}/api/comics/{cid}/chapters/{ch['id']}/pages",
                       files={"files": (f"p{i}{j}.png", png, "image/png")})
        cc = s.get(f"{B}/api/comics/{cid}").json()
        page_files = {c["id"]: [p["file"] for p in c["pages"]] for c in cc["chapters"]}

        r = s.post(f"{B}/api/comics/{cid}/chapters/merge", json={"chapterIds": ch_ids})
        ck("漫画合并成功", r.status_code == 200 and r.json()["merged"] == 3, r.text[:200])
        mcomic = r.json()["comic"]
        ck("漫画合并后 1 章", len(mcomic["chapters"]) == 1, f"{len(mcomic['chapters'])}")
        ck("漫画合并后 6 页", len(mcomic["chapters"][0]["pages"]) == 6, f"{len(mcomic['chapters'][0]['pages'])}")

        # 页面文件与缩略图可访问（搬到第一章目录）
        ok_urls = 0
        for p in mcomic["chapters"][0]["pages"]:
            r1 = s.get(f"{B}{p['url']}")
            ok_urls += 1 if (r1.status_code == 200 and len(r1.content) > 100) else 0
        ck("合并后 6 张原图全部可读", ok_urls == 6, f"{ok_urls}/6")
        ok_thumbs = 0
        for p in mcomic["chapters"][0]["pages"]:
            r1 = s.get(f"{B}{p['thumbUrl']}")
            ok_thumbs += 1 if (r1.status_code == 200 and len(r1.content) > 50) else 0
        ck("合并后 6 张缩略图全部可读", ok_thumbs == 6, f"{ok_thumbs}/6")

        # ---------- 4. 撤销漫画合并 ----------
        r = s.post(f"{B}/api/comics/{cid}/chapters/merge/undo")
        ck("漫画撤销合并成功", r.status_code == 200 and r.json()["ok"], r.text[:200])
        rc = r.json()["comic"]
        ck("漫画撤销后恢复 3 章", len(rc["chapters"]) == 3, f"{len(rc['chapters'])}")
        rc_full = s.get(f"{B}/api/comics/{cid}").json()
        ok2 = 0
        total = 0
        for c in rc_full["chapters"]:
            for p in c["pages"]:
                total += 1
                r1 = s.get(f"{B}{p['url']}")
                ok2 += 1 if (r1.status_code == 200 and len(r1.content) > 100) else 0
        ck(f"撤销后 {total} 张原图全部可读", total == 6 and ok2 == 6, f"{ok2}/{total}")

        # ---------- 5. 边界 ----------
        r = s.post(f"{B}/api/comics/{cid}/chapters/merge", json={"chapterIds": [ch_ids[0]]})
        ck("只选 1 章被拒绝", r.status_code == 400, r.text[:120])
        r = s.post(f"{B}/api/comics/{cid}/chapters/merge", json={"chapterIds": ["ch不存在", "ch2"]})
        ck("不存在的章节被拒绝", r.status_code == 400, r.text[:120])
        r = s.post(f"{B}/api/comics/{cid}/chapters/merge/undo")
        ck("无可撤销合并时报错", r.status_code == 400, r.text[:120])

        print(f"\n结果：{passed} 通过 / {failed} 失败")
        sys.exit(1 if failed else 0)
    finally:
        stop_server(proc, log)


if __name__ == "__main__":
    main()
