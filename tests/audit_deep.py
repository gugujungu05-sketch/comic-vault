#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深度探测：每个源 discover 第一条 -> 详情 -> 第一章图片，验证端到端可用性。"""
import json, urllib.request, urllib.parse, time
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://127.0.0.1:8787"

SOURCES = ["js:aimanhua","js:bilimanga","js:bilinovel","js:copymanga","js:copynovel",
           "js:hotmanga","js:mangadex","js:manwa","js:nineteen","js:pufei","js:rawkuma",
           "js:vomic","js:wenku8","js:woimh","js:xipi","js:zaimanhua","js:zaimanovel"]

def req(url, body=None, timeout=45):
    t = time.time()
    try:
        if body is not None:
            r = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
        else:
            r = urllib.request.Request(url)
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            d = json.loads(resp.read().decode("utf-8","replace"))
            return time.time()-t, d, None
    except urllib.error.HTTPError as e:
        try: msg = json.loads(e.read().decode("utf-8","replace")).get("error","")[:60]
        except: msg = ""
        return time.time()-t, None, f"HTTP{e.code} {msg}"
    except Exception as e:
        return time.time()-t, None, str(e)[:60]

def deep(sid):
    r = {"id": sid}
    # discover first item
    dt, d, err = req(f"{BASE}/api/sources/{urllib.parse.quote(sid)}/discover?page=1&tab=0")
    if err or not d or not d.get("items"):
        r["discover"] = f"FAIL {err or '无items'}"; r["detail"]="-"; r["chapter"]="-"; return r
    it = d["items"][0]
    link = str(it.get("link") or it.get("id") or "")
    r["discover"] = f"OK {len(d['items'])}条 [{str(it.get('title',''))[:16]}]"
    r["_link"] = link
    # detail
    dt, d, err = req(f"{BASE}/api/sources/{urllib.parse.quote(sid)}/comic", {"url": link})
    if err or not d:
        r["detail"] = f"FAIL {err or '空'}"; r["chapter"]="-"; return r
    chs = d.get("chapters") or []
    r["detail"] = f"OK {len(chs)}话 [{str(d.get('title',''))[:14]}]"
    if not chs:
        r["chapter"]="无章节"; return r
    # first chapter (novel sources may not have chapters -> skip)
    ch = chs[0]
    curl = ch.get("url") if isinstance(ch, dict) else str(ch)
    dt, d, err = req(f"{BASE}/api/online/{urllib.parse.quote(sid.replace('js:',''))}/chapter",
                     {"bookId": link, "chapterUrl": curl}, timeout=45)
    if err or not d:
        r["chapter"] = f"FAIL {err or '空'}"
    else:
        r["chapter"] = f"OK {d.get('count',0)}张"
    return r

def main():
    out=[]
    with ThreadPoolExecutor(max_workers=5) as ex:
        fs={ex.submit(deep,s):s for s in SOURCES}
        for f in as_completed(fs):
            try: out.append(f.result())
            except Exception as e: out.append({"id":fs[f],"discover":f"FATAL {e}"})
    order={s:i for i,s in enumerate(SOURCES)}
    out.sort(key=lambda x:order.get(x["id"],999))
    json.dump(out, open("/tmp/audit_deep.json","w"), ensure_ascii=False, indent=2)
    for r in out:
        print(f"{r['id']:18} | 列表:{r.get('discover','-'):32} | 详情:{r.get('detail','-'):22} | 章节:{r.get('chapter','-')}")

if __name__=="__main__": main()
