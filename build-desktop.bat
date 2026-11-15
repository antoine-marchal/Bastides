@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\.bin\tauri.cmd" (
  call npm ci || exit /b 1
)
node scripts\sync-app-metadata.mjs || exit /b 1
call npm run tauri -- build --ci
exit /b %errorlevel%
