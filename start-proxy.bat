@echo off
setlocal
REM Khoi dong pm-ai-proxy (server tuong thich Anthropic -> Postman gateway).
REM Tu dong HARVEST token/template tu Postman Desktop truoc khi khoi dong proxy.
REM Yeu cau: Postman Desktop dang mo (de harvest). Bo qua buoc harvest: start-proxy.bat noharvest
if "%PM_ANTHROPIC_PORT%"=="" set PM_ANTHROPIC_PORT=8788

REM ===== Bao dam co Node.js (tu dong cai neu chua co) =====
where node >nul 2>&1 && goto :havenode
echo [pm-ai-proxy] Khong tim thay Node.js - dang thu cai tu dong...
where winget >nul 2>&1 || goto :nodefail
echo [pm-ai-proxy] Cai Node.js LTS qua winget (co the hien cua so UAC)...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
where node >nul 2>&1 && goto :havenode
REM Installer khong cap nhat PATH cho cmd dang mo -> them thu cong cho phien nay
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>&1 && goto :havenode
:nodefail
echo.
echo [pm-ai-proxy] KHONG THE tu dong cai Node.js.
echo   - Cai thu cong tai https://nodejs.org (ban LTS, Windows x64) roi mo lai file nay.
echo   - Hoac cai "App Installer" (winget) tu Microsoft Store roi mo lai.
echo.
pause
exit /b 1
:havenode
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
echo [pm-ai-proxy] Node.js san sang: %NODEVER%

if /i "%~1"=="noharvest" (
  echo [pm-ai-proxy] Bo qua harvest - dung token/template da cache.
  goto :startproxy
)
echo [pm-ai-proxy] Harvest token/template tu Postman Desktop ^(toi da ~30s^) ...
node "%~dp0harvest.mjs" --timeout=30
if errorlevel 1 (
  echo.
  echo [pm-ai-proxy] CANH BAO: harvest that bai ^(Postman chua mo hoac chua dang nhap?^).
  echo   Van thu khoi dong proxy bang token/template da cache tu lan truoc.
  echo.
)

:startproxy
echo [pm-ai-proxy] Khoi dong tren cong %PM_ANTHROPIC_PORT% ...
node "%~dp0claude-proxy.mjs"
if errorlevel 1 (
  echo.
  echo [pm-ai-proxy] LOI: proxy da thoat voi ma loi %errorlevel%.
  echo   - Neu thay "EADDRINUSE ... :%PM_ANTHROPIC_PORT%" nghia la proxy DA CHAY san tren cong nay.
  echo     Ban KHONG can chay lai; chi can mo claude-pm.bat de dung.
  echo   - Muon dung cong khac:  set PM_ANTHROPIC_PORT=9000  roi chay lai file nay.
  echo.
  pause
)
