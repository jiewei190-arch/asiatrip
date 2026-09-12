@echo off
REM Same as run.bat, but elevated. Windows refuses to inject clicks into a
REM window that is running at a higher privilege level than the clicker, so
REM use this one if your game runs as administrator.
cd /d "%~dp0"

net session >nul 2>nul
if %errorlevel%==0 (
    call "%~dp0run.bat"
    exit /b
)

powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
