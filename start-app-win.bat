@echo off
setlocal EnableDelayedExpansion

:: PDF Presenter - App Starter
:: This script launches the PDF Presenter application

title PDF Presenter - Starter

echo ==========================================
echo    Starting PDF Presenter...
echo ==========================================
echo.

set "APP_NAME=PDF Presenter"
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Dependencies not found. Please run windows-install.bat first.
    pause
    exit /b 1
)

:: Get IP addresses
set "IP=localhost"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set "IP_TEMP=%%a"
    set "IP=!IP_TEMP: =!"
)

echo The app will be available at:
echo   - Local:    http://localhost:3000
echo   - Network:  http://%IP%:3000
echo.
echo Press Ctrl+C to stop the server
echo.
echo [INFO] Launching %APP_NAME%...

:: Launch the app
call npm start

:: If npm start fails, pause to show error
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Application exited with error
    pause
)

exit /b 0
