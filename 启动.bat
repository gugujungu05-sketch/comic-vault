@echo off
chcp 65001 >nul
title ComicVault
cd /d "%~dp0"

echo.
echo   ComicVault 启动器
echo   ================================

REM 1) 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未检测到 Node.js。
  echo   请先到 https://nodejs.org 下载安装 LTS 版本（20 或更高），
  echo   安装时一路点“下一步”即可，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo   Node.js %%v 已就绪

REM 2) 首次运行装依赖
if not exist node_modules (
  echo.
  echo   首次运行，正在安装依赖（约 1-3 分钟，请耐心等待）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

REM 3) 首次运行构建前端
if not exist dist (
  echo.
  echo   正在构建界面...
  call npm run build
  if errorlevel 1 (
    echo 界面构建失败。
    pause
    exit /b 1
  )
)

REM 4) 启动并打开浏览器
echo.
echo   ComicVault 启动中...
echo   地址：http://localhost:8787
echo   关闭本窗口即可停止服务
echo.
start "" http://localhost:8787
call npm start

pause
