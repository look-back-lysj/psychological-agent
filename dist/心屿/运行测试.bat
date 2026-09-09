@echo off
chcp 65001 >nul 2>&1
title 心屿 - 运行测试
echo.
echo 正在运行测试...
echo.
node tests/run.js
echo.
pause
