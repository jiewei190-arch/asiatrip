@echo off
REM Runs Auto Clicker with everything visible. If run.bat does nothing, run
REM this one and send whatever it prints.
setlocal
cd /d "%~dp0"
title Auto Clicker - diagnostics

echo ================= Auto Clicker diagnostics =================
echo Folder: %CD%
echo.
echo --- files present ---
if exist "autoclicker.py" (echo   autoclicker.py  yes) else (echo   autoclicker.py  NO)
if exist "backend.py"     (echo   backend.py      yes) else (echo   backend.py      NO)
echo.
echo --- python found on PATH ---
where py 2>nul
where python 2>nul
where pythonw 2>nul
echo.
echo --- version ---
py -3 -V 2>nul || python -V 2>nul || echo   no working python
echo.
echo --- tkinter ---
py -3 -c "import tkinter; print('   tkinter OK')" 2>nul || python -c "import tkinter; print('   tkinter OK')" 2>nul || echo   tkinter MISSING
echo.
echo --- starting the app (errors will appear below) ---
py -3 "autoclicker.py" 2>&1 || python "autoclicker.py" 2>&1
echo.
echo --- the app exited with code %errorlevel% ---
echo.
pause
