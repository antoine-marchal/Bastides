@echo off
setlocal
if "%~1"=="" (
  echo Utilisation : set-version.bat MAJEUR.MINEUR.CORRECTIF
  exit /b 1
)
node "%~dp0scripts\sync-app-metadata.mjs" %*
exit /b %errorlevel%
