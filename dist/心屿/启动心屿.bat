@echo off
chcp 65001 >nul 2>&1
title 心屿 · 大学生情绪陪伴助手

echo.
echo   ========================================
echo   心屿 · 大学生情绪陪伴助手
echo   ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo 请先安装 Node.js：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

:: 首次运行安装依赖
if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖...
  npm install --production
  echo.
)

:: 检查 .env
if not exist ".env" (
  echo [提示] 未检测到 .env 文件
  echo 已从 .env.example 复制模板，请编辑 .env 填入 API Key
  echo.
  copy .env.example .env >nul 2>&1
  echo 正在打开 .env 文件...
  start notepad .env
  echo 填写完毕后，请关闭记事本，本窗口会自动继续。
  echo.
  pause
)

echo [2/2] 正在启动服务...
echo.
node src/index.js
pause
