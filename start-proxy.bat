@echo off
setlocal
REM ============================================================
REM  start-proxy.bat - diem vao DUY NHAT cua pm-ai-proxy
REM  (server tuong thich Anthropic API -> Postman gateway)
REM
REM  Cach dung:
REM    start-proxy.bat                   harvest + khoi dong proxy (mac dinh)
REM    start-proxy.bat noharvest         khoi dong, bo qua harvest (dung cache)
REM    start-proxy.bat start [noharvest] nhu tren, viet ro rang
REM    start-proxy.bat restart           kill cong + DEBUG_PROXY=1 + khoi dong lai
REM    start-proxy.bat restart nodebug   nhu tren nhung KHONG bat DEBUG_PROXY
REM    start-proxy.bat claude [args]     chay Claude Code CLI tro vao proxy
REM    start-proxy.bat help              in bang nay
REM
REM  Luu y: 'claude' phai chay o CUA SO KHAC voi proxy (proxy chiem foreground),
REM  va chay TAI THU MUC DU AN cua ban - script truyen %CD% qua header
REM  x-pm-working-dir (server.mjs: resolveWorkingDir).
REM
REM  Doi cong:  set PM_ANTHROPIC_PORT=9000  roi chay lai.
REM ============================================================

if "%PM_ANTHROPIC_PORT%"=="" set PM_ANTHROPIC_PORT=8788

set "MODE=%~1"
set "SUB=%~2"
if "%MODE%"=="" set "MODE=start"
REM Tuong thich nguoc: start-proxy.bat noharvest
if /i "%MODE%"=="noharvest" set "SUB=noharvest"
if /i "%MODE%"=="noharvest" set "MODE=start"

if /i "%MODE%"=="claude"  goto :mode_claude
if /i "%MODE%"=="restart" goto :mode_restart
if /i "%MODE%"=="start"   goto :mode_start
if /i "%MODE%"=="help"    goto :help
if /i "%MODE%"=="-h"      goto :help
if /i "%MODE%"=="--help"  goto :help
if /i "%MODE%"=="/?"      goto :help
echo [pm-ai-proxy] Khong hieu lenh "%MODE%".
goto :usage

REM ------------------------------------------------------------
:mode_start
call :ensure_node
if errorlevel 1 exit /b 1
REM Nha cong truoc khi start de KHONG bao gio bi EADDRINUSE / phai kill tay.
call :free_port
if /i "%SUB%"=="noharvest" goto :skip_harvest
echo [pm-ai-proxy] Harvest token/template tu Postman Desktop ^(toi da ~30s^) ...
node "%~dp0src\harvest.mjs" --timeout=30
if errorlevel 1 (
  echo.
  echo [pm-ai-proxy] CANH BAO: harvest that bai ^(Postman chua mo hoac chua dang nhap?^).
  echo   Van thu khoi dong proxy bang token/template da cache tu lan truoc.
  echo.
)
goto :run_proxy
:skip_harvest
echo [pm-ai-proxy] Bo qua harvest - dung token/template da cache.
goto :run_proxy

REM ------------------------------------------------------------
:mode_restart
call :ensure_node
if errorlevel 1 exit /b 1
call :free_port
if /i "%SUB%"=="nodebug" goto :restart_nodebug
set DEBUG_PROXY=1
echo [pm-ai-proxy] DEBUG_PROXY: ON
goto :run_proxy
:restart_nodebug
set "DEBUG_PROXY="
echo [pm-ai-proxy] DEBUG_PROXY: OFF
goto :run_proxy

REM ------------------------------------------------------------
:run_proxy
echo [pm-ai-proxy] Khoi dong tren cong %PM_ANTHROPIC_PORT% ...
echo [pm-ai-proxy] Health: http://127.0.0.1:%PM_ANTHROPIC_PORT%/health   ^(Ctrl+C de dung^)
echo.
node "%~dp0src\claude-proxy.mjs"
set "RC=%errorlevel%"
if "%RC%"=="0" exit /b 0
echo.
echo [pm-ai-proxy] LOI: proxy da thoat voi ma loi %RC%.
echo   - Neu thay "EADDRINUSE ... :%PM_ANTHROPIC_PORT%" nghia la proxy DA CHAY san tren cong nay.
echo     Ban KHONG can chay lai; de dung:      start-proxy.bat claude
echo     Muon khoi dong lai sach se:           start-proxy.bat restart
echo   - Muon dung cong khac:  set PM_ANTHROPIC_PORT=9000  roi chay lai file nay.
echo.
REM 'restart' thuong chay khong nguoi truc -> khong chan bang pause (nhu restart-proxy.bat cu).
if /i not "%MODE%"=="restart" pause
exit /b %RC%

REM ------------------------------------------------------------
:mode_claude
set "ANTHROPIC_BASE_URL=http://127.0.0.1:%PM_ANTHROPIC_PORT%"
set "ANTHROPIC_API_KEY=pm-proxy"
REM Truyen cwd THAT SU cua phien qua header: proxy uu tien x-pm-working-dir.
REM %CD% = thu muc dang dung khi chay file nay. Bat buoc voi client sdk-ts / Agent SDK
REM vi system prompt cua no KHONG co dong "Working directory:" de proxy tu doc.
REM Yeu cau Claude Code >= v2.1.227 (ho tro ANTHROPIC_CUSTOM_HEADERS).
set "ANTHROPIC_CUSTOM_HEADERS=x-pm-working-dir: %CD%"
REM Bo token dau tien ("claude") khoi command-tail NGUYEN BAN.
REM Khong duoc ghep lai tung %%1: batch coi ca "," "=" ";" la dau phan cach nen
REM "--allowedTools Bash,Read" va "--model=opus" se bi vo, con "&" "|" ">" trong
REM chuoi da trich dan se thoat ra ngoai va duoc thuc thi nhu lenh.
REM Bat buoc: capture %* KHI delayed expansion con TAT (de giu duoc dau "!"),
REM roi moi bat len de cat token dau va goi - gia tri khong bi quet lai
REM tim ky tu dac biet, nen "&" "|" ">" trong chuoi trich dan van an toan.
set CLAUDE_ARGS=%*
setlocal enabledelayedexpansion
set "CLAUDE_ARGS=!CLAUDE_ARGS:*claude=!"
claude !CLAUDE_ARGS!
exit /b !errorlevel!

REM ------------------------------------------------------------
:ensure_node
where node >nul 2>&1 && goto :node_ok
echo [pm-ai-proxy] Khong tim thay Node.js - dang thu cai tu dong...
where winget >nul 2>&1 || goto :node_fail
echo [pm-ai-proxy] Cai Node.js LTS qua winget (co the hien cua so UAC)...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
where node >nul 2>&1 && goto :node_ok
REM Installer khong cap nhat PATH cho cmd dang mo -> them thu cong cho phien nay
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>&1 && goto :node_ok
:node_fail
echo.
echo [pm-ai-proxy] KHONG THE tu dong cai Node.js.
echo   - Cai thu cong tai https://nodejs.org (ban LTS, Windows x64) roi mo lai file nay.
echo   - Hoac cai "App Installer" (winget) tu Microsoft Store roi mo lai.
echo.
pause
exit /b 1
:node_ok
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
echo [pm-ai-proxy] Node.js san sang: %NODEVER%
exit /b 0

REM ------------------------------------------------------------
REM Nha cong %PM_ANTHROPIC_PORT%: kill tien trinh dang LISTEN roi XAC NHAN da nha (thu toi da 5 lan).
REM Dung o CA 'start' lan 'restart' -> khong bao gio EADDRINUSE / phai kill tay.
:free_port
setlocal enabledelayedexpansion
set /a "FP_TRY=0"
:fp_loop
set "FP_PID="
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr :%PM_ANTHROPIC_PORT% ^| findstr LISTENING') do set "FP_PID=%%p"
if not defined FP_PID (
  echo [pm-ai-proxy] Cong %PM_ANTHROPIC_PORT% da san sang.
  exit /b 0
)
set /a "FP_TRY+=1"
if !FP_TRY! GTR 5 (
  echo [pm-ai-proxy] CANH BAO: van khong nha duoc cong %PM_ANTHROPIC_PORT% ^(PID !FP_PID!^).
  echo   - Tien trinh giu cong co the chay quyen Administrator: mo lai file nay bang "Run as administrator".
  echo   - Hoac dung cong khac:  set PM_ANTHROPIC_PORT=9000  roi chay lai.
  exit /b 1
)
echo [pm-ai-proxy] Cong %PM_ANTHROPIC_PORT% dang bi PID !FP_PID! giu -^> taskkill ^(lan !FP_TRY!^)...
taskkill /PID !FP_PID! /F /T >nul 2>&1
"%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul 2>&1
goto :fp_loop

REM ------------------------------------------------------------
:help
call :print_usage
exit /b 0

:usage
call :print_usage
exit /b 1

:print_usage
echo.
echo   start-proxy.bat                   harvest + khoi dong proxy (mac dinh)
echo   start-proxy.bat noharvest         khoi dong, bo qua harvest
echo   start-proxy.bat restart           kill cong + DEBUG + khoi dong lai
echo   start-proxy.bat restart nodebug   nhu tren, khong bat DEBUG_PROXY
echo   start-proxy.bat claude [args]     chay Claude Code (tai thu muc du an)
echo.
exit /b 0
