@echo off
REM Starts Auto Clicker. Nothing to install on Windows - it uses Python's
REM standard library only.
setlocal
cd /d "%~dp0"

where pythonw.exe >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw.exe "autoclicker.py"
    exit /b
)
where pyw.exe >nul 2>nul
if %errorlevel%==0 (
    start "" pyw.exe -3 "autoclicker.py"
    exit /b
)
where python.exe >nul 2>nul
if %errorlevel%==0 (
    start "" python.exe "autoclicker.py"
    exit /b
)

echo Python was not found on this PC.
echo.
echo Install it from https://www.python.org/downloads/ and tick
echo "Add python.exe to PATH" during setup, then run this file again.
pause
