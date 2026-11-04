@echo off
rem ---------------------------------------------------------------------------
rem  Risen Team Schedule Builder - Windows launcher
rem
rem  Thin wrapper: all of the launch logic lives in
rem  scripts\windows-launcher.ps1 so it can be read, tested and reused.
rem
rem  This file never runs "npm install" or "npm run build". It only starts an
rem  already-built standalone server on 127.0.0.1:3178.
rem
rem  Usage:  start.bat            start the app and open the browser
rem          start.bat -NoBrowser start without opening a browser
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
title Risen Team Schedule Builder v1.0

set "RISEN_LAUNCHER=%~dp0scripts\windows-launcher.ps1"

if not exist "%RISEN_LAUNCHER%" (
  echo [Risen] Launcher script not found:
  echo         %RISEN_LAUNCHER%
  echo         Run this file from the application folder that contains scripts\.
  echo.
  pause
  exit /b 127
)

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RISEN_LAUNCHER%" %*
set "RISEN_EXIT=%ERRORLEVEL%"

if not "%RISEN_EXIT%"=="0" (
  echo.
  echo [Risen] Launcher finished with exit code %RISEN_EXIT%.
  echo         Read the message above; nothing was killed and no build was started.
  echo.
  pause
)

exit /b %RISEN_EXIT%
