@echo off
REM Starts Auto Clicker. Nothing to install on Windows beyond Python itself.
REM Every way this can fail should say so on screen rather than closing.
setlocal
cd /d "%~dp0"
title Auto Clicker launcher

if not exist "autoclicker.py" goto :missing_files
if not exist "backend.py" goto :missing_files

REM Try the py launcher first. It ships with the python.org installer and,
REM unlike plain "python", never resolves to the Microsoft Store placeholder
REM that silently does nothing when you run it.
set "PY=py -3"
set "PYW=pyw -3"
%PY% -c "" >nul 2>nul
if not errorlevel 1 goto :have_python

set "PY=python"
set "PYW=pythonw"
%PY% -c "" >nul 2>nul
if not errorlevel 1 goto :have_python
goto :no_python

:have_python
%PY% -c "import tkinter" >nul 2>nul
if errorlevel 1 goto :no_tkinter

where pyw.exe >nul 2>nul
if errorlevel 1 if "%PYW%"=="pyw -3" set "PYW=py -3"

start "" %PYW% "autoclicker.py"
exit /b 0


:missing_files
echo.
echo   Auto Clicker's files are not in this folder.
echo.
echo   run.bat has to sit next to autoclicker.py and backend.py. If you
echo   unzipped a download, open the inner folder and run it from there.
echo.
echo   This folder is: %CD%
echo.
pause
exit /b 1

:no_python
echo.
echo   Python is not installed on this PC ^(or Windows is pointing at the
echo   Microsoft Store placeholder instead of a real install^).
echo.
echo   Fix: get it from https://www.python.org/downloads/
echo        During setup, TICK THE BOX "Add python.exe to PATH".
echo        Then run this file again.
echo.
pause
exit /b 1

:no_tkinter
echo.
echo   Python is installed, but this copy has no tkinter - the built-in
echo   library that draws the window. Python from the Microsoft Store is
echo   usually the one missing it.
echo.
echo   Fix: install Python from https://www.python.org/downloads/
echo        and tick "Add python.exe to PATH", then run this file again.
echo.
pause
exit /b 1
