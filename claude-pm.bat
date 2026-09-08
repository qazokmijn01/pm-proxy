@echo off
setlocal
REM Chay Claude Code CLI, tro thang vao pm-ai-proxy (dung credit Postman lam model).
REM Proxy phai dang chay (start-proxy.bat) trong mot cua so khac.
REM Vi du:  claude-pm.bat            (mo phien tuong tac)
REM         claude-pm.bat -p "doc package.json"   (mot lenh headless)
if "%PM_ANTHROPIC_PORT%"=="" set PM_ANTHROPIC_PORT=8788
set ANTHROPIC_BASE_URL=http://127.0.0.1:%PM_ANTHROPIC_PORT%
set ANTHROPIC_API_KEY=pm-proxy
REM Truyen cwd THAT SU cua phien qua header: proxy uu tien x-pm-working-dir (server.mjs: resolveWorkingDir).
REM %CD% = thu muc dang dung khi chay file nay. Bat buoc voi client sdk-ts / Agent SDK vi system
REM prompt cua no KHONG co dong "Working directory:" de proxy tu doc.
REM Yeu cau Claude Code >= v2.1.227 (ho tro ANTHROPIC_CUSTOM_HEADERS).
set ANTHROPIC_CUSTOM_HEADERS=x-pm-working-dir: %CD%
claude %*
