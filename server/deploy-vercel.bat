@echo off
rem ---------------------------------------------------------------------------
rem  Bastides relay - deploy the server folder to Vercel.
rem
rem  Usage:
rem    deploy-vercel.bat           production deployment
rem    deploy-vercel.bat preview   preview deployment (separate URL)
rem
rem  First run: the Vercel CLI asks you to sign in and to link a project
rem  (answer "server" as the directory; no build command, no framework).
rem  Then add Redis once: Vercel dashboard > project > Storage >
rem  Upstash for Redis > Connect, and redeploy. Without Redis the relay
rem  cannot share rooms between serverless instances (see README.md).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 18 or later is required: https://nodejs.org
  exit /b 1
)

if /i "%~1"=="preview" (
  call npx --yes vercel@latest deploy
) else (
  call npx --yes vercel@latest deploy --prod
)
if errorlevel 1 exit /b %errorlevel%

echo.
echo Check the deployment: open ^<your-url^>/health
echo It must answer "store":"upstash-redis". If it says "memory", connect Redis and redeploy.
exit /b 0
