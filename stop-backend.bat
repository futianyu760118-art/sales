@echo off
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3010" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
taskkill /F /FI "WINDOWTITLE eq EBMS-HJ-Backend*" >nul 2>&1
echo Backend stopped.
exit /b 0