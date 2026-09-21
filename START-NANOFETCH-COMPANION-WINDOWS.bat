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

echo Checking for an older NanoFetch Local Companion...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$cs=Get-NetTCPConnection -LocalPort 17345 -State Listen -ErrorAction SilentlyContinue; foreach($c in $cs){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess) -ErrorAction SilentlyContinue; if($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'local-companion'){Write-Host ('Stopping old Local Companion PID '+$c.OwningProcess); Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue}}"
timeout /t 1 /nobreak >nul

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
echo Starting the current NanoFetch Local Companion...
echo Your browser will open the local YouTube page automatically.
echo Keep this window open while using Local Companion.
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul & start \"\" http://127.0.0.1:17345/"
call npm run companion

pause
