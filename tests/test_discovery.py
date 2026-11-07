"""验证 v2.2：分类 / 排行 / 搜索 / 动态 / 上传记录 / 公告权限 / 软件更新 / 合规导入。

用独立临时数据目录启动服务，不碰项目自己的 data/；不发任何外部邮件。
依赖 requests。
"""
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_mail import start_server, stop_server, wait_port  # noqa: E402

PORT = 8793
B = f'http://127.0.0.1:{PORT}'


def main():
    passed = failed = 0

    def ck(name, cond, detail=''):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f'[PASS] {name}')
        else:
            failed += 1
            print(f'[FAIL] {name}  {detail}')

    proc, log = start_server(PORT, {})
    try:
        if not wait_port(PORT):
            print('服务未启动：', open(f'/tmp/cv-mail-{PORT}.log').read()[-2000:])
            sys.exit(1)

        # 等后台示例漫画与上传记录全部生成完（避免生成中途的竞态）
        comics = []
        for _ in range(80):
            comics = requests.get(B + '/api/community/comics').json()['comics']
            ups_now = requests.get(B + '/api/community/uploads').json()['total']
            if len(comics) >= 6 and ups_now >= 6:
                break
            time.sleep(0.5)
        ck('公共书库自动填充示例漫画', len(comics) >= 6, f'实际 {len(comics)}')

        # ---- runtime ----
        rt = requests.get(B + '/api/runtime').json()
        import json as _json
        _v = _json.load(open('version.json'))
        ck('runtime 版本与 version.json 一致', rt['version'] == _v['web'], str(rt['version']))
        ck('runtime 暴露 discovery 能力', rt['features'].get('discovery') is True)

        # ---- 分类 ----
        cats = requests.get(B + '/api/community/categories').json()['categories']
        ck('分类数量 >= 10', len(cats) >= 10, str(len(cats)))
        ck('全部分类计数等于公共书库总数',
           cats[0]['count'] == len(comics), f"{cats[0]['count']} vs {len(comics)}")
        scifi = [c for c in cats if c['id'] == 'scifi'][0]
        ck('科幻分类有示例漫画', scifi['count'] >= 1)

        # ---- 搜索 / 分类筛选 / 排序 ----
        r = requests.get(B + '/api/community/comics', params={'q': '像素'}).json()['comics']
        ck('书名搜索命中示例漫画', len(r) == 1 and '像素' in r[0]['title'], str([c['title'] for c in r]))
        r = requests.get(B + '/api/community/comics', params={'q': '完全不存在xyz'}).json()['comics']
        ck('搜索无结果返回空列表', len(r) == 0)
        r = requests.get(B + '/api/community/comics', params={'category': 'scifi'}).json()['comics']
        ck('分类筛选只返回该类', len(r) >= 1 and all(c['category'] == 'scifi' for c in r))
        r = requests.get(B + '/api/community/comics', params={'sort': 'new'}).json()['comics']
        ck('按最新加入排序', all(r[i]['createdAt'] >= r[i + 1]['createdAt'] for i in range(len(r) - 1)))
        ck('公共书库返回分类与计数字段',
           all('category' in c and 'views' in c and 'likes' in c for c in comics))

        # ---- 排行 ----
        rank = requests.get(B + '/api/community/ranking', params={'type': 'hot', 'limit': 3}).json()
        ck('热门排行返回指定条数', len(rank['ranking']) == 3)
        ck('排行序号连续且从 1 开始', [x['rank'] for x in rank['ranking']] == [1, 2, 3])
        ck('排行分数降序', all(rank['ranking'][i]['score'] >= rank['ranking'][i + 1]['score'] for i in range(2)))
        rank_new = requests.get(B + '/api/community/ranking', params={'type': 'new', 'limit': 5}).json()
        ck('新书排行按创建时间降序',
           all(rank_new['ranking'][i]['createdAt'] >= rank_new['ranking'][i + 1]['createdAt']
               for i in range(len(rank_new['ranking']) - 1)))

        # ---- 上传记录 / 动态 ----
        ups = requests.get(B + '/api/community/uploads', params={'limit': 50}).json()
        ck('上传记录非空', ups['total'] >= 6, str(ups['total']))
        ck('上传记录含漫画标题与用户', all(u['comicTitle'] and u['userName'] for u in ups['uploads']))
        act = requests.get(B + '/api/activity', params={'limit': 50}).json()
        ck('动态流非空', len(act['activities']) >= 6)
        ck('动态项含文案与链接', all(a['text'] and a['link'] for a in act['activities']))
        ck('动态流初始无公告', len(act['announcements']) == 0)

        # ---- 注册两个账号，验证公告权限只给第一个 ----
        s1 = requests.Session()
        r1 = s1.post(B + '/api/auth/register', json={
            'email': 'owner@example.com', 'password': 'test123456', 'name': '站长'})
        ck('首个账号注册成功', r1.status_code == 200, r1.text[:200])
        ck('首个账号自动获得公告权限', r1.json()['user']['canAnnounce'] is True, str(r1.json()['user']))
        s2 = requests.Session()
        r2 = s2.post(B + '/api/auth/register', json={
            'email': 'reader@example.com', 'password': 'test123456', 'name': '读者'})
        ck('第二个账号注册成功', r2.status_code == 200, r2.text[:200])
        ck('第二个账号没有公告权限', r2.json()['user']['canAnnounce'] is False)

        # ---- 公告 CRUD 与鉴权 ----
        denied = s2.post(B + '/api/announcements', json={'title': '越权', 'content': '不该成功'})
        ck('普通用户发布公告被拒 403', denied.status_code == 403, str(denied.status_code))
        made = s1.post(B + '/api/announcements', json={'title': '上线公告', 'content': '欢迎使用公共书库'})
        ck('公告账号发布成功', made.status_code == 200, made.text[:200])
        ann_id = made.json()['announcement']['id']
        anns = s1.get(B + '/api/announcements').json()
        ck('公告账号可见发布入口', anns['canAnnounce'] is True)
        ck('公告列表含新公告', any(a['id'] == ann_id for a in anns['announcements']))
        ck('普通用户看不到发布权限',
           s2.get(B + '/api/announcements').json()['canAnnounce'] is False)
        ck('普通用户删除公告被拒', s2.delete(B + f'/api/announcements/{ann_id}').status_code == 403)
        ck('公告出现在动态流',
           any(a['id'] == ann_id for a in requests.get(B + '/api/activity').json()['announcements']))
        ck('作者可删除自己的公告', s1.delete(B + f'/api/announcements/{ann_id}').status_code == 200)

        # ---- 浏览量 / 点赞 / 分类设置 ----
        cid = comics[0]['id']
        v0 = comics[0]['views']
        vr = s1.post(B + '/api/discovery/view', json={'comicId': cid})
        ck('浏览量 +1', vr.status_code == 200 and vr.json()['views'] == v0 + 1, vr.text[:120])
        lk = s1.post(B + '/api/discovery/like', json={'comicId': cid})
        ck('点赞生效', lk.status_code == 200 and lk.json()['liked'] is True)
        lk2 = s1.post(B + '/api/discovery/like', json={'comicId': cid})
        ck('再次点赞取消（幂等切换）', lk2.json()['liked'] is False)
        ck('未登录不能点赞',
           requests.post(B + '/api/discovery/like', json={'comicId': cid}).status_code == 401)
        bad = s1.patch(B + '/api/discovery/category', json={'comicId': cid, 'category': 'not-exist'})
        ck('无效分类被拒 400', bad.status_code == 400)
        good = s1.patch(B + '/api/discovery/category', json={'comicId': cid, 'category': 'slice'})
        ck('设置分类成功', good.status_code == 200 and good.json()['category'] == 'slice')
        after = requests.get(B + '/api/community/comics', params={'category': 'slice'}).json()['comics']
        ck('分类筛选能看到改后的漫画', any(c['id'] == cid for c in after))

        # ---- 广场搜索 ----
        s1.post(B + '/api/plaza/posts', json={'content': '求推荐治愈系短篇', 'board': 'chat'})
        s1.post(B + '/api/plaza/posts', json={'content': '科幻设定讨论', 'board': 'recommend'})
        hit = requests.get(B + '/api/plaza/posts', params={'q': '治愈系'}).json()
        ck('广场搜索命中正文', hit['count'] == 1 and len(hit['posts']) == 1, str(hit['count']))
        miss = requests.get(B + '/api/plaza/posts', params={'q': '不存在的内容xyz'}).json()
        ck('广场搜索无结果', miss['count'] == 0)
        ck('发帖写入动态流',
           any(a['type'] == 'post' for a in requests.get(B + '/api/activity').json()['activities']))

        # ---- 软件下载与自动更新 ----
        sw = requests.get(B + '/api/software').json()
        ck('软件清单 6 项', len(sw['software']) == 6)
        ck('软件清单指向 GitHub 下载', 'github.com' in sw['driveUrl'])
        ck('Android APK 走站内地址',
           any(x['id'] == 'android-apk' and x['url'].startswith('/files/') for x in sw['software']))
        up = requests.get(B + '/api/software/latest', params={'channel': 'desktop', 'current': '1.0.0'}).json()
        _dv = _json.load(open('version.json'))['desktop']
        ck('桌面端 1.0.0 提示有新版本', up['hasUpdate'] is True and up['latest'] == _dv, str(up.get('latest')))
        up2 = requests.get(B + '/api/software/latest', params={'channel': 'desktop', 'current': _dv}).json()
        ck('桌面端最新版不再提示', up2['hasUpdate'] is False)
        web = requests.get(B + '/api/software/latest', params={'channel': 'web', 'current': '1.0.0'}).json()
        ck('网页版永远不提示升级', web['hasUpdate'] is False and web['alwaysLatest'] is True)
        ck('APK 站内可直接下载',
           requests.get(B + '/files/ComicVault-android.apk', stream=True).status_code == 200)
        ck('软件下载页路由不与静态目录冲突（无 301）',
           requests.get(B + '/downloads', allow_redirects=False).status_code == 200)

        # ---- 合规批量导入 ----
        no_confirm = s1.post(B + '/api/community/import', json={'items': [{'title': 'x'}]})
        ck('未确认授权被拒 400', no_confirm.status_code == 400 and no_confirm.json().get('needRightsConfirm'))
        imported = s1.post(B + '/api/community/import', json={
            'confirmRights': True,
            'items': [{
                'title': '合法授权作品', 'author': '测试作者', 'category': 'knowledge',
                'tags': ['科普'], 'sourceUrl': 'https://example.com/source',
                'chapters': [{'title': '第 1 话', 'pages': []}],
            }],
        })
        ck('确认授权后导入成功', imported.status_code == 200 and len(imported.json()['created']) == 1,
           imported.text[:300])
        ck('导入的漫画进入公共书库',
           any(c['title'] == '合法授权作品'
               for c in requests.get(B + '/api/community/comics').json()['comics']))
        ssrf = s1.post(B + '/api/community/import', json={
            'confirmRights': True,
            'items': [{'title': '内网测试', 'chapters': [
                {'title': '第 1 话', 'pages': [f'http://127.0.0.1:{PORT}/api/runtime']},
            ]}],
        }).json()
        ck('内网图片地址被拒绝且记录在 errors',
           any(('内网' in e or '端口' in e or '解析' in e) for e in ssrf['errors']),
           str(ssrf['errors']))
        ck('被拒绝的图片不落盘', ssrf['importedImages'] == 0)
        ck('导入写入上传记录',
           any(u['comicTitle'] == '合法授权作品'
               for u in requests.get(B + '/api/community/uploads', params={'limit': 100}).json()['uploads']))
    finally:
        stop_server(proc, log)

    print(f'\n结果：{passed} 通过 / {failed} 失败')
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
