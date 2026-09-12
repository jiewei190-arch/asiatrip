@echo off
REM Auto Clicker - the version that needs nothing installed.
REM Windows already has PowerShell and .NET, which is all this uses.
cd /d "%~dp0"
title Auto Clicker

if not exist "AutoClicker.ps1" (
    echo.
    echo   AutoClicker.ps1 is not in this folder.
    echo   This file has to sit next to it. If you unzipped a download,
    echo   open the inner folder and run it from there.
    echo.
    echo   This folder is: %CD%
    echo.
    pause
    exit /b 1
)

REM Windows marks files that came out of a downloaded zip as blocked.
powershell -NoProfile -Command "Unblock-File -LiteralPath '%~dp0AutoClicker.ps1'" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0AutoClicker.ps1"

if errorlevel 1 (
    echo.
    echo   Auto Clicker stopped with an error. The details are above.
    echo.
    pause
)
