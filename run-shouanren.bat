@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShouAnRen - Local Service

echo ============================================
echo   ShouAnRen  one-click launcher
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [1/2] First launch - installing dependencies...
  echo       needs internet, about 1-3 minutes, please wait
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Open Git Bash in this folder and run:
    echo   npm install --omit=dev
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies already installed.
)

echo.
echo [2/2] Starting service on http://localhost:3000
echo       Browser opens automatically in 3 seconds.
echo       KEEP THIS WINDOW OPEN while using the app.
echo       Close this window or press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node main.js

echo.
echo Service stopped.
pause
