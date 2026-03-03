@echo off
title Video Transcriber
echo.
echo  ================================
echo    Video Transcriber - Starting
echo  ================================
echo.

:: Check Python is available via Windows Python Launcher
py --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found.
    echo  Please install Python from https://www.python.org/downloads/
    echo  Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)

:: Install dependencies if not already installed
echo  Checking dependencies...
py -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo  Installing Flask...
    py -m pip install flask --quiet
)
py -c "import yt_dlp" >nul 2>&1
if errorlevel 1 (
    echo  Installing yt-dlp...
    py -m pip install yt-dlp --quiet
)
py -c "import whisper" >nul 2>&1
if errorlevel 1 (
    echo  Installing Whisper (this may take a few minutes on first run^)...
    py -m pip install openai-whisper --quiet
)

:: Start Flask server in a minimized window
start /min "VT-Server" py "%~dp0app.py"

:: Wait for server to be ready
echo  Starting server...
timeout /t 3 /nobreak >nul

:: Open browser
echo  Opening browser...
start http://localhost:5050

echo.
echo  App is running at http://localhost:5050
echo  Close this window to stop the server.
echo.
pause
