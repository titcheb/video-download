@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22 or newer is required.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

set NANOFETCH_LOCAL_INSTALL=1
if not exist node_modules\youtube-dl-exec (
  echo Installing NanoFetch Local Companion dependencies...
  call npm install
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting NanoFetch Local Companion...
echo Your browser will open the local YouTube page automatically.
echo Keep this window open while downloading YouTube videos.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start \"\" http://127.0.0.1:17345/"
call npm run companion

pause
