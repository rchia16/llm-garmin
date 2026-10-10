@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup Garmin Python.ps1"
set "setupResult=%errorlevel%"
pause
exit /b %setupResult%
