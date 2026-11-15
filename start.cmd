@echo off
rem Starts Couchwave. Double-click it, or run it from Task Scheduler at boot (see README.md).
rem If the server ever stops or crashes, it starts again 5 seconds later. Close this window to stop it.
rem
rem Logs (in data\): the server writes server.log itself (timestamped, trimmed to the newest ~2 MB once it
rem passes 5 MB). server-console.log only catches what's printed outside it: restarts after edits, and errors
rem that stop server.js starting at all (e.g. a typo). It's trimmed to its last 2000 lines each time the server starts.
cd /d "%~dp0"
rem Find programs installed just for this user (node, yt-dlp, ffmpeg from winget), even when Task Scheduler
rem starts this at boot, which doesn't load the user's own PATH.
for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul ^| find /i "path"') do call set "PATH=%%b;%PATH%"
if not exist data mkdir data
echo Couchwave is running: open http://localhost:3000 (or the port set in config.json).
echo The password is in config.json (made on the first run). Logs are in the data folder.
echo Keep this window open; close it to stop Couchwave.
:loop
powershell -NoProfile -Command "$f='data\server-console.log'; if ((Test-Path $f) -and (Get-Item $f).Length -gt 1MB) { $l = Get-Content $f -Tail 2000; Set-Content $f $l }"
echo ==== %date% %time% starting ==== >> data\server-console.log
node --watch server.js >> data\server-console.log 2>&1
echo ==== %date% %time% server exited (code %errorlevel%), restarting in 5s ==== >> data\server-console.log
timeout /t 5 /nobreak > nul
goto loop
