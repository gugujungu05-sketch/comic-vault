#!/usr/bin/env bash
# 漫画库服务总控：一条命令拉起「后端 + 隧道守护」并持续保活。
#
# 历史故障（反复出现「无法连接到服务器」）：
#   旧版 npm start 只执行 `node server/index.js`，不会启动 cloudflared；
#   而网站（GitHub Pages）必须通过公网隧道访问后端。于是只要服务重启
#   （会话恢复 / 沙箱休眠 / 手动重启），后端活着但 backend.json 里所有
#   公网地址都是死的，网站立刻连不上。
#
# 本脚本把三件事绑在一起：后端存活、隧道守护存活、地址同步到 GitHub。
# 用法：
#   npm start              前台常驻，每 20 秒巡检并拉起缺失的进程
#   bash bin/start-all.sh status   查看当前状态
#   bash bin/start-all.sh once    只补齐一次就退出（供外部调度使用）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
PORT="${PORT:-8787}"
LOCK="/tmp/cv-start-all.lock"
BACKEND_LOG=/tmp/cv-backend.log
SUP_LOG=/tmp/cv-supervisor.log

log() { echo "[$(date '+%H:%M:%S')] $*"; }
backend_ok() { curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/runtime"; }
port_listening() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }
# 用守护持有的 flock 锁判断是否存活，避免 pgrep -f 误匹配到 shell 自身命令行
supervisor_running() {
  if flock -n /tmp/cv-tunnel.lock -c true 2>/dev/null; then return 1; fi
  return 0
}

ensure_backend() {
  if backend_ok; then return 0; fi
  # 端口已被占用但服务不响应：说明别的实例正在启动/异常，不要重复拉起造成 EADDRINUSE
  if port_listening; then
    log "端口 $PORT 已被占用但服务未就绪，等待其恢复 ..."
    return 1
  fi
  log "本地后端未运行，拉起 node server/index.js ..."
  setsid node "$ROOT/server/index.js" --host 0.0.0.0 >> "$BACKEND_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 20); do
    sleep 1
    if backend_ok; then log "后端已就绪"; return 0; fi
  done
  log "后端启动超时，请检查 $BACKEND_LOG"
  return 1
}

ensure_supervisor() {
  if supervisor_running; then return 0; fi
  log "隧道守护未运行，拉起 bin/tunnel-supervisor.sh ..."
  setsid bash "$ROOT/bin/tunnel-supervisor.sh" >> "$SUP_LOG" 2>&1 < /dev/null &
  sleep 2
}

status() {
  printf '后端:        %s\n' "$(backend_ok && echo 正常 || echo 异常)"
  printf '隧道守护:    %s\n' "$(supervisor_running && echo 运行中 || echo 未运行)"
  printf 'cloudflared: %s\n' "$(pgrep -f 'cloudflared tunnel' >/dev/null && echo 运行中 || echo 未运行)"
  printf '当前候选:    %s\n' "$(python3 -c "import json;print(json.load(open('$ROOT/dist-pages/backend.json'))['candidates'][0])" 2>/dev/null || echo 未知)"
}

case "${1:-}" in
  status) status; exit 0 ;;
  once)   ensure_backend || true; ensure_supervisor || true; status; exit 0 ;;
esac

# 单实例锁：避免多个总控互相拉起重复进程
exec 9>"$LOCK"
if ! flock -n 9; then
  log "已有总控在运行（锁 $LOCK），本次退出。"
  exit 0
fi

log "漫画库服务总控启动（$ROOT，端口 $PORT）"
while true; do
  ensure_backend || true
  ensure_supervisor || true
  sleep 20
done
