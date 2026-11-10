@echo off
REM INDRA - one-click local start for Windows.
REM Creates a private virtual environment (.venv), installs requirements once, then starts INDRA.
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist ".venv\Scripts\python.exe" (
  echo [INDRA] Creating virtual environment...
  %PY% -m venv .venv || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
)
echo [INDRA] Installing / checking packages (first run takes 1-3 minutes)...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q --upgrade pip
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || (echo Package install failed. Check your internet connection. & pause & exit /b 1)
if "%PORT%"=="" set PORT=5000
start "" http://127.0.0.1:%PORT%/
".venv\Scripts\python.exe" app.py
pause
