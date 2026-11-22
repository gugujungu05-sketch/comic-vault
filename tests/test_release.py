#!/usr/bin/env python3
"""
回归：单一版本源 / 四段版本号 / 一键发版 / 网站自动更新安装包。

用独立端口 8815 起一个临时服务 + 临时数据目录，不碰线上数据。
验证：version.json 与 API 一致、四段版本比较正确、清单热更新不重启即生效、
真实体积与 SHA256 正确、/files 直链可下载且支持 Range、入口页教程与版本显示。
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8815
BASE = f"http://127.0.0.1:{PORT}"
P = F = 0


def ck(name, cond, extra=""):
    global P, F
    if cond:
        P += 1
        print("[PASS]", name)
    else:
        F += 1
        print("[FAIL]", name, extra)


def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read(), dict(r.headers)


def get_json(path):
    st, body, _ = get(path)
    return st, json.loads(body)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", PORT))
    s.close()


def main():
    free_port()
    V = json.load(open(os.path.join(ROOT, "version.json"), encoding="utf-8"))

    # ---- 1. 单一版本源 ----
    ck("version.json 为四段式 web", len(V["web"].split(".")) == 4, V["web"])
    ck("version.json 为四段式 desktop", len(V["desktop"].split(".")) == 4, V["desktop"])
    ck("buildVersion 是桌面前三段", V["buildVersion"] == ".".join(V["desktop"].split(".")[:3]))
    ck("versionRule 含四段说明", set(["major", "minor", "patch", "build"]).issubset(V.get("versionRule", {})))
    ck("notes 三端齐全", all(k in V["notes"] for k in ("web", "desktop", "android")))

    # 源码里不应再有硬编码的四段版本（除 version.json 自身）
    src = open(os.path.join(ROOT, "server/discovery.js"), encoding="utf-8").read()
    ck("discovery.js 从 version.json 读版本", "readFileSync(path.join(ROOT, 'version.json'" in src)
    ck("discovery.js 无硬编码 3.1.0.1", "3.1.0.1" not in src)

    # ---- 2. npm run version:sync --check 幂等 ----
    r = subprocess.run(["node", "scripts/sync-version.cjs", "--check"], cwd=ROOT,
                       capture_output=True, text=True)
    ck("version:sync --check 通过（11 处全同步）", r.returncode == 0 and "全部匹配" in r.stdout, r.stdout[-200:])
    r2 = subprocess.run(["node", "scripts/sync-version.cjs", "--show"], cwd=ROOT,
                        capture_output=True, text=True)
    ck("version:sync --show 输出四段版本", V["desktop"] in r2.stdout, r2.stdout)

    # ---- 3. 发版产物 ----
    rel_path = os.path.join(ROOT, "data", "release.json")
    ck("data/release.json 存在", os.path.exists(rel_path))
    rel = json.load(open(rel_path, encoding="utf-8"))
    ck("release 版本与 version.json 一致", rel["version"] == V["desktop"])
    ck("release 含 build/releasedAt", bool(rel.get("build")) and bool(rel.get("releasedAt")))
    ids = [p["id"] for p in rel["packages"]]
    for need in ("windows-portable", "windows-green", "linux-appimage", "android-apk", "zip-bundle"):
        ck(f"清单含 {need}", need in ids)
    real = [p for p in rel["packages"] if p.get("sizeBytes")]
    ck("至少 5 项有真实体积", len(real) >= 5, str(len(real)))
    ck("SHA256 为 64 位十六进制", all(len(p.get("sha256") or "") == 64 for p in real))
    # 体积与磁盘实际一致
    for p in real:
        fp = os.path.join(ROOT, "data", "installers", p["file"])
        if os.path.exists(fp):
            ck(f"体积匹配 {p['id']}", os.path.getsize(fp) == p["sizeBytes"])
            break

    docs_rel = json.load(open(os.path.join(ROOT, "docs", "release.json"), encoding="utf-8"))
    ck("docs 公开镜像标记 mirror", docs_rel.get("mirror") is True)
    ck("docs 镜像不含本地直链", all(p.get("local") is False for p in docs_rel["packages"]))

    # ---- 4. 起临时服务 ----
    tmp_data = "/tmp/cv-release-testdata"
    shutil.rmtree(tmp_data, ignore_errors=True)
    os.makedirs(tmp_data, exist_ok=True)
    env = dict(os.environ, PORT=str(PORT), CV_DATA_DIR=tmp_data)
    log = open("/tmp/cv-release-test.log", "w")
    srv = subprocess.Popen(["node", "server/index.js", "--host", "127.0.0.1"],
                           cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                           preexec_fn=os.setsid)
    try:
        for _ in range(40):
            try:
                get_json("/api/runtime")
                break
            except Exception:
                time.sleep(0.4)
        else:
            raise RuntimeError("服务未启动：" + open("/tmp/cv-release-test.log").read()[-500:])

        # /api/runtime 四段版本
        st, rt = get_json("/api/runtime")
        ck("runtime 版本四段", rt["version"] == V["web"] and len(rt["version"].split(".")) == 4, rt["version"])

        # /api/software 自动更新标记 + 真实清单
        st, sw = get_json("/api/software")
        ck("/api/software 版本四段", sw["version"] == V["desktop"], sw["version"])
        ck("/api/software autoUpdated", sw.get("autoUpdated") is True)
        ck("/api/software buildVersion", sw.get("buildVersion") == V["buildVersion"])
        ck("/api/software versionRule", bool(sw.get("versionRule")))
        cards = {s["id"]: s for s in sw["software"]}
        ck("下载页清单有真实体积", bool(cards["windows-portable"].get("sizeBytes")))
        ck("下载页清单有 SHA256", len(cards["windows-portable"].get("sha256") or "") == 64)
        ck("本站直链标记", cards["android-apk"].get("local") is True)
        ck("直链 URL 指向 /files/", cards["android-apk"]["url"].startswith("/files/"))

        # 四段版本比较：3.1.0 < 最新版，且不低于最新版的版本不提示更新
        _, old = get_json("/api/software/latest?channel=desktop&current=3.1.0")
        ck("3.1.0 判定可升级", old["hasUpdate"] is True and old["latest"] == V["desktop"])
        _, cur = get_json(f"/api/software/latest?channel=desktop&current={V['desktop']}")
        ck("当前版本不误报更新", cur["hasUpdate"] is False)
        parts = V["desktop"].split(".")
        higher = ".".join([parts[0], str(int(parts[1]) + 1), "0", "0"])  # 比当前 minor 更高
        _, newer = get_json(f"/api/software/latest?channel=desktop&current={higher}")
        ck("更高版本不误报更新", newer["hasUpdate"] is False)
        ck("latest 返回 autoUpdated", cur.get("autoUpdated") is True)

        # /files 直链 + Range
        apk_url = cards["android-apk"]["url"]
        st, body, h = get(apk_url)
        ck("直链下载 200", st == 200 and len(body) > 1000, f"{st} {len(body)}")
        st2, body2, _ = get(apk_url, {"Range": "bytes=0-99"})
        ck("直链支持 Range 206", st2 == 206 and len(body2) == 100, f"{st2} {len(body2)}")

        # ---- 5. 热更新：只改 data/release.json，不重启服务 ----
        orig = open(rel_path, encoding="utf-8").read()
        try:
            d = json.loads(orig)
            d["build"] = 987654
            open(rel_path, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
            os.utime(rel_path, None)
            time.sleep(0.3)
            _, sw2 = get_json("/api/software")
            ck("改清单不重启即生效", sw2["build"] == 987654, str(sw2["build"]))
        finally:
            open(rel_path, "w", encoding="utf-8").write(orig)
            time.sleep(0.2)
            _, sw3 = get_json("/api/software")
            ck("恢复后立即回退", sw3["build"] == rel["build"], str(sw3["build"]))
    finally:
        try:
            os.killpg(os.getpgid(srv.pid), signal.SIGTERM)
        except Exception:
            pass
        log.close()

    # ---- 6. 静态检查（不依赖服务）----
    ck("过程性文档已移除", not os.path.exists(os.path.join(ROOT, "GITHUB_SETUP.md"))
       and not os.path.exists(os.path.join(ROOT, "docs/guide.html"))
       and not os.path.exists(os.path.join(ROOT, "docs/backend.json")))
    home = open(os.path.join(ROOT, "dist-pages/index.html"), encoding="utf-8").read()
    ck("Pages 官网指向 GitHub 下载", "releases/latest" in home)
    ck("Pages 官网探测本机服务", "127.0.0.1:8787" in home)
    ck("Pages 官网带发布清单", os.path.exists(os.path.join(ROOT, "dist-pages/release.json")))
    wf = open(os.path.join(ROOT, ".github/workflows/pages.yml"), encoding="utf-8").read()
    ck("Pages 部署前生成清单", "--manifest-only" in wf)
    ck("Pages 监听 version.json", "version.json" in wf)
    ck("Pages 部署官网目录", "dist-pages" in wf)

    print(f"\n合计 {P} 通过 / {F} 失败")
    sys.exit(1 if F else 0)


if __name__ == "__main__":
    main()
