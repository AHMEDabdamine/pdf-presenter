@echo off
setlocal EnableDelayedExpansion

:: PDF Presenter - Windows Installation Script
:: This script installs Node.js if needed, installs dependencies, and launches the app

title PDF Presenter - Windows Installer

echo ==========================================
echo    PDF Presenter - Windows Installer
echo ==========================================
echo.

set "NODE_VERSION=18"
set "APP_NAME=PDF Presenter"
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Check if running as administrator (needed for Node.js installation)
net session >nul 2>&1
set "ADMIN=%errorlevel%"

:: Function to check Node.js
call :check_node
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Node.js not found or version too old
    echo.
    
    if %ADMIN% NEQ 0 (
        echo [WARNING] Administrator rights needed to install Node.js
        echo Please run this script as Administrator, or install Node.js manually from:
        echo https://nodejs.org/en/download
        echo.
        pause
        exit /b 1
    )
    
    call :install_node
    
    :: Refresh environment variables after installation
    call :refresh_env
    
    :: Check again
    call :check_node
    if !ERRORLEVEL! NEQ 0 (
        echo [ERROR] Node.js installation failed
        echo Please install manually from https://nodejs.org/en/download
        pause
        exit /b 1
    )
)

echo [SUCCESS] Node.js is ready
node --version

:: Check npm
call :check_npm
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm is not installed properly
    pause
    exit /b 1
)
echo [SUCCESS] npm is ready
npm --version
echo.

:: Install dependencies
if exist "package.json" (
    if exist "node_modules" (
        echo [SUCCESS] Dependencies already installed ^(node_modules found^)
    ) else (
        echo [INFO] Installing npm dependencies...
        call npm install
        if !ERRORLEVEL! NEQ 0 (
            echo [ERROR] Failed to install dependencies
            pause
            exit /b 1
        )
        echo [SUCCESS] Dependencies installed
    )
) else (
    echo [ERROR] package.json not found. Are you in the correct directory?
    pause
    exit /b 1
)

echo.
echo ==========================================
echo    Installation Complete!
echo ==========================================
echo.

:: Get IP addresses
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    echo Network IP: !IP!
)

echo.
echo The app will be available at:
echo   - Local:    http://localhost:3000
echo   - Network:  http://%IP%:3000 (if on same network)
echo.
echo Press Ctrl+C to stop the server
echo.
echo [INFO] Starting %APP_NAME%...

:: Launch the app
call npm start

:: If npm start fails, pause to show error
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Application exited with error
    pause
)

exit /b 0

:: ==========================================
:: Functions
:: ==========================================

:check_node
    node --version >nul 2>&1
    if %ERRORLEVEL% NEQ 0 exit /b 1
    
    :: Check version (need >= 16)
    for /f "tokens=1 delims=v." %%a in ('node --version') do (
        set "NODE_MAJOR=%%a"
        if !NODE_MAJOR! LSS 16 exit /b 1
    )
    exit /b 0

:check_npm
    npm --version >nul 2>&1
    exit /b %ERRORLEVEL%

:install_node
    echo [INFO] Downloading Node.js installer...
    
    :: Determine architecture
    if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
        set "NODE_ARCH=x64"
    ) else (
        set "NODE_ARCH=x86"
    )
    
    set "NODE_INSTALLER=node-v%sNODE_VERSION%.x-win-%NODE_ARCH%.msi"
    set "NODE_URL=https://nodejs.org/dist/latest-v%sNODE_VERSION%.x/%NODE_INSTALLER%"
    
    :: Download using PowerShell
    echo [INFO] Downloading Node.js v%NODE_VERSION% for %NODE_ARCH%...
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v18.x/' -OutFile 'node_index.html' -UseBasicParsing" 2>nul
    
    :: Get the actual MSI filename from the index
    for /f "tokens=*" %%a in ('powershell -Command "(Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v18.x/' -UseBasicParsing).Content | Select-String -Pattern 'node-v[\d\.]+-x64\.msi' | Select-Object -First 1 | ForEach-Object { $_.Matches.Value }"') do (
        set "MSI_FILE=%%a"
    )
    
    if not defined MSI_FILE (
        set "MSI_FILE=node-v18.20.4-x64.msi"
    )
    
    echo [INFO] Downloading %MSI_FILE%...
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v18.x/%MSI_FILE%' -OutFile 'node_installer.msi' -UseBasicParsing"
    
    if not exist "node_installer.msi" (
        echo [ERROR] Failed to download Node.js installer
        exit /b 1
    )
    
    echo [INFO] Installing Node.js (this may take a minute)...
    msiexec /i "node_installer.msi" /qn /norestart
    
    :: Clean up
    del "node_installer.msi" 2>nul
    del "node_index.html" 2>nul
    
    echo [SUCCESS] Node.js installed
    exit /b 0

:refresh_env
    echo [INFO] Refreshing environment variables...
    :: Update PATH for this session
    for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr Path') do (
        set "PATH=%%b"
    )
    for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr Path') do (
        set "PATH=%%b;!PATH!"
    )
    :: Add common Node.js paths
    set "PATH=C:\Program Files\nodejs;!PATH!"
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;!PATH!"
    exit /b 0
