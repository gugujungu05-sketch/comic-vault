#!/usr/bin/env bash
# ComicVault 一键启动（macOS / Linux）
# 双击即可运行；也可在终端里执行 ./启动.command

set -e
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1) 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  未检测到 Node.js。"
  echo "  请先到 https://nodejs.org 下载安装 LTS 版本（20 或更高），装完重新双击本文件。"
  echo ""
  read -r -p "  按回车键关闭..." _
  exit 1
fi

echo "  Node.js $(node -v) 已就绪"

# 2) 首次运行装依赖
if [ ! -d node_modules ]; then
  echo "  首次运行，正在安装依赖（约 1-3 分钟，请耐心等待）..."
  npm install --no-audit --no-fund
fi

# 3) 首次运行构建前端
if [ ! -d dist ]; then
  echo "  正在构建界面..."
  npm run build
fi

# 4) 启动并打开浏览器
echo ""
echo "  ComicVault 启动中..."
echo "  地址：http://localhost:8787"
echo "  关闭本窗口即可停止服务"
echo ""
( sleep 2; ( command -v open >/dev/null && open http://localhost:8787 ) || ( command -v xdg-open >/dev/null && xdg-open http://localhost:8787 ) ) >/dev/null 2>&1 &

npm start
