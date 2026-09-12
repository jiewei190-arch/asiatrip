@echo off
REM Same as Run-AutoClicker.bat, but elevated. Windows refuses to inject
REM clicks into a window running at a higher privilege level, so use this one
REM if your game runs as administrator.
cd /d "%~dp0"

net session >nul 2>nul
if %errorlevel%==0 (
    call "%~dp0Run-AutoClicker.bat"
    exit /b
)

powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
