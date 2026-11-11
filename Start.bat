@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, so the local claims inbox cannot start.
  echo Install it from https://nodejs.org  or put the dashboard online instead, see README.md.
  pause
  exit /b 1
)
rem open the page a moment after the server has started
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787/"
node server\server.js
pause
