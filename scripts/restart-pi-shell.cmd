@echo off
rem Restart the pi-shell bridge (and open the browser). CRLF + ASCII only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-pi-shell.ps1"
