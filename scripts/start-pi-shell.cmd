@echo off
rem pi-shell launcher (called by the desktop shortcut).
rem HARD RULE: this file must stay CRLF + ASCII only.
rem LF-only or UTF-8 comments make cmd.exe misparse the file (P0-B, 2026-11-06).
rem
rem Crash self-healing: the bridge runs inside a restart loop.
rem   exit code 0            -> clean stop (SIGINT / SIGTERM / Ctrl+Break handled by the bridge), no restart
rem   control-event codes    -> user stop (Ctrl+C while the bridge dies), no restart
rem   any other exit code   -> crash, logged, restarted after 1s / 2s / 4s backoff,
rem                            at most 3 restarts per 5-minute window
rem No service, no autostart, no background daemon: closing this window stops everything.

rem Phone access over Tailscale (default ON when available):
rem   tailscale installed AND `tailscale ip -4` returns 100.x -> PI_SHELL_BIND=tailscale
rem   tailscale mode listens on BOTH 127.0.0.1 and the 100.x address (same port), so the
rem   desktop shortcut (127.0.0.1) keeps working while the phone uses 100.x.
rem   PI_SHELL_NO_TAILSCALE=1 disables the auto-detection.
rem   PI_SHELL_BIND=0.0.0.0 is refused unless PI_SHELL_ALLOW_LAN=1 is also set.
rem   Details: docs/RUNBOOK.md section 6.
setlocal
cd /d "%~dp0.."

if not defined PI_SHELL_PORT set "PI_SHELL_PORT=7788"

rem Tailscale auto-detection (dual stack): only set the env var, never override a user value.
set "PI_SHELL_TS_IP="
if not defined PI_SHELL_NO_TAILSCALE if not defined PI_SHELL_BIND (
  where tailscale >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%i in ('tailscale ip -4 2^>nul') do (
      if not defined PI_SHELL_TS_IP set "PI_SHELL_TS_IP=%%i"
    )
  )
  if defined PI_SHELL_TS_IP set "PI_SHELL_BIND=tailscale"
)
set "LAUNCH_LOG=%CD%\logs\launcher.log"
set "MAX_RESTARTS=3"
set "WINDOW_SECONDS=300"

where node >nul 2>nul
if errorlevel 1 (
  echo [pi-shell] Node.js was not found in PATH. Install Node 24 first.
  pause
  exit /b 1
)

rem Single instance: if the port already answers, only open the browser.
node -e "const net=require('net');const s=net.connect(Number(process.env.PI_SHELL_PORT),'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)" >nul 2>nul
if not errorlevel 1 (
  echo [pi-shell] already running on port %PI_SHELL_PORT% - opening the browser.
  if not defined PI_SHELL_NO_BROWSER start "" "http://127.0.0.1:%PI_SHELL_PORT%"
  exit /b 0
)

if not exist "%CD%\logs" mkdir "%CD%\logs" >nul 2>nul

rem Open the browser ~3s after the bridge starts (bridge is ready in 1-2s).
if not defined PI_SHELL_NO_BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:%PI_SHELL_PORT%'"
)

echo [pi-shell] starting bridge on http://127.0.0.1:%PI_SHELL_PORT%
if defined PI_SHELL_TS_IP echo [pi-shell] mobile over Tailscale: http://%PI_SHELL_TS_IP%:%PI_SHELL_PORT%
echo [pi-shell] close this window to stop the bridge.

set "CRASHES=0"
set "WINDOW_START="

:run_bridge
call :stamp
call :log bridge start port=%PI_SHELL_PORT%
node "bridge\src\index.mjs"
set "RC=%ERRORLEVEL%"
call :stamp
if "%RC%"=="0" goto clean_stop
if "%RC%"=="130" goto signal_stop
if "%RC%"=="-1073741510" goto signal_stop
if "%RC%"=="3221225786" goto signal_stop

rem ---- crash path ----
call :log bridge exit rc=%RC% crash
if not defined WINDOW_START set "WINDOW_START=%EPOCH%"
set /a AGE=%EPOCH%-%WINDOW_START%
if %AGE% LSS 0 set /a AGE=0
if %AGE% GEQ %WINDOW_SECONDS% (
  set "WINDOW_START=%EPOCH%"
  set "CRASHES=0"
)
set /a CRASHES+=1
if %CRASHES% GTR %MAX_RESTARTS% goto give_up

set /a DELAY=1
if "%CRASHES%"=="2" set /a DELAY=2
if "%CRASHES%"=="3" set /a DELAY=4
call :log bridge restart %CRASHES% of %MAX_RESTARTS% in %DELAY%s
set /a TICKS=%DELAY%+1
rem ping is the sleep: timeout.exe refuses to sleep when stdin is redirected.
ping -n %TICKS% 127.0.0.1 >nul 2>nul
goto run_bridge

:clean_stop
call :log bridge exit rc=0 clean stop no restart
echo [pi-shell] bridge stopped (exit code 0).
exit /b 0

:signal_stop
call :log bridge exit rc=%RC% control event treated as user stop no restart
echo [pi-shell] bridge stopped by Ctrl+C.
exit /b 0

:give_up
call :log bridge giving up after %CRASHES% crashes inside %WINDOW_SECONDS%s window
echo.
echo [pi-shell] bridge crashed %CRASHES% times within %WINDOW_SECONDS% seconds.
echo [pi-shell] automatic restart is disabled to avoid a crash loop.
echo [pi-shell] check logs\bridge.log and logs\launcher.log, then start again.
rem Do not wait for a keypress: extra launcher windows pile up on the desktop.
timeout /t 10 >nul
exit /b 1

rem ---- helpers (never reached by fall-through) ----
:stamp
rem node gives a locale-independent stamp: epoch seconds + ISO-8601 UTC.
set "EPOCH=0"
set "TS=unknown"
for /f "tokens=1,2" %%a in ('node -e "const d=new Date();console.log(Math.trunc(d.getTime()/1000)+' '+d.toISOString())"') do (
  set "EPOCH=%%a"
  set "TS=%%b"
)
exit /b 0

:log
if not exist "%CD%\logs" mkdir "%CD%\logs" >nul 2>nul
>>"%LAUNCH_LOG%" echo %TS% ^| %*
exit /b 0

