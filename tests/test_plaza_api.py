"""在独立临时数据目录启动后端，验证广场分区 / 附件 / 表情包 API。"""
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import requests
from PIL import Image

ROOT = "/workspace/comic-vault"
PORT = 8803
BASE = f"http://127.0.0.1:{PORT}"


def wait_port(port, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def png_bytes():
    buf = io.BytesIO()
    Image.new("RGBA", (8, 8), (124, 108, 255, 255)).save(buf, "PNG")
    return buf.getvalue()


def main():
    data_dir = tempfile.mkdtemp(prefix="cv-plaza-test-")
    env = os.environ.copy()
    env["CV_DATA_DIR"] = data_dir
    env["PORT"] = str(PORT)
    log = open("/tmp/cv-plaza-server.log", "w")
    proc = subprocess.Popen(
        ["node", "server/index.js"], cwd=ROOT, env=env, stdout=log, stderr=log
    )
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
            print("服务未启动，日志：")
            print(open("/tmp/cv-plaza-server.log").read()[-3000:])
            sys.exit(1)

        a = requests.Session()
        b = requests.Session()

        # 1) 分区列表
        r = a.get(f"{BASE}/api/plaza/boards")
        boards = r.json()["boards"]
        ck("分区列表返回 8 个版块（含全部）", r.status_code == 200 and len(boards) == 8,
           f"status={r.status_code} n={len(boards)}")
        ck("分区含预期 id", {x["id"] for x in boards} >= {"all", "chat", "recommend", "sticker"},
           str([x["id"] for x in boards]))

        # 2) 注册两个用户
        for s, email in ((a, "plaza_a@test.local"), (b, "plaza_b@test.local")):
            r = s.post(f"{BASE}/api/auth/register",
                       json={"email": email, "password": "test123456", "name": email[0]})
            ck(f"注册 {email}", r.status_code == 200, r.text[:200])

        # 3) 未登录上传应被拒绝
        anon = requests.Session()
        r = anon.post(f"{BASE}/api/plaza/upload", files={"files": ("x.png", png_bytes(), "image/png")})
        ck("未登录上传返回 401", r.status_code == 401, f"status={r.status_code}")

        # 4) 上传图片 + 文本文件 + 视频
        files = [
            ("files", ("封面.png", png_bytes(), "image/png")),
            ("files", ("说明.txt", b"hello comic vault", "text/plain")),
            ("files", ("片段.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")),
        ]
        r = a.post(f"{BASE}/api/plaza/upload", files=files)
        atts = r.json().get("attachments", []) if r.status_code == 200 else []
        ck("一次上传 3 个附件成功", r.status_code == 200 and len(atts) == 3,
           f"status={r.status_code} body={r.text[:300]}")
        kinds = sorted(x["kind"] for x in atts)
        ck("附件类型识别为 image/file/video", kinds == ["file", "image", "video"], str(kinds))
        ck("附件 url 不带 sharecode", all("sharecode" not in x["url"] for x in atts),
           str([x["url"] for x in atts]))

        # 5) 附件读取
        img = next(x for x in atts if x["kind"] == "image")
        txt = next(x for x in atts if x["kind"] == "file")
        r = a.get(BASE + img["url"])
        ck("图片附件可读且 Content-Type 正确",
           r.status_code == 200 and r.headers.get("Content-Type", "").startswith("image/png"),
           f"status={r.status_code} ct={r.headers.get('Content-Type')}")
        r = a.get(BASE + txt["url"] + "?name=%E8%AF%B4%E6%98%8E.txt")
        disp = r.headers.get("Content-Disposition", "")
        ck("文件附件走下载且中文名 RFC5987 编码",
           r.status_code == 200 and "attachment" in disp and "filename*=UTF-8''" in disp,
           f"status={r.status_code} disp={disp}")
        r = a.get(f"{BASE}/api/plaza/media/..%2Fdb.json")
        ck("非法文件名被拒绝", r.status_code in (400, 404), f"status={r.status_code}")

        # 6) 禁止脚本类文件
        r = a.post(f"{BASE}/api/plaza/upload", files={"files": ("x.html", b"<script>", "text/html")})
        ck("html 附件被拒绝", r.status_code == 400, f"status={r.status_code} {r.text[:150]}")

        # 7) 表情包：添加 / 搜索 / 权限
        r = a.post(f"{BASE}/api/plaza/emojis", json={
            "name": "捧腹大笑", "tags": "笑,哈哈,开心", "url": img["url"],
        })
        ck("添加自定义表情包", r.status_code == 200, r.text[:250])
        emoji = r.json()["emoji"]
        ck("表情包返回 file 文件名", emoji["file"].startswith("p_") and emoji["file"].endswith(".png"),
           str(emoji))
        r = a.get(f"{BASE}/api/plaza/emojis?q=%E7%AC%91")
        ck("按关键词搜索表情包", r.status_code == 200 and len(r.json()["emojis"]) == 1,
           r.text[:200])
        r = a.get(f"{BASE}/api/plaza/emojis?q=zzzz")
        ck("无关关键词返回空", r.json()["emojis"] == [], r.text[:150])

        # 把带码 URL 回传，验证服务端归一化
        r = a.post(f"{BASE}/api/plaza/emojis", json={
            "name": "带码测试", "tags": "test",
            "url": img["url"] + "?sharecode=HDZTNNHTBW",
        })
        ck("带 sharecode 的 URL 被归一化", r.status_code == 200 and
           "sharecode" not in r.json()["emoji"]["url"], r.text[:250])
        tmp_emoji = r.json()["emoji"]["id"]
        a.delete(f"{BASE}/api/plaza/emojis/{tmp_emoji}")

        r = b.delete(f"{BASE}/api/plaza/emojis/{emoji['id']}")
        ck("不能删除别人添加的表情包", r.status_code == 403 and "自己" in r.text,
           f"status={r.status_code} {r.text[:150]}")
        r = a.delete(f"{BASE}/api/plaza/emojis/{emoji['id']}")
        ck("可以删除自己添加的表情包", r.status_code == 200, r.text[:150])

        # 8) 发帖：分区 + 附件 + 表情包标记
        body = {
            "content": "推荐一部好漫画 [emoji:" + img["url"].split("/")[-1] + "] 😂",
            "board": "sticker",
            "attachments": [
                {**img, "url": img["url"] + "?sharecode=HDZTNNHTBW"},
                txt,
            ],
        }
        r = a.post(f"{BASE}/api/plaza/posts", json=body)
        ck("发帖（分区+附件）成功", r.status_code == 200, r.text[:300])
        post = r.json().get("post", {}) if r.status_code == 200 else {}
        ck("帖子保存分区 board=sticker", post.get("board") == "sticker", str(post.get("board")))
        ck("帖子附件地址已归一化", all("sharecode" not in x["url"] for x in post.get("attachments", [])),
           str(post.get("attachments")))
        ck("帖子保存表情包标记", "[emoji:" in post.get("content", ""), post.get("content", ""))

        # 9) 分区筛选
        r = a.get(f"{BASE}/api/plaza/posts?board=sticker")
        d = r.json()
        ck("sticker 分区筛出该帖", r.status_code == 200 and len(d["posts"]) == 1,
           f"n={len(d.get('posts'))}")
        ck("分区计数正确", next(x for x in d["boards"] if x["id"] == "sticker")["count"] == 1,
           str(d.get("boards")))
        r = a.get(f"{BASE}/api/plaza/posts?board=chat")
        ck("chat 分区不含该帖", len(r.json()["posts"]) == 0, str(len(r.json()["posts"])))
        r = a.get(f"{BASE}/api/plaza/posts")
        ck("全部视图含该帖且 boards 一并返回",
           len(r.json()["posts"]) == 1 and len(r.json()["boards"]) == 8,
           r.text[:150])

        # 10) 纯附件发帖（无文字）
        r = a.post(f"{BASE}/api/plaza/posts", json={"content": "", "board": "share", "attachments": [img]})
        ck("仅附件无文字也能发帖", r.status_code == 200, r.text[:200])
        r = a.post(f"{BASE}/api/plaza/posts", json={"content": "", "board": "chat"})
        ck("空内容且无附件被拒绝", r.status_code == 400, f"status={r.status_code}")

        # 11) 评论带表情包
        pid = post["id"]
        r = a.post(f"{BASE}/api/plaza/posts/{pid}/comments",
                   json={"content": "哈哈 [emoji:" + img["url"].split("/")[-1] + "]"})
        ck("评论支持表情包标记且长度放宽", r.status_code == 200 and
           "[emoji:" in r.json()["post"]["comments"][0]["content"], r.text[:200])

        # 12) 表情包图片仍可访问（删记录不删文件）
        r = a.get(BASE + img["url"])
        ck("删除表情包记录后图片仍可访问", r.status_code == 200, f"status={r.status_code}")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print("\n服务日志尾部：")
        print(open("/tmp/cv-plaza-server.log").read()[-1200:])

    print(f"\n合计 {passed} 通过 / {failed} 失败")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
