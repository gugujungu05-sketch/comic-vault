"""验证登录验证码的真实发信链路（本地调试 SMTP，不向外部发信）。

覆盖三种状态：
  1. 未配置发信 → 开发模式，页面直接拿到验证码；
  2. 配置 SMTP → 真实投递到调试 SMTP 服务器，用邮件正文里的验证码登录成功；
  3. 发信服务不可用 → 返回 502 且绝不泄露验证码明文。

脚本用命令行环境变量注入配置，不会在项目里创建 .env，不影响线上运行。
"""
import email
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

import requests


class DebugSMTP:
    """仅用于测试的极简 SMTP 服务器：收下邮件原文，不做任何转发。"""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.sock.listen(5)
        self.sock.settimeout(0.5)
        self.messages = []
        self.running = True
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.running = False
        try:
            self.sock.close()
        except OSError:
            pass
        self.thread.join(timeout=3)

    def _serve(self):
        while self.running:
            try:
                conn, _addr = self.sock.accept()
            except OSError:
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        reader = conn.makefile("rb")
        writer = conn.makefile("wb")

        def send(text):
            writer.write(text.encode("utf-8") + b"\r\n")
            writer.flush()

        try:
            send("220 localhost ComicVault debug SMTP")
            in_data = False
            buf = []
            while True:
                raw = reader.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if in_data:
                    if line == ".":
                        self.messages.append(b"\r\n".join(buf))
                        buf = []
                        in_data = False
                        send("250 OK queued")
                    else:
                        buf.append(raw.rstrip(b"\r\n"))
                    continue
                cmd = line.split(" ", 1)[0].upper()
                if cmd in ("EHLO", "HELO"):
                    send("250-localhost")
                    send("250-AUTH PLAIN LOGIN")
                    send("250 OK")
                elif cmd == "AUTH":
                    send("235 Authentication successful")
                elif cmd == "DATA":
                    in_data = True
                    send("354 End data with <CR><LF>.<CR><LF>")
                elif cmd == "QUIT":
                    send("221 Bye")
                    break
                else:
                    send("250 OK")
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


def wait_port(port, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def start_server(port, extra_env):
    data_dir = tempfile.mkdtemp(prefix="cv-mail-test-")
    env = os.environ.copy()
    # 清掉外部可能存在的发信配置，保证测试环境完全可控
    for key in list(env):
        if key.startswith("SMTP_") or key.startswith("RESEND_") or key == "MAIL_FROM":
            env.pop(key, None)
    env["CV_DATA_DIR"] = data_dir
    env["PORT"] = str(port)
    # 隔离项目根目录的 .env（里面可能有真实 SMTP 配置），
    # 保证「未配置发信」的开发模式测试可复现；需要 SMTP 的场景由 extra_env 注入。
    env["CV_NO_DOTENV"] = "1"
    env.update(extra_env)
    log = open(f"/tmp/cv-mail-{port}.log", "w")
    proc = subprocess.Popen(
        ["node", "server/index.js"], cwd="/workspace/comic-vault",
        env=env, stdout=log, stderr=log,
    )
    return proc, log


def stop_server(proc, log):
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def parse_mail(raw):
    msg = email.message_from_bytes(raw)
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True) or b""
                body = payload.decode("utf-8", "replace")
                break
    else:
        payload = msg.get_payload(decode=True) or b""
        body = payload.decode("utf-8", "replace")
    m = re.search(r"验证码是\s*(\d{6})", body)
    return (m.group(1) if m else None), msg.get("To", ""), body


def main():
    passed, failed = 0, 0

    def ck(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"[PASS] {name}")
        else:
            failed += 1
            print(f"[FAIL] {name}  {detail}")

    procs = []
    smtp = None
    try:
        # ---------- 1) 开发模式 ----------
        dev, dev_log = start_server(8797, {})
        procs.append((dev, dev_log))
        if not wait_port(8797):
            print("开发模式服务未启动：", open("/tmp/cv-mail-8797.log").read()[-2000:])
            sys.exit(1)
        base = "http://127.0.0.1:8797"
        s = requests.get(f"{base}/api/auth/status").json()["codeLogin"]
        ck("未配置发信时 devMode=true / channel=dev",
           s.get("devMode") is True and s.get("channel") == "dev", str(s))
        r = requests.post(f"{base}/api/auth/send-code",
                          json={"email": "dev@test.local"}).json()
        ck("开发模式返回明文验证码", r.get("sent") is False and bool(r.get("devCode")), str(r))
        r2 = requests.post(f"{base}/api/auth/login-code",
                           json={"email": "dev@test.local", "code": r["devCode"]})
        ck("开发模式验证码可登录", r2.status_code == 200, f"{r2.status_code} {r2.text[:150]}")

        # ---------- 2) 真实 SMTP 发信 ----------
        smtp = DebugSMTP()
        smtp.start()
        env = {
            "SMTP_HOST": "127.0.0.1",
            "SMTP_PORT": str(smtp.port),
            "SMTP_SECURE": "0",
            "SMTP_USER": "debug@local",
            "SMTP_PASS": "debug",
            "MAIL_FROM": "ComicVault <debug@local>",
        }
        real, real_log = start_server(8796, env)
        procs.append((real, real_log))
        if not wait_port(8796):
            print("SMTP 模式服务未启动：", open("/tmp/cv-mail-8796.log").read()[-2000:])
            sys.exit(1)
        base = "http://127.0.0.1:8796"
        s = requests.get(f"{base}/api/auth/status").json()["codeLogin"]
        ck("配置 SMTP 后 emailEnabled=true / channel=smtp",
           s.get("emailEnabled") is True and s.get("devMode") is False
           and s.get("channel") == "smtp", str(s))
        r = requests.post(f"{base}/api/auth/send-code",
                          json={"email": "real@test.local"})
        d = r.json()
        ck("真实发信接口返回 sent=true", r.status_code == 200 and d.get("sent") is True,
           f"{r.status_code} {str(d)[:200]}")
        ck("真实发信不返回明文验证码", d.get("devCode") is None, str(d))
        ck("调试 SMTP 收到 1 封邮件", len(smtp.messages) == 1,
           f"n={len(smtp.messages)}")
        if smtp.messages:
            code, to, body = parse_mail(smtp.messages[0])
            ck("邮件正文含 6 位验证码", code is not None, body[:200])
            ck("邮件收件人正确", "real@test.local" in to, to)
            if code:
                r2 = requests.post(f"{base}/api/auth/login-code",
                                   json={"email": "real@test.local", "code": code})
                ck("用邮件里收到的验证码登录成功",
                   r2.status_code == 200 and "user" in r2.json(),
                   f"{r2.status_code} {r2.text[:150]}")

        # ---------- 3) 发信服务不可用 ----------
        smtp.stop()
        smtp = None
        r = requests.post(f"{base}/api/auth/send-code",
                          json={"email": "fail@test.local"})
        ck("发信失败返回 502", r.status_code == 502, f"{r.status_code} {r.text[:150]}")
        ck("失败响应不含验证码明文", "devCode" not in r.text and "验证码是" not in r.text,
           r.text[:150])
    finally:
        if smtp:
            smtp.stop()
        for proc, log in procs:
            stop_server(proc, log)

    print(f"\n合计 {passed} 通过 / {failed} 失败")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
