@echo off
title Lead Generator - First-time Setup
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
echo Installing packages...
call npm install
if errorlevel 1 goto fail
echo Installing browser (one-time, ~150 MB)...
call npx playwright install chromium
if errorlevel 1 goto fail
echo Creating the mgli command...
call npm link
if errorlevel 1 (
  echo.
  echo WARNING: could not create the mgli command. You can still use run.bat and update.bat in this folder.
)
echo.
echo Setup complete!
echo   - Open a NEW terminal and type  mgli  to start
echo   - Type  mgli update  any time to get the latest version
echo   - (or just double-click run.bat, and update.bat to update)
pause
exit /b 0
:fail
echo Setup failed. Check your internet connection and try again.
pause
exit /b 1
