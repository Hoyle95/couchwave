@echo off
rem Stops Couchwave: the server, and start.cmd starting it again. Double-click it, or run it from a terminal.
rem It works whether Couchwave was started by double-clicking start.cmd or by the scheduled task at boot.
cd /d "%~dp0"
for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul ^| find /i "path"') do call set "PATH=%%b;%PATH%"
node server.js --stop
timeout /t 5 > nul
