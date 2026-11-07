#!/bin/bash
cd "$(dirname "$0")/desktop" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org/"
  read -r -p "按回车退出"
  exit 1
fi

if [ ! -d "node_modules/electron" ]; then
  echo "首次运行，正在安装桌面运行库，请稍候..."
  npm install || { echo "安装失败，请检查网络后重试。"; read -r -p "按回车退出"; exit 1; }
fi

echo "正在启动漫画库桌面软件..."
echo "数据与网站实时互通，首次打开请用同一个邮箱账号登录一次。"
npm start
