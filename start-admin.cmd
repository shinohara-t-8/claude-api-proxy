@echo off
cd /d "%~dp0"
echo Starting Claude Key Admin on http://127.0.0.1:8787 ...
start "" http://127.0.0.1:8787/
node admin\server.js
pause
