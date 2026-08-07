@echo off
setlocal
cd /d "%~dp0"
set "OUT=forge-database-manager-1.0.0-windows-x86_64-standalone.zip"
echo Assembling %OUT% ...
copy /b forge-database-manager-1.0.0-windows-x86_64-standalone.part-00 + forge-database-manager-1.0.0-windows-x86_64-standalone.part-01 "%OUT%" >nul
if errorlevel 1 (
  echo Failed to assemble parts.
  pause
  exit /b 1
)
echo Done: %OUT%
echo Unzip it, then run "DB Pilot.vbs".
pause
endlocal
