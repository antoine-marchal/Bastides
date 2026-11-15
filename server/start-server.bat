@echo off
rem ---------------------------------------------------------------------------
rem  Bastides relay - run the online relay server on this machine.
rem
rem  Usage:
rem    start-server.bat            listen on port 8787
rem    start-server.bat 9000       listen on another port
rem
rem  Memory storage by default. Set UPSTASH_REDIS_REST_URL and
rem  UPSTASH_REDIS_REST_TOKEN to use Redis instead.
rem  In the game: Multijoueur > En ligne > Serveur = localhost:8787
rem  (or http://<this machine's IP>:8787 from other devices).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 18 or later is required: https://nodejs.org
  exit /b 1
)
if not "%~1"=="" set "PORT=%~1"
node server.js
exit /b %errorlevel%
