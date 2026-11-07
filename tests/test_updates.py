#!/usr/bin/env python3
"""追更功能端到端验证：mock 站点 + 订阅检查 + 自动下载新章节。"""
import json, os, signal, subprocess, sys, time, urllib.request, http.cookiejar, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

API = "http://127.0.0.1:8817"
MOCK = "http://127.0.0.1:8818"
P = F = 0
def ck(name, cond, extra=""):
    global P, F
    P += 1 if cond else 0
    F += 0 if cond else 1
    print(("[PASS] " if cond else "[FAIL] ") + name, "" if cond else extra)

# 1x1 PNG
PNG = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000" +
                    "01f15c4890000000d49444154789c626001000000ffff030000060005" +
                    "57bfabd40000000049454e44ae426082")

CHAPTERS = {"第 1 话 x": 1, "第 2 话 x": 2}

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, body, ct="text/html; charset=utf-8"):
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        p = self.path
        import sys as _s; print("[MOCK]", p, file=_s.stderr, flush=True)
        if p.startswith("/comic"):
            items = "".join(
                f'<div class="item"><h2>{t}</h2><a href="{MOCK}/c{i}">详情</a></div>'
                for i, t in enumerate(CHAPTERS))
            self._send(f"<html><body>{items}</body></html>".encode())
        elif p.startswith("/ch?"):
            from urllib.parse import urlparse, parse_qs, unquote
            t = unquote(parse_qs(urlparse(p).query)["t"][0])
            n = CHAPTERS[t]
            imgs = "".join(f'<div class="content"><img src="{MOCK}/img?t={t}&i={i}"/></div>'
                           for i in range(n))
            self._send(imgs.encode())
        elif p.startswith("/img"):
            self._send(PNG, "image/png")
        elif p.startswith("/c"):
            links = "".join(f'<div class="chapter-list"><a href="{MOCK}/ch?t={t}">{t}</a></div>'
                            for t in CHAPTERS)
            self._send(f"<html><body><h1>测试漫画</h1>{links}</body></html>".encode())
        else:
            self._send(b"<html></html>")

def start_mock():
    srv = HTTPServer(("127.0.0.1", 8818), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def api(method, path, body=None, cookie=None, raw=False):
    req = urllib.request.Request(API + path, method=method)
    if cookie: req.add_header("Cookie", cookie)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b)), dict(r.headers)
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b), dict(e.headers)
        except Exception: return e.code, b, dict(e.headers)

def main():
    global P, F
    start_mock()
    env = dict(os.environ, PORT="8817", CV_DATA_DIR="/tmp/cv-upd-test", CV_NO_DOTENV="1")
    os.system("rm -rf /tmp/cv-upd-test")
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(["node", "server/index.js"], cwd=ROOT,
                            env=env, stdout=open("/tmp/cv-upd.log", "w"), stderr=subprocess.STDOUT)
    # 等服务起来
    for _ in range(60):
        try:
            api("GET", "/api/runtime"); break
        except Exception: time.sleep(0.5)
    try:
        # 注册登录
        s, r, h = api("POST", "/api/auth/register", {"email": "t@t.com", "password": "123456", "name": "测试"})
        ck("注册", s == 200, str(r))
        cookie = "; ".join(f"{k}={v}" for k, v in
                           [tuple(x.strip().split("=", 1)) for x in h.get("Set-Cookie", "").split(";") if "=" in x and x.strip().split("=",1)[0] in ("cv_session", "cv_uid")]) or h.get("Set-Cookie", "").split(";")[0]
        # 建书源
        s, r, _ = api("POST", "/api/sources", {
            "name": "mock", "baseUrl": MOCK,
            "rules": {
                "search": {"url": "/comic?q={kw}", "item": ".item", "title": "h2@text", "link": "a@href"},
                "comic": {"title": "h1@text", "chapterItem": ".chapter-list a", "chapterTitle": "@text", "chapterLink": "@href"},
                "chapter": {"image": ".content img@src"},
            }}, cookie)
        ck("建书源", s == 200, str(r))
        sid = r.get("id")
        # 手动导入第 1 话
        s, r, _ = api("POST", "/api/sources/import", {
            "sourceId": sid, "title": "测试漫画", "comicUrl": MOCK + "/c0",
            "chapterTitle": "第 1 话 x", "chapterUrl": MOCK + "/ch?t=%E7%AC%AC%201%20%E8%AF%9D%20x"}, cookie)
        ck("手动导入第1话", s == 200 and r.get("stored") == 1, str(r))
        comicId = r.get("comicId")
        # 创建订阅（关联这本漫画，开自动下载）
        s, r, _ = api("POST", "/api/subscriptions", {
            "sourceId": sid, "url": MOCK + "/c0", "comicId": comicId,
            "autoDownload": True, "intervalMin": 10}, cookie)
        ck("创建订阅", s == 200, str(r))
        subId = r["subscription"]["id"]
        ck("订阅章节快照=2", r["subscription"]["chapterCount"] == 2, str(r))
        # 立即检查：没有新章节
        s, r, _ = api("POST", f"/api/subscriptions/{subId}/check", {}, cookie)
        ck("首次检查无新章", s == 200 and r["fresh"] == 0, str(r))
        # mock 站加第 3 话（页数更多）
        CHAPTERS["第 3 话 x"] = 3
        s, r, _ = api("POST", f"/api/subscriptions/{subId}/check", {}, cookie)
        ck("检查发现1话新章", s == 200 and r["fresh"] == 1, str(r))
        ck("自动下载了1话", r["imported"] == 1, str(r))
        # 验证书库漫画现在有 2 话
        s, r, _ = api("GET", f"/api/comics/{comicId}", cookie=cookie)
        n = len(r.get("chapters", []))
        ck("书库漫画变为2话", s == 200 and n == 2, f"实际 {n}")
        # 订阅列表
        s, r, _ = api("GET", "/api/subscriptions", cookie=cookie)
        lst = r.get("subscriptions", [])
        ck("订阅列表可查", s == 200 and len(lst) == 1 and lst[0]["newCount"] == 1, str(lst))
        # 改间隔 / 暂停
        s, r, _ = api("PUT", f"/api/subscriptions/{subId}", {"intervalMin": 60, "enabled": False}, cookie)
        ck("修改订阅", s == 200 and r["subscription"]["enabled"] is False, str(r))
        # 进度接口
        ch1 = r if False else None
        s, r, _ = api("GET", f"/api/comics/{comicId}", cookie=cookie)
        cid = r["chapters"][0]["id"]
        s, r, _ = api("PUT", f"/api/comics/{comicId}/progress", {"chapterId": cid, "pageIndex": 0}, cookie)
        ck("写入阅读进度", s == 200, str(r))
        s, r, _ = api("GET", "/api/comics", cookie=cookie)
        ck("书架返回进度", r["comics"][0].get("progress", {}).get("chapterId") == cid, str(r.get("comics", [{}])[0].get("progress")))
        # 导出 CBZ（字节级验证 zip 头）
        s, b, _ = api("GET", f"/api/export/{comicId}?format=cbz", raw=True, cookie=cookie)
        if not isinstance(b, (bytes, bytearray)):
            print("[FAIL] 导出 CBZ", s, str(b)[:300]); F += 1
        else:
            ck("整本导出 CBZ", s == 200 and b[:2] == b"PK", f"{s} {b[:4]}")
        print(f"\n合计 {P} 通过 / {F} 失败")
        return 1 if F else 0
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=5)
        except Exception: proc.kill()

if __name__ == "__main__":
    sys.exit(main())
