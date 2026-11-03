@echo off
chcp 65001 >nul
cd /d %~dp0

echo 正在停止旧的服务进程（如有）...
REM Two guards here, both required:
REM 1) findstr /c:":3000 " - /c: means literal match, so the trailing space
REM    is kept. Plain findstr ":3000 " splits on the space and degrades to
REM    a substring match, which also matches ports 30000-30009 and would
REM    kill unrelated programs running there.
REM 2) tasklist confirms the PID is node.exe before killing it, so a port
REM    held by another tool is left alone.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3000 " ^| findstr "LISTENING"') do (
  for /f "tokens=1" %%b in ('tasklist /fi "PID eq %%a" /nh 2^>nul ^| findstr /i "node.exe"') do (
    echo   停止旧进程 node.exe PID=%%a
    taskkill /f /pid %%a >nul 2>nul
  )
)
timeout /t 2 /nobreak >nul

echo 正在启动天下第一家专用进销存服务...
echo 本机访问: http://127.0.0.1:3000
echo 手机访问: 同一 WiFi 下用电脑局域网IP:3000
echo （关闭此窗口即停止服务）
echo.

REM 优先使用系统 node，找不到则回退到常见安装路径
set "NODE=node"
where node >nul 2>nul
if %errorlevel%==0 goto :run
if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE=C:\Program Files\nodejs\node.exe"
  goto :run
)
echo 未找到 node.exe，请先安装 Node.js 或确认其在 PATH 中。
pause
exit /b 1

REM 首次解压或换了 Node 版本导致依赖缺失时，自动安装（需联网）
if not exist node_modules (
  echo 检测到依赖未安装，正在执行 npm install（首次需联网，请稍候）...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败：请确认已安装 Node.js 并能访问网络，或手动运行 npm install。
    pause
    exit /b 1
  )
)

:run
start http://127.0.0.1:3000
"%NODE%" server.js
pause
