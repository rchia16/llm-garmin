@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create Local Workout Builder Shortcut.ps1"
pause
