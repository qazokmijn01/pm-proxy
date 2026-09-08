#!/usr/bin/env bash
# ============================================================
#  start-proxy.sh - diem vao DUY NHAT cua pm-ai-proxy (Linux / macOS / Git Bash)
#  Ban song song cua start-proxy.bat cho Windows.
#
#  Cach dung:
#    ./start-proxy.sh                    harvest + khoi dong proxy (mac dinh)
#    ./start-proxy.sh noharvest          khoi dong, bo qua harvest (dung cache)
#    ./start-proxy.sh start [noharvest]  nhu tren, viet ro rang
#    ./start-proxy.sh restart            kill cong + DEBUG_PROXY=1 + khoi dong lai
#    ./start-proxy.sh restart nodebug    nhu tren nhung KHONG bat DEBUG_PROXY
#    ./start-proxy.sh claude [args]      chay Claude Code CLI tro vao proxy
#    ./start-proxy.sh help               in bang nay
#
#  Luu y: 'claude' phai chay o CUA SO KHAC voi proxy (proxy chiem foreground),
#  va chay TAI THU MUC DU AN cua ban - script truyen $PWD qua header
#  x-pm-working-dir (server.mjs: resolveWorkingDir).
#
#  Doi cong:  PM_ANTHROPIC_PORT=9000 ./start-proxy.sh
# ============================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PM_ANTHROPIC_PORT:-8788}"
TOKEN_CACHE="$HOME/.postman-agent-cli/token"
TEMPLATE_FILE="$DIR/src/.chat-template.json"

say() { echo "[pm-ai-proxy] $*"; }

is_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Git Bash: proxy la tien trinh Windows nen header can duong dan kieu Windows.
cwd_for_header() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$PWD"; else printf '%s' "$PWD"; fi
}

usage() {
  cat <<'EOF'

  ./start-proxy.sh                    harvest + khoi dong proxy (mac dinh)
  ./start-proxy.sh noharvest          khoi dong, bo qua harvest
  ./start-proxy.sh restart            kill cong + DEBUG + khoi dong lai
  ./start-proxy.sh restart nodebug    nhu tren, khong bat DEBUG_PROXY
  ./start-proxy.sh claude [args]      chay Claude Code (tai thu muc du an)

EOF
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    say "Node.js san sang: $(node --version)"
    return 0
  fi
  echo
  say "KHONG tim thay Node.js."
  case "$(uname -s)" in
    Darwin) echo "  - macOS:          brew install node" ;;
    Linux)  echo "  - Debian/Ubuntu:  sudo apt install nodejs npm"
            echo "  - Fedora/RHEL:    sudo dnf install nodejs" ;;
    *)      echo "  - Tai tai https://nodejs.org (ban LTS)" ;;
  esac
  echo "  - Hoac dung nvm:  https://github.com/nvm-sh/nvm"
  echo "  (Ban .bat tren Windows tu cai qua winget; tren Linux/macOS viec cai"
  echo "   can quyen sudo nen script KHONG tu dong lam thay ban.)"
  echo
  return 1
}

check_creds() {
  local miss=0
  [ -f "$TOKEN_CACHE" ]    || { say "THIEU token:    $TOKEN_CACHE"; miss=1; }
  [ -f "$TEMPLATE_FILE" ]  || { say "THIEU template: $TEMPLATE_FILE"; miss=1; }
  if [ "$miss" = "1" ]; then
    echo
    say "Proxy can CA HAI file tren. harvest.mjs do cong CDP cua Postman Desktop"
    echo "  bang PowerShell (Get-Process / Get-NetTCPConnection) nen CHI chay tren Windows."
    echo "  Tren Linux/macOS: harvest o mot may Windows co Postman Desktop, roi chep sang:"
    echo "    ~/.postman-agent-cli/token"
    echo "    $TEMPLATE_FILE"
    echo
    return 1
  fi
  return 0
}

do_harvest() {
  if ! is_windows; then
    say "BO QUA harvest: chi chay duoc tren Windows (xem ghi chu ben duoi)."
    return 1
  fi
  say "Harvest token/template tu Postman Desktop (toi da ~30s) ..."
  node "$DIR/src/harvest.mjs" --timeout=30 || {
    echo
    say "CANH BAO: harvest that bai (Postman chua mo hoac chua dang nhap?)."
    echo "  Van thu khoi dong proxy bang token/template da cache tu lan truoc."
    echo
  }
  return 0
}

pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'
  elif is_windows && command -v netstat >/dev/null 2>&1; then
    # Chi dung tren Windows: netstat -ano o day co cot PID cuoi dong.
    # Tren Linux `netstat -ano` KHONG in PID (can -p) nen $NF se la truong timer.
    netstat -ano 2>/dev/null | awk -v p=":$PORT" '$0 ~ p && /LISTEN/ {print $NF}' | sort -u
  fi
}

kill_port() {
  say "Tim tien trinh dang giu cong $PORT ..."
  local pids killed=0 pid
  pids="$(pids_on_port || true)"
  for pid in $pids; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac   # bo qua thu khong phai so
    echo "  -> kill PID $pid"
    if kill -9 "$pid" 2>/dev/null || taskkill //PID "$pid" //F >/dev/null 2>&1; then
      killed=1
    else
      echo "     (KHONG kill duoc PID $pid - co the can quyen cao hon)"
    fi
  done
  if [ "$killed" = "1" ]; then
    say "Da dung instance cu. Cho 1s..."
    sleep 1
  else
    say "Khong co instance nao dang chay."
  fi
}

run_proxy() {
  say "Khoi dong tren cong $PORT ..."
  say "Health: http://127.0.0.1:$PORT/health   (Ctrl+C de dung)"
  echo
  node "$DIR/src/claude-proxy.mjs"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo
    say "LOI: proxy da thoat voi ma loi $rc."
    echo "  - Neu thay \"EADDRINUSE ... :$PORT\" nghia la proxy DA CHAY san tren cong nay."
    echo "    Ban KHONG can chay lai; de dung:      ./start-proxy.sh claude"
    echo "    Muon khoi dong lai sach se:           ./start-proxy.sh restart"
    echo "  - Muon dung cong khac:  PM_ANTHROPIC_PORT=9000 ./start-proxy.sh"
    echo
  fi
  return "$rc"
}

# ------------------------------------------------------------
MODE="${1:-start}"
[ $# -gt 0 ] && shift
if [ "$MODE" = "noharvest" ]; then MODE=start; set -- noharvest ${1+"$@"}; fi
SUB="${1:-}"

case "$MODE" in
  claude)
    export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
    export ANTHROPIC_API_KEY="pm-proxy"
    # Truyen cwd THAT SU cua phien qua header: proxy uu tien x-pm-working-dir.
    # Bat buoc voi client sdk-ts / Agent SDK vi system prompt cua no KHONG co
    # dong "Working directory:" de proxy tu doc.
    # Yeu cau Claude Code >= v2.1.227 (ho tro ANTHROPIC_CUSTOM_HEADERS).
    export ANTHROPIC_CUSTOM_HEADERS="x-pm-working-dir: $(cwd_for_header)"
    if ! command -v claude >/dev/null 2>&1; then
      say "KHONG tim thay lenh 'claude'. Cai Claude Code roi thu lai."
      exit 1
    fi
    exec claude ${1+"$@"}
    ;;

  restart)
    ensure_node || exit 1
    kill_port
    if [ "$SUB" = "nodebug" ]; then
      unset DEBUG_PROXY
      say "DEBUG_PROXY: OFF"
    else
      export DEBUG_PROXY=1
      say "DEBUG_PROXY: ON"
    fi
    check_creds || true
    run_proxy
    ;;

  start)
    ensure_node || exit 1
    if [ "$SUB" = "noharvest" ]; then
      say "Bo qua harvest - dung token/template da cache."
    else
      do_harvest || true
    fi
    check_creds || true
    run_proxy
    ;;

  help|-h|--help|/?)
    usage
    exit 0
    ;;

  *)
    say "Khong hieu lenh \"$MODE\"."
    usage
    exit 1
    ;;
esac
