@echo off
rem 星屑物语 · 多人联机服务端 本机一键启动（Windows）
rem 玩家把 http://你的IP:8770 发给朋友即可；公网部署请看 docs/deploy.md
cd /d "%~dp0.."
setlocal

set "BUN="
where bun >nul 2>nul && set "BUN=bun"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not defined BUN if exist "%USERPROFILE%\.cherrystudio\bin\bun.exe" set "BUN=%USERPROFILE%\.cherrystudio\bin\bun.exe"

if not defined BUN (
  echo 未找到 bun，请先安装：winget install Oven-sh.Bun  或  curl -fsSL https://bun.sh/install ^| bash
  pause & exit /b 1
)

if not exist "index.html" (
  echo 正在打包客户端 index.html ...
  "%BUN%" run build.js
)

echo 启动服务端： http://localhost:8770
"%BUN%" server\index.js
pause
