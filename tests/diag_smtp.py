"""163 SMTP 认证诊断：只读 .env，不在输出中回显任何凭据。"""
import os
import smtplib
import socket

ROOT = os.environ.get('CV_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, '.env')
if not os.path.isfile(ENV_FILE):
    raise SystemExit(
        f'未找到 {ENV_FILE}\n请先把 .env.example 复制为 .env 并填入 SMTP 配置后再运行本脚本。'
    )
cfg = {}
with open(ENV_FILE, encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        cfg[k.strip()] = v.strip()

host, port = cfg['SMTP_HOST'], int(cfg['SMTP_PORT'])
user, pwd = cfg['SMTP_USER'], cfg['SMTP_PASS']
short = user.split('@')[0]


def mask(s):
    s = str(s)
    for secret in (pwd, user, short):
        if secret:
            s = s.replace(secret, '***')
    return s[:300]


def probe(label, use_port, use_ssl, login_name):
    print(f'\n--- {label}: {host}:{use_port} ssl={use_ssl} user={mask(login_name)} ---')
    try:
        if use_ssl:
            s = smtplib.SMTP_SSL(host, use_port, timeout=12)
        else:
            s = smtplib.SMTP(host, use_port, timeout=12)
        code, msg = s.ehlo()
        print('EHLO:', code, mask(msg.decode('utf-8', 'replace').splitlines()[0] if msg else ''))
        print('AUTH 能力:', mask(str(s.esmtp_features.get('auth', '无'))))
        if not use_ssl and 'starttls' in s.esmtp_features:
            print('STARTTLS:', s.starttls()[0])
            s.ehlo()
        s.login(login_name, pwd)
        print('LOGIN: 成功 ✅')
        s.quit()
        return True
    except smtplib.SMTPAuthenticationError as e:
        print('LOGIN: 认证失败', e.smtp_code, mask(e.smtp_error))
    except (smtplib.SMTPException, OSError, socket.timeout) as e:
        print('连接/协议错误:', type(e).__name__, mask(e))
    return False


ok = probe('主配置', port, True, user)
if not ok:
    probe('短用户名', port, True, short)
if not ok:
    probe('25端口+STARTTLS', 25, False, user)

print('\n结论:', '认证通过' if ok else '163 拒绝了当前凭据（需检查 SMTP 服务是否开启 / 重新生成授权码）')
