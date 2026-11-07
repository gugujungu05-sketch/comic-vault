"""验证「注册跳过邮箱验证 → 之后补验证 → 已验证邮箱找回密码」全链路。

两种环境，都用独立临时数据目录，不碰项目自己的 data/：
  A. 开发模式（未配置发信）：注册不卡验证码、邮箱验证可用、找回密码必须禁用；
  B. 调试 SMTP（模拟真实发信）：未验证邮箱收不到重置码、验证后可重置密码、
     旧会话失效、登录码/重置码用途隔离、发信失败返回 502 不泄露明文。

不向外部邮箱发信。依赖 requests。
"""
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_mail import DebugSMTP, start_server, stop_server, wait_port, parse_mail  # noqa: E402


DEV_PORT = 8795
SMTP_PORT_HTTP = 8794


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

    procs = []
    smtp = None
    try:
        # ---------------- A. 开发模式 ----------------
        dev, dev_log = start_server(DEV_PORT, {})
        procs.append((dev, dev_log))
        if not wait_port(DEV_PORT):
            print('开发模式服务未启动：', open(f'/tmp/cv-mail-{DEV_PORT}.log').read()[-2000:])
            sys.exit(1)
        B = f'http://127.0.0.1:{DEV_PORT}'
        st = requests.get(f'{B}/api/auth/status').json()['codeLogin']
        ck('未配置发信时 recoveryEnabled=false',
           st.get('recoveryEnabled') is False and st.get('devMode') is True, str(st))

        sa = requests.Session()
        r = sa.post(f'{B}/api/auth/register',
                    json={'email': 'a@test.local', 'password': 'pass123', 'name': '小A'})
        d = r.json() if r.headers.get('content-type', '').startswith('application/json') else {}
        ck('注册不需要邮箱验证码且直接登录', r.status_code == 200 and 'user' in d,
           f'{r.status_code} {r.text[:150]}')
        ck('新注册账号 emailVerified=false', d.get('user', {}).get('emailVerified') is False, str(d)[:200])

        r = requests.post(f'{B}/api/auth/forgot/send', json={'email': 'a@test.local'})
        ck('开发模式禁用找回密码发码（503）', r.status_code == 503, f'{r.status_code} {r.text[:120]}')
        r = requests.post(f'{B}/api/auth/forgot/reset',
                          json={'email': 'a@test.local', 'code': '123456', 'password': 'hacked1'})
        ck('开发模式禁用重置密码（503）', r.status_code == 503, f'{r.status_code} {r.text[:120]}')

        r = sa.post(f'{B}/api/auth/email/send-code')
        vd = r.json()
        ck('可给当前账号发送邮箱验证码', r.status_code == 200 and bool(vd.get('devCode')), str(vd)[:200])
        vcode = vd.get('devCode')

        ld = requests.post(f'{B}/api/auth/send-code', json={'email': 'a@test.local'}).json()
        lcode = ld.get('devCode')
        ck('登录验证码与邮箱验证码是两条独立记录', lcode and lcode != vcode, str(ld)[:150])
        r = sa.post(f'{B}/api/auth/email/verify', json={'code': lcode})
        ck('登录码不能拿来验证邮箱', r.status_code == 401, f'{r.status_code} {r.text[:120]}')

        r = sa.post(f'{B}/api/auth/email/verify', json={'code': vcode})
        ck('用正确的验证码完成邮箱验证',
           r.status_code == 200 and r.json().get('user', {}).get('emailVerified') is True,
           f'{r.status_code} {r.text[:150]}')
        me = sa.get(f'{B}/api/me').json()
        ck('验证状态已持久化到账号', me.get('user', {}).get('emailVerified') is True, str(me)[:200])
        r = sa.post(f'{B}/api/auth/email/send-code')
        ck('已验证邮箱不能重复发验证码', r.status_code == 400, f'{r.status_code} {r.text[:120]}')
        r = sa.post(f'{B}/api/auth/email/verify', json={'code': vcode})
        ck('验证码用后即失效', r.status_code in (400, 401), f'{r.status_code} {r.text[:120]}')

        # ---------------- B. 调试 SMTP（模拟真实发信） ----------------
        smtp = DebugSMTP()
        smtp.start()
        env = {
            'SMTP_HOST': '127.0.0.1',
            'SMTP_PORT': str(smtp.port),
            'SMTP_SECURE': '0',
            'SMTP_USER': 'debug@local',
            'SMTP_PASS': 'debug',
            'MAIL_FROM': 'ComicVault <debug@local>',
        }
        real, real_log = start_server(SMTP_PORT_HTTP, env)
        procs.append((real, real_log))
        if not wait_port(SMTP_PORT_HTTP):
            print('SMTP 模式服务未启动：', open(f'/tmp/cv-mail-{SMTP_PORT_HTTP}.log').read()[-2000:])
            sys.exit(1)
        C = f'http://127.0.0.1:{SMTP_PORT_HTTP}'
        st = requests.get(f'{C}/api/auth/status').json()['codeLogin']
        ck('配置发信后 recoveryEnabled=true',
           st.get('recoveryEnabled') is True and st.get('channel') == 'smtp', str(st))

        sb = requests.Session()
        r = sb.post(f'{C}/api/auth/register',
                    json={'email': 'b@test.local', 'password': 'oldpass', 'name': '小B'})
        ck('SMTP 模式下注册同样不卡验证码', r.status_code == 200, f'{r.status_code} {r.text[:120]}')
        before = len(smtp.messages)

        r = requests.post(f'{C}/api/auth/forgot/send', json={'email': 'b@test.local'})
        ck('未验证邮箱请求找回密码：统一返回 ok', r.status_code == 200 and r.json().get('ok') is True,
           f'{r.status_code} {r.text[:150]}')
        ck('未验证邮箱不会真的发出重置邮件', len(smtp.messages) == before,
           f'{before} -> {len(smtp.messages)}')

        r = sb.post(f'{C}/api/auth/email/send-code')
        ck('验证邮件真实投递且接口不回明文',
           r.status_code == 200 and r.json().get('sent') is True and r.json().get('devCode') is None,
           f'{r.status_code} {r.text[:150]}')
        code, to, body = parse_mail(smtp.messages[-1])
        ck('验证邮件含 6 位码且收件人正确', code is not None and 'b@test.local' in to, f'{to} {body[:120]}')
        r = sb.post(f'{C}/api/auth/email/verify', json={'code': code})
        ck('用邮件里的码完成验证', r.status_code == 200 and r.json().get('user', {}).get('emailVerified') is True,
           f'{r.status_code} {r.text[:150]}')

        r = requests.post(f'{C}/api/auth/forgot/send', json={'email': 'b@test.local'})
        ck('已验证邮箱可请求找回密码', r.status_code == 200 and r.json().get('sent') is True,
           f'{r.status_code} {r.text[:150]}')
        reset_code, to2, body2 = parse_mail(smtp.messages[-1])
        ck('重置邮件含 6 位码且收件人正确',
           reset_code is not None and 'b@test.local' in to2, f'{to2} {body2[:120]}')

        # 用途隔离：另发一个登录码，拿它去重置密码应失败
        r = requests.post(f'{C}/api/auth/send-code', json={'email': 'b@test.local'})
        login_code, _, _ = parse_mail(smtp.messages[-1])
        r = requests.post(f'{C}/api/auth/forgot/reset', json={
            'email': 'b@test.local', 'code': login_code, 'password': 'hacked1',
        })
        ck('登录码不能用于重置密码', r.status_code == 401, f'{r.status_code} {r.text[:120]}')
        r = requests.post(f'{C}/api/auth/login', json={'email': 'b@test.local', 'password': 'hacked1'})
        ck('被拒绝的错误码没有改动密码', r.status_code == 401, f'{r.status_code} {r.text[:120]}')

        r = requests.post(f'{C}/api/auth/forgot/reset', json={
            'email': 'b@test.local', 'code': reset_code, 'password': 'newpass',
        })
        ck('用正确的重置码改密成功', r.status_code == 200 and r.json().get('ok') is True,
           f'{r.status_code} {r.text[:150]}')
        r = sb.get(f'{C}/api/me')
        ck('重置后旧会话立即失效', r.status_code == 401, f'{r.status_code} {r.text[:120]}')
        r = requests.post(f'{C}/api/auth/login', json={'email': 'b@test.local', 'password': 'oldpass'})
        ck('旧密码已不能登录', r.status_code == 401, f'{r.status_code} {r.text[:120]}')
        r = requests.post(f'{C}/api/auth/login', json={'email': 'b@test.local', 'password': 'newpass'})
        ck('新密码可登录', r.status_code == 200, f'{r.status_code} {r.text[:120]}')
        r = requests.post(f'{C}/api/auth/forgot/reset', json={
            'email': 'b@test.local', 'code': reset_code, 'password': 'again22',
        })
        ck('重置码不可重复使用', r.status_code == 400, f'{r.status_code} {r.text[:120]}')

        before = len(smtp.messages)
        r = requests.post(f'{C}/api/auth/forgot/send', json={'email': 'nobody@test.local'})
        ck('不存在的邮箱也返回统一结果（防枚举）', r.status_code == 200 and r.json().get('ok') is True,
           f'{r.status_code} {r.text[:150]}')
        ck('不存在的邮箱不会发信', len(smtp.messages) == before,
           f'{before} -> {len(smtp.messages)}')

        smtp.stop()
        smtp = None
        r = requests.post(f'{C}/api/auth/forgot/send', json={'email': 'b@test.local'})
        ck('发信服务不可用时返回 502', r.status_code == 502, f'{r.status_code} {r.text[:120]}')
        ck('失败响应不含验证码明文', 'devCode' not in r.text and '验证码是' not in r.text,
           r.text[:150])
    finally:
        if smtp:
            smtp.stop()
        for proc, log in procs:
            stop_server(proc, log)

    print(f'\n合计 {passed} 通过 / {failed} 失败')
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
