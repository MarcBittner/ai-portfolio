#!/usr/bin/env bash
# run.sh — dev/ops entrypoint for persona-twin (replaces make).
# Production-grade: strict mode, dependency + version checks, --flag options.
set -euo pipefail

# ---- project config ----
PROJECT="persona-twin"
PKG="persona_twin"
APP="persona_twin.api.app:app"
MIN_PY_MAJOR=3
MIN_PY_MINOR=11
DEFAULT_PORT=8000

cd "$(dirname "$0")"
VENV=".venv"
USE_VENV=1
PORT="${PORT:-$DEFAULT_PORT}"
HOST="${HOST:-127.0.0.1}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()  { red "error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
$PROJECT — dev/ops script (replaces make)

Usage: ./run.sh <command> [options]

Commands:
  setup            Create a virtualenv and install the project (+ dev deps)
  serve            Run the API (uvicorn, --reload) on :$DEFAULT_PORT
  test             Run the test suite
  lint             Run ruff
  check            lint + test
  demo             Ingest the synthetic corpus and query the twins (offline)
  eval             Regenerate eval-report.md (retrieval metrics)
  frontend         Install + run the Vite dev server (needs 'serve' running)
  frontend-build   Install, build, and typecheck the frontend
  docker           Build the container image
  doctor           Report Python / Node / venv / Ollama status
  help             Show this help

Options:
  --port <n>   Port for serve (default $DEFAULT_PORT; or env PORT)
  --host <a>   Host for serve (default 127.0.0.1; or env HOST)
  --no-venv    Use the current Python env instead of $VENV (CI/containers)
  -h, --help   Show this help
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

PYBIN="${PYTHON:-python3}"
check_python() {
  need "$PYBIN"
  local maj min
  read -r maj min < <("$PYBIN" -c 'import sys; print(sys.version_info[0], sys.version_info[1])')
  if (( maj < MIN_PY_MAJOR || (maj == MIN_PY_MAJOR && min < MIN_PY_MINOR) )); then
    die "Python >= ${MIN_PY_MAJOR}.${MIN_PY_MINOR} required, found ${maj}.${min}"
  fi
}

py()   { if (( USE_VENV )); then "$VENV/bin/python" "$@"; else "$PYBIN" "$@"; fi; }
tool() { local t="$1"; shift; if (( USE_VENV )); then "$VENV/bin/$t" "$@"; else "$t" "$@"; fi; }

ensure_installed() {
  if (( USE_VENV )) && [[ ! -x "$VENV/bin/python" ]]; then
    die "not set up — run './run.sh setup' first"
  fi
  py -c "import $PKG" 2>/dev/null || die "'$PKG' not importable — run './run.sh setup'"
}

cmd_doctor() {
  check_python && grn "python: $("$PYBIN" --version 2>&1) (>= ${MIN_PY_MAJOR}.${MIN_PY_MINOR} ok, via \$PYBIN=$PYBIN)"
  if command -v node >/dev/null 2>&1; then grn "node: $(node --version) (frontend ok)"; else dim "node: not found (frontend targets unavailable)"; fi
  if (( USE_VENV )) && [[ -x "$VENV/bin/python" ]]; then grn "venv: $VENV ready"; else dim "venv: not created (run setup)"; fi
  if curl -sf -m 1 "${OLLAMA_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
    grn "ollama: reachable (semantic embeddings / generation available)"
  else
    dim "ollama: not reachable (falls back to offline hashing/stub providers)"
  fi
}

cmd_setup() {
  check_python
  if (( USE_VENV )); then
    [[ -d "$VENV" ]] || "$PYBIN" -m venv "$VENV" || die "venv creation failed (install python3-venv)"
    "$VENV/bin/python" -m pip install --quiet --upgrade pip
    "$VENV/bin/pip" install -e ".[dev]"
  else
    "$PYBIN" -m pip install -e ".[dev]"
  fi
  grn "$PROJECT installed. Next: ./run.sh demo  (offline) or ./run.sh serve"
}

cmd_serve() { ensure_installed; py -m uvicorn "$APP" --host "$HOST" --port "$PORT" --reload; }
cmd_test()  { ensure_installed; py -m pytest -q "$@"; }
cmd_lint()  { ensure_installed; tool ruff check src tests; }
cmd_demo()  { ensure_installed; py -m persona_twin.demo; }
cmd_eval()  { ensure_installed; py -m persona_twin.eval.run; }

cmd_frontend() {
  need npm
  cd frontend && npm install && npm run dev
}
cmd_frontend_build() {
  need npm
  cd frontend && npm install && npm run build && npm run typecheck
}
cmd_docker() {
  need docker
  docker build -t persona-twin .
}

CMD=""
while (( $# )); do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2;;
    --port=*) PORT="${1#*=}"; shift;;
    --host) HOST="${2:?--host needs a value}"; shift 2;;
    --host=*) HOST="${1#*=}"; shift;;
    --no-venv) USE_VENV=0; shift;;
    -h|--help) usage; exit 0;;
    setup|serve|test|lint|check|demo|eval|frontend|frontend-build|docker|doctor|help)
      CMD="$1"; shift;;
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
  eval)  cmd_eval;;
  frontend) cmd_frontend;;
  frontend-build) cmd_frontend_build;;
  docker) cmd_docker;;
  doctor) cmd_doctor;;
  help)  usage;;
esac
