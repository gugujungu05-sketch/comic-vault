#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量探测所有 JS 书源的可用性：discover(发现页) + search(搜索)。"""
import json, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://127.0.0.1:8787"
TIMEOUT = 40

SOURCES = [
    ("js:aimanhua", "爱漫画", "漫画"),
    ("js:bilimanga", "嗶哩漫畫", "漫画"),
    ("js:bilinovel", "哔哩轻小说", "小说"),
    ("js:copymanga", "拷贝漫画", "漫画"),
    ("js:copynovel", "拷贝轻小说", "小说"),
    ("js:hotmanga", "热辣漫画", "漫画"),
    ("js:mangadex", "MangaDex", "漫画"),
    ("js:manwa", "漫蛙漫画", "漫画"),
    ("js:nineteen", "19漫画", "漫画"),
    ("js:pufei", "扑飞漫画", "漫画"),
    ("js:rawkuma", "Rawkuma生肉", "漫画"),
    ("js:vomic", "vomic漫画", "漫画"),
    ("js:wenku8", "轻小说文库", "小说"),
    ("js:woimh", "我爱漫画网", "漫画"),
    ("js:xipi", "嬉皮漫画", "漫画"),
    ("js:zaimanhua", "再漫画", "漫画"),
    ("js:zaimanovel", "再漫画轻小说", "小说"),
]

# 每个源的搜索关键词（尽量使用该站能搜到的常见词）
KW = {
    "js:aimanhua": "漫画", "js:bilimanga": "漫画", "js:bilinovel": "小说",
    "js:copymanga": "漫画", "js:copynovel": "小说", "js:hotmanga": "漫画",
    "js:mangadex": "One Piece", "js:manwa": "漫画", "js:nineteen": "漫画",
    "js:pufei": "漫画", "js:rawkuma": "One Piece", "js:vomic": "漫画",
    "js:wenku8": "小说", "js:woimh": "漫画", "js:xipi": "漫画",
    "js:zaimanhua": "漫画", "js:zaimanovel": "小说",
}

def fetch(url, body=None):
    t = time.time()
    try:
        if body is not None:
            data = json.dumps(body).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        else:
            req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
            dt = time.time() - t
            try:
                d = json.loads(raw)
            except Exception:
                return dt, None, f"非JSON: {raw[:80]}"
            return dt, d, None
    except Exception as e:
        return time.time() - t, None, str(e)[:120]

def probe_source(sid, name, kind):
    out = {"id": sid, "name": name, "kind": kind}
    # discover
    dt, d, err = fetch(f"{BASE}/api/sources/{urllib.parse.quote(sid)}/discover?page=1&tab=0")
    if err:
        out["discover"] = f"ERR {err} ({dt:.1f}s)"
    elif d is None:
        out["discover"] = f"空响应 ({dt:.1f}s)"
    else:
        items = d.get("items", [])
        tabs = d.get("tabs", [])
        sample = ""
        if items:
            first = items[0] if isinstance(items[0], dict) else {}
            sample = str(first.get("title", ""))[:20]
        out["discover"] = f"OK {len(items)}条/{len(tabs)}tab ({dt:.1f}s) {sample}"
    # search
    kw = KW.get(sid, "漫画")
    dt, d, err = fetch(f"{BASE}/api/sources/{urllib.parse.quote(sid)}/search?kw={urllib.parse.quote(kw)}")
    if err:
        out["search"] = f"ERR {err} ({dt:.1f}s)"
    elif d is None:
        out["search"] = f"空响应 ({dt:.1f}s)"
    else:
        items = d.get("items", [])
        sample = ""
        if items:
            first = items[0] if isinstance(items[0], dict) else {}
            sample = str(first.get("title", ""))[:20]
        out["search"] = f"OK {len(items)}条 ({dt:.1f}s) {sample}"
    return out

def main():
    results = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(probe_source, *s): s for s in SOURCES}
        for f in as_completed(futs):
            try:
                results.append(f.result())
            except Exception as e:
                sid = futs[f][0]
                results.append({"id": sid, "discover": f"FATAL {e}", "search": ""})
    order = {s[0]: i for i, s in enumerate(SOURCES)}
    results.sort(key=lambda x: order.get(x["id"], 999))
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open("/tmp/audit_results.json", "w") as fp:
        json.dump(results, fp, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()
