@echo off
chcp 65001 >nul
title 漫画库 ComicVault 桌面软件
cd /d "%~dp0desktop"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo 首次运行，正在安装桌面运行库，请稍候...
  call npm install
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动漫画库桌面软件...
echo 数据与网站实时互通，首次打开请用同一个邮箱账号登录一次。
call npm start
pause
