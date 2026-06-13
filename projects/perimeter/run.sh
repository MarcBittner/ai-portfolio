#!/usr/bin/env bash
# run.sh — dev/ops entrypoint for perimeter (replaces make).
# Production-grade: strict mode, dependency + version checks, --flag options.
set -euo pipefail

# ---- project config ----
PROJECT="perimeter"
PKG="perimeter"
APP="perimeter.api:app"
MIN_PY_MAJOR=3
MIN_PY_MINOR=11
DEFAULT_PORT=8022

cd "$(dirname "$0")"
VENV=".venv"
USE_VENV=1
PORT="${PORT:-$DEFAULT_PORT}"
HOST="${HOST:-127.0.0.1}"
PYTHON="${PYTHON:-python3}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()  { red "error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
$PROJECT — dev/ops script (replaces make)

Usage: ./run.sh <command> [options]

Commands:
  setup       Create a virtualenv and install the project (+ dev deps)
  serve       Run the API + UI (uvicorn, --reload)
  test        Run the test suite
  lint        Run ruff
  check       lint + test
  demo        Run the offline exposure → posture → board-report demo
  eval        Run the reproducible eval → eval-report.md
  smoke       Run the live smoke/regression suite (local server, or --url <deploy>)
  doctor      Report Python / venv / Ollama status
  help        Show this help

Options:
  --port <n>   Port for serve (default $DEFAULT_PORT; or env PORT)
  --host <a>   Host for serve (default 127.0.0.1; or env HOST)
  --url <u>    For 'smoke': target a remote deployment instead of a local server
  --no-venv    Use the current Python env instead of $VENV (CI/containers)
  -h, --help   Show this help

Env:
  PYTHON       Interpreter to use when not in a venv (default python3)
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

check_python() {
  need "$PYTHON"
  local maj min
  read -r maj min < <("$PYTHON" -c 'import sys; print(sys.version_info[0], sys.version_info[1])')
  if (( maj < MIN_PY_MAJOR || (maj == MIN_PY_MAJOR && min < MIN_PY_MINOR) )); then
    die "Python >= ${MIN_PY_MAJOR}.${MIN_PY_MINOR} required, found ${maj}.${min}"
  fi
}

py()   { if (( USE_VENV )); then "$VENV/bin/python" "$@"; else "$PYTHON" "$@"; fi; }
tool() { local t="$1"; shift; if (( USE_VENV )); then "$VENV/bin/$t" "$@"; else "$t" "$@"; fi; }

ensure_installed() {
  if (( USE_VENV )) && [[ ! -x "$VENV/bin/python" ]]; then
    die "not set up — run './run.sh setup' first"
  fi
  py -c "import $PKG" 2>/dev/null || die "'$PKG' not importable — run './run.sh setup'"
}

cmd_doctor() {
  check_python && grn "$PYTHON: $("$PYTHON" --version 2>&1) (>= ${MIN_PY_MAJOR}.${MIN_PY_MINOR} ok)"
  if (( USE_VENV )) && [[ -x "$VENV/bin/python" ]]; then grn "venv: $VENV ready"; else dim "venv: not created (run setup)"; fi
  if command -v ollama >/dev/null 2>&1 || curl -sf -m 1 "${OLLAMA_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
    grn "ollama: reachable (local LLM board narrative available)"
  else
    dim "ollama: not reachable (board narrative falls back to the deterministic template)"
  fi
}

cmd_setup() {
  check_python
  if (( USE_VENV )); then
    [[ -d "$VENV" ]] || "$PYTHON" -m venv "$VENV" || die "venv creation failed (install python3-venv)"
    "$VENV/bin/python" -m pip install --quiet --upgrade pip
    "$VENV/bin/pip" install -e ".[dev]"
  else
    "$PYTHON" -m pip install -e ".[dev]"
  fi
  grn "$PROJECT installed. Next: ./run.sh demo  (offline) or ./run.sh serve"
}

# Run the live smoke suite (tests/test_live_smoke.py) against a real HTTP endpoint.
# No --url: start a local uvicorn, wait for /health, run, tear down.
# --url <deploy>: run the same suite against a remote deployment.
# The suite is gated/parameterised by <PKG>_LIVE / <PKG>_BASE_URL, derived from $PKG.
cmd_smoke() {
  ensure_installed
  local prefix; prefix="$(printf '%s' "$PKG" | tr '[:lower:]' '[:upper:]')"
  local url="${SMOKE_URL:-}" pid="" log="${TMPDIR:-/tmp}/${PROJECT}-smoke.log"
  if [[ -n "$url" ]]; then
    url="${url%/}"; dim "smoke: targeting remote $url"
  else
    url="http://127.0.0.1:$PORT"; dim "smoke: starting local server on :$PORT"
    py -m uvicorn "$APP" --host 127.0.0.1 --port "$PORT" >"$log" 2>&1 &
    pid=$!
    local up=0 i
    for i in $(seq 1 60); do
      if py -c "import urllib.request; urllib.request.urlopen('$url/health', timeout=2)" 2>/dev/null; then up=1; break; fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if (( ! up )); then
      red "server did not become healthy; last log lines:"; tail -n 20 "$log" >&2 || true
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
      die "smoke aborted"
    fi
  fi
  local rc=0
  ( export "${prefix}_LIVE=1" "${prefix}_BASE_URL=$url"
    py -m pytest -q tests/test_live_smoke.py "$@" ) || rc=$?
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  return $rc
}

cmd_serve() { ensure_installed; tool uvicorn "$APP" --host "$HOST" --port "$PORT" --reload; }
cmd_test()  { ensure_installed; py -m pytest -q "$@"; }
cmd_lint()  { ensure_installed; tool ruff check src tests; }
cmd_demo()  { ensure_installed; py -m perimeter.demo; }
cmd_eval()  { ensure_installed; py -m perimeter.evaluate "$@"; }

CMD=""
while (( $# )); do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2;;
    --port=*) PORT="${1#*=}"; shift;;
    --host) HOST="${2:?--host needs a value}"; shift 2;;
    --host=*) HOST="${1#*=}"; shift;;
    --url) SMOKE_URL="${2:?--url needs a value}"; shift 2;;
    --url=*) SMOKE_URL="${1#*=}"; shift;;
    --no-venv) USE_VENV=0; shift;;
    -h|--help) usage; exit 0;;
    setup|serve|test|lint|check|demo|eval|smoke|doctor|help) CMD="$1"; shift;;
    *) die "unknown argument: $1  (run './run.sh --help')";;
  esac
done
[[ -n "$CMD" ]] || { usage; exit 1; }

case "$CMD" in
  setup) cmd_setup;;
  serve) cmd_serve;;
  test)  cmd_test;;
  lint)  cmd_lint;;
  check) cmd_lint; cmd_test;;
  demo)  cmd_demo;;
  eval)  cmd_eval "$@";;
  smoke) cmd_smoke;;
  doctor) cmd_doctor;;
  help)  usage;;
esac
