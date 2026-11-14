#!/usr/bin/env bash
# 隧道守护：保证 cloudflared 可用，并把最新地址同步到 GitHub Pages 的 backend.json
#
# 加固要点：
#  1) 单实例 flock 锁 —— 防止多个守护同时拉起 cloudflared 互相抢地址；
#  2) 后端挂了主动拉起 —— 不再死等，避免「后端没了但守护空转」；
#  3) 新地址先探活再写入 —— 不把尚未就绪的地址推到线上；
#  4) 每次健康检查确认 backend.json 首候选就是当前地址，被覆盖时自动纠正；
#  5) 令牌不再硬编码在仓库里，改从环境变量或未跟踪的 .env.tunnel 读取；
#  6) 候选地址上限 3 个，生成的 JSON 先校验再落盘。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
REPO=gugujungu05-sketch/comic-vault
TOKEN="${CV_GITHUB_TOKEN:-}"
[ -z "$TOKEN" ] && [ -f "$ROOT/.env.tunnel" ] && TOKEN="$(tr -d ' \r\n' < "$ROOT/.env.tunnel")"
BACKEND="$ROOT/dist-pages/backend.json"
CF="$ROOT/bin/cloudflared"
# 二进制不进仓库，clone 后可能只有系统 PATH 里的 cloudflared
[ -x "$CF" ] || CF="$(command -v cloudflared || printf '%s' "$CF")"
TUNNEL_LOG=/tmp/tunnel.log
BACKEND_LOG=/tmp/cv-backend.log
MAX_CANDIDATES=3
HEALTH_INTERVAL=15
HEALTH_FAILS=3
PORT="${PORT:-8787}"

# 单实例锁：总控用同一个锁判断守护是否存活
exec 8>/tmp/cv-tunnel.lock
if ! flock -n 8; then
  echo "[$(date '+%H:%M:%S')] 已有隧道守护在运行，本次退出。"
  exit 0
fi
echo $$ > /tmp/cv-tunnel.pid

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 固定托管后端模式：站点已指向固定地址（backend.json 带 credential）时，
# 临时隧道不再需要，守护直接退出，避免把首候选改回隧道地址造成反复断连。
FIXED=$(python3 -c "import json;print(json.load(open('$BACKEND')).get('credential',''))" 2>/dev/null || true)
if [ -n "$FIXED" ]; then
  log "已启用固定托管后端，隧道守护无需运行，退出。"
  exit 0
fi

backend_ok() { curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/runtime"; }
port_listening() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }
current_url() { grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | tail -1; }

ensure_backend() {
  if backend_ok; then return 0; fi
  if port_listening; then
    log "端口 $PORT 被占用但服务未就绪，等待其恢复 ..."
    return 1
  fi
  log "本地后端未运行，主动拉起 node server/index.js ..."
  setsid node "$ROOT/server/index.js" --host 0.0.0.0 >> "$BACKEND_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 20); do
    sleep 1
    if backend_ok; then log "后端已就绪"; return 0; fi
  done
  log "后端启动超时，请检查 $BACKEND_LOG"
  return 1
}

# cloudflared 刚打印地址时边缘可能尚未传播，先探活再对外发布，避免推一个死地址
wait_url_ready() {
  local url="$1"
  for _ in $(seq 1 10); do
    curl -s -o /dev/null --max-time 6 "$url/api/runtime" && return 0
    sleep 2
  done
  return 1
}

sync_backend() {
  local url="$1"
  [ -z "$url" ] && return 1
  local first
  first=$(python3 -c "import json;print(json.load(open('$BACKEND'))['candidates'][0])" 2>/dev/null || true)
  [ "$first" = "$url" ] && return 0

  log "同步隧道地址 $url 到 Pages backend.json ..."
  local old tmp
  old=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$BACKEND" 2>/dev/null \
        | grep -v "$url" | head -n $((MAX_CANDIDATES - 1)) || true)
  tmp=$(mktemp)
  {
    echo "{"
    echo "  \"comment\": \"当前可用的漫画库服务器地址（本机服务探测失败时使用）。由发版流程自动更新。\","
    echo "  \"candidates\": ["
    echo "    \"$url\""
    for o in $old; do echo "    , \"$o\""; done
    echo "  ],"
    echo "  \"local\": \"http://127.0.0.1:$PORT\","
    echo "  \"updatedAt\": $(date +%s)000"
    echo "}"
  } > "$tmp"
  if ! python3 -c "import json;json.load(open('$tmp'))" 2>/dev/null; then
    log "生成的 backend.json 非法，跳过本次同步"; rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$BACKEND"

  if [ -z "$TOKEN" ]; then
    log "未配置 GitHub 令牌（CV_GITHUB_TOKEN / .env.tunnel），本地已更新但跳过推送。"
    return 0
  fi
  local sha content
  sha=$(curl -s -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/$REPO/contents/dist-pages/backend.json?ref=master" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha',''))" 2>/dev/null)
  content=$(base64 -w0 "$BACKEND")
  if [ -n "$sha" ]; then
    curl -s -X PUT -H "Authorization: token $TOKEN" \
      "https://api.github.com/repos/$REPO/contents/dist-pages/backend.json" \
      -d "{\"message\":\"隧道地址自动同步\",\"content\":\"$content\",\"sha\":\"$sha\",\"branch\":\"master\"}" \
      >/dev/null && log "已推送新地址到 GitHub。"
  else
    log "获取 sha 失败，跳过推送（本地 backend.json 已更新）。"
  fi
}

log "隧道守护启动（pid $$，令牌 $([ -n "$TOKEN" ] && echo 已配置 || echo 缺失)）"
while true; do
  # 后端必须活着，否则隧道即使连上也只会回 502/连接拒绝
  if ! ensure_backend; then
    log "后端暂不可用，5s 后重试 ..."
    sleep 5
    continue
  fi

  rm -f "$TUNNEL_LOG"
  setsid "$CF" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 < /dev/null &
  CF_PID=$!
  log "cloudflared 启动 (pid $CF_PID)"

  URL=""
  for _ in $(seq 1 15); do
    sleep 2
    URL=$(current_url)
    if [ -n "$URL" ] && wait_url_ready "$URL"; then
      sync_backend "$URL"
      break
    fi
  done
  if [ -z "$URL" ]; then log "30s 内未拿到隧道地址，准备重建 ..."; fi

  fails=0
  while kill -0 "$CF_PID" 2>/dev/null; do
    sleep "$HEALTH_INTERVAL"
    if [ -z "$URL" ]; then
      URL=$(current_url)
      [ -n "$URL" ] && wait_url_ready "$URL" && sync_backend "$URL"
    fi
    # 后端可能在别处被重启，探活同时兜底拉起
    ensure_backend || true
    if [ -n "$URL" ] && curl -s -o /dev/null --max-time 8 "$URL/api/runtime"; then
      fails=0
      sync_backend "$URL"   # 首候选被其它流程覆盖时自动纠正
    else
      fails=$((fails + 1))
      log "隧道健康检查失败 $fails/$HEALTH_FAILS"
      if [ "$fails" -ge "$HEALTH_FAILS" ]; then break; fi
    fi
  done

  log "cloudflared 退出或不可用，终止并重建 ..."
  kill "$CF_PID" 2>/dev/null || true
  pkill -P "$CF_PID" 2>/dev/null || true
  wait "$CF_PID" 2>/dev/null || true
  sleep 3
done
