@echo off
rem One click demo, all on this PC: the Claim Builder, the claims inbox and the accountant's dashboard.
rem Save a claim in the Claim Builder and it appears on the dashboard. Close the two black windows to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed, so the Claim Builder cannot be served. Get it from https://python.org and run this again.
  pause
  exit /b 1
)
start "WFC Claims inbox + dashboard (close to stop)" cmd /k node server\server.js
start "WFC Claim Builder, local (close to stop)" cmd /k python -m http.server 8080 --directory "%~dp0..\WFC Claim Builder"
timeout /t 3 /nobreak >nul
start "" http://localhost:8787/
start "" "http://localhost:8080/?dash=http://localhost:8787/api"
