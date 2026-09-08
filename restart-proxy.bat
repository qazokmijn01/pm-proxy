@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  restart-proxy.bat â€?Restart pm-ai-proxy (Claude CLI proxy)
REM  - Tu tim & kill tien trinh dang giu cong (mac dinh 8788)
REM  - Bat DEBUG_PROXY=1 de xem thinkingChunk / emit / drop
REM  - Khoi dong lai proxy (chay foreground, xem log truc tiep)
REM
REM  Cach dung:
REM    restart-proxy.bat            :: DEBUG bat (mac dinh)
REM    restart-proxy.bat nodebug    :: tat DEBUG_PROXY
REM ============================================================

if "%PM_ANTHROPIC_PORT%"=="" set PM_ANTHROPIC_PORT=8788

echo [pm-ai-proxy] Tim tien trinh dang giu cong %PM_ANTHROPIC_PORT% ...
set "KILLED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PM_ANTHROPIC_PORT% ^| findstr LISTENING') do (
  echo   -^> taskkill PID %%p
  taskkill /PID %%p /F >nul 2>&1
  set "KILLED=1"
)
if defined KILLED (
  echo [pm-ai-proxy] Da dung instance cu. Cho 1s...
  timeout /t 1 /nobreak >nul
) else (
  echo [pm-ai-proxy] Khong co instance nao dang chay.
)

REM Bat/tat log debug
if /i "%~1"=="nodebug" (
  set "DEBUG_PROXY="
  echo [pm-ai-proxy] DEBUG_PROXY: OFF
) else (
  set DEBUG_PROXY=1
  echo [pm-ai-proxy] DEBUG_PROXY: ON
)

echo [pm-ai-proxy] Khoi dong lai tren cong %PM_ANTHROPIC_PORT% ...
echo [pm-ai-proxy] Health: http://127.0.0.1:%PM_ANTHROPIC_PORT%/health   (Ctrl+C de dung)
echo.
node "%~dp0..\claude-proxy.mjs"
