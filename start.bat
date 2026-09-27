@echo off
title Social Coding LMS
cd /d "%~dp0"

echo.
echo  ============================================
echo    Social Coding LMS - starting
echo  ============================================
echo.

REM Node must be installed and on the PATH
where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js was not found.
    echo  Install it from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
)

REM Install dependencies the first time only
if not exist "node_modules" (
    echo  First run - installing dependencies. This takes a minute.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  Installation failed. Check the messages above.
        pause
        exit /b 1
    )
    echo.
)

REM Show every address this machine can be reached on, so the phone can be
REM pointed at the right one without guessing.
echo  This computer's network addresses:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo    http://%%a:3000
echo.
echo  Use the one starting 192.168 or 10. on the phone.
echo  Press Ctrl+C to stop the server.
echo.

node server.js

echo.
echo  The server has stopped.
pause
