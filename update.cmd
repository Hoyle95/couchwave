@echo off
rem Updates Couchwave to the newest release. Double-click it, or run it from a terminal.
rem It checks the download, tries the new version out first, and goes back if it doesn't start.
cd /d "%~dp0"
for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul ^| find /i "path"') do call set "PATH=%%b;%PATH%"
node server.js --update
pause
