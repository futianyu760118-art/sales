@echo off
cd /d "%~dp0backend"
if not exist "..\logs" mkdir "..\logs"

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3010" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

start "EBMS-HJ-Backend" /MIN cmd /c "node server.js > ..\logs\backend.out.log 2> ..\logs\backend.err.log"

:WAIT
timeout /t 1 /nobreak >nul
netstat -an | findstr "3010" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto WAIT

echo.
echo ========================================
echo   Backend started: http://localhost:3010
echo   Login: admin / admin123
echo ========================================
exit /b 0