@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install it from https://nodejs.org/ and double-click this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Local Workout Builder...
start "Local Workout Builder" cmd /c "npm run dev -- --host localhost --strictPort"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5173/"
echo The app is running at http://localhost:5173/
echo Close the Local Workout Builder server window to stop the app.
endlocal
