@echo off
title Lead Generator
cd /d "%~dp0"
if not exist node_modules (
  echo Please run setup.bat first.
  pause
  exit /b 1
)
node cli.js
echo.
pause
