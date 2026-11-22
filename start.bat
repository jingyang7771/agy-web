@echo off
where node >nul 2>nul || (echo [ERROR] Please install Node.js v18+ first & pause & exit /b 1)
where agy >nul 2>nul || (echo [ERROR] Please install Antigravity CLI agy first & pause & exit /b 1)
if "%~1"=="" node "%~dp0server.js" --open
if not "%~1"=="" node "%~dp0server.js" --open --cwd "%~1"
pause
