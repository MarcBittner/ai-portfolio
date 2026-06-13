#!/usr/bin/env bash
# run.sh — dev/ops entrypoint for relaytoken (Go).
# Strict mode, toolchain checks, --flag options. Replaces make.
set -euo pipefail

PROJECT="relaytoken"
MIN_GO_MAJOR=1
MIN_GO_MINOR=23
DEFAULT_PORT=8080
MAIN_PKG="./cmd/relaytoken"
BIN="bin/relaytoken"

cd "$(dirname "$0")"
PORT="${PORT:-$DEFAULT_PORT}"
HOST="${HOST:-127.0.0.1}"

# Make a freshly-installed Go on /usr/local/go discoverable without the caller
# having to export PATH first. Honor a $GO override too.
if ! command -v go >/dev/null 2>&1 && [[ -x /usr/local/go/bin/go ]]; then
  export PATH="$PATH:/usr/local/go/bin"
fi
GO="${GO:-go}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
die() { red "error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
$PROJECT — dev/ops script (replaces make)

Usage: ./run.sh <command> [options]

Commands:
  setup     Download modules (go mod download)
  build     Compile the binary to $BIN
  test      Run the test suite (go test ./...)
  lint      go vet ./... + gofmt -l check
  check     lint + test
  run       Build and run the HTTP service on \$PORT
  demo      Offline CLI walkthrough: mint -> verify -> adversary 8/8 -> grant lint -> threat model
  doctor    Report Go toolchain status
  help      Show this help

Options:
  --port <n>   Port for run (default $DEFAULT_PORT; or env PORT)
  --host <a>   Host for run (default 127.0.0.1; or env HOST)
  -h, --help   Show this help
EOF
}

need_go() {
  command -v "$GO" >/dev/null 2>&1 || die "'go' is required but not found (install Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ or set \$GO / add /usr/local/go/bin to PATH)"
  local ver maj min
  ver="$("$GO" env GOVERSION 2>/dev/null | sed 's/^go//')"
  maj="${ver%%.*}"; min="${ver#*.}"; min="${min%%.*}"
  if (( maj < MIN_GO_MAJOR || (maj == MIN_GO_MAJOR && min < MIN_GO_MINOR) )); then
    die "Go >= ${MIN_GO_MAJOR}.${MIN_GO_MINOR} required, found ${ver}"
  fi
}

cmd_doctor() { need_go && grn "go: $("$GO" version) (>= ${MIN_GO_MAJOR}.${MIN_GO_MINOR} ok)"; }
cmd_setup()  { need_go; "$GO" mod download && grn "modules downloaded. Next: ./run.sh demo"; }
cmd_build()  { need_go; mkdir -p bin; "$GO" build -o "$BIN" "$MAIN_PKG" && grn "built $BIN"; }
cmd_test()   { need_go; "$GO" test ./... "$@"; }

cmd_lint() {
  need_go
  "$GO" vet ./...
  local unformatted; unformatted="$(gofmt -l . 2>/dev/null || true)"
  if [[ -n "$unformatted" ]]; then
    red "gofmt found unformatted files:"; printf '%s\n' "$unformatted"; exit 1
  fi
  grn "lint clean (go vet + gofmt)"
}

cmd_run()  { cmd_build; PORT="$PORT" "$BIN"; }
cmd_demo() { need_go; "$GO" run "$MAIN_PKG" demo; }

CMD=""
while (( $# )); do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2;;
    --port=*) PORT="${1#*=}"; shift;;
    --host) HOST="${2:?--host needs a value}"; shift 2;;
    --host=*) HOST="${1#*=}"; shift;;
    -h|--help) usage; exit 0;;
    setup|build|test|lint|check|run|demo|doctor|help) CMD="$1"; shift;;
    *) die "unknown argument: $1  (run './run.sh --help')";;
  esac
done
[[ -n "$CMD" ]] || { usage; exit 1; }

case "$CMD" in
  setup)  cmd_setup;;
  build)  cmd_build;;
  test)   cmd_test "$@";;
  lint)   cmd_lint;;
  check)  cmd_lint; cmd_test "$@";;
  run)    cmd_run;;
  demo)   cmd_demo;;
  doctor) cmd_doctor;;
  help)   usage;;
esac
