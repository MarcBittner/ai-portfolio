#!/usr/bin/env bash
# run.sh — dev/ops entrypoint for cycleledger (replaces make).
# Strict mode, dependency checks, --flag options. Mirrors the portfolio standard.
set -euo pipefail

PROJECT="cycleledger"
DEFAULT_PORT=8080
DEFAULT_DB_URL="postgresql://app:app@localhost:5432/cycleledger_development"

cd "$(dirname "$0")"
PORT="${PORT:-$DEFAULT_PORT}"
HOST="${HOST:-127.0.0.1}"
# Honor a caller-provided DATABASE_URL; otherwise default to the local cluster.
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DB_URL}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
die() { red "error: $*" >&2; exit 1; }

# Allow $RUBY / $BUNDLE override (parity with the portfolio's $PYTHON pattern).
BUNDLE="${BUNDLE:-bundle}"

usage() {
  cat <<EOF
$PROJECT — dev/ops script (replaces make)

Usage: ./run.sh <command> [options]

Commands:
  setup    bundle install + db:prepare (create/migrate/structure) + db:seed
  serve    Run the API (puma) on \$PORT
  test     Run the minitest suite (against cycleledger_test)
  lint     rubocop if .rubocop.yml is present, else 'ruby -c' over app/ lib/
  demo     End-to-end offline demo: rollups -> plan -> NL->SQL -> guard reject
  doctor   Report ruby / postgres / redis / LLM status
  help     Show this help

Options:
  --port <n>  Port for serve (default $DEFAULT_PORT; or env PORT)
  --host <a>  Host for serve (default 127.0.0.1; or env HOST)
  -h, --help  Show this help

Env:
  DATABASE_URL  Postgres connection (default $DEFAULT_DB_URL)
  RUBY/BUNDLE   Override the ruby / bundle binaries
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

# The test DB mirrors DATABASE_URL with the _test database name.
test_db_url() { printf '%s' "$DATABASE_URL" | sed -E 's/(_development|_production)?(\?|$)/_test\2/'; }

cmd_setup() {
  need ruby
  $BUNDLE install
  grn "gems installed; preparing database at $DATABASE_URL"
  $BUNDLE exec rails db:prepare
  $BUNDLE exec rails db:seed
  grn "$PROJECT ready. Next: ./run.sh demo  (offline) or ./run.sh serve"
}

cmd_serve() {
  grn "serving on http://$HOST:$PORT (DATABASE_URL=$DATABASE_URL)"
  $BUNDLE exec puma -e "${RAILS_ENV:-development}" -b "tcp://$HOST:$PORT"
}

cmd_test() {
  local tdb; tdb="$(test_db_url)"
  dim "test DB: $tdb"
  RAILS_ENV=test DATABASE_URL="$tdb" $BUNDLE exec rails db:prepare >/dev/null
  RAILS_ENV=test DATABASE_URL="$tdb" $BUNDLE exec rails test "$@"
}

cmd_lint() {
  if [[ -f .rubocop.yml ]]; then
    $BUNDLE exec rubocop app lib db config
  else
    dim "no .rubocop.yml — syntax-checking with 'ruby -c'"
    local rc=0
    while IFS= read -r f; do
      ruby -c "$f" >/dev/null || { red "syntax error: $f"; rc=1; }
    done < <(find app lib db config -name '*.rb' 2>/dev/null)
    (( rc == 0 )) && grn "ruby -c: all files OK"
    return $rc
  fi
}

cmd_demo() { $BUNDLE exec rails demo; }

cmd_doctor() {
  need ruby; grn "ruby: $(ruby --version)"
  $BUNDLE exec rails --version 2>/dev/null | sed 's/^/rails: /' || dim "rails: run ./run.sh setup"
  if command -v psql >/dev/null 2>&1 && psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    grn "postgres: reachable ($DATABASE_URL)"
  else
    dim "postgres: not reachable at $DATABASE_URL"
  fi
  if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
    grn "redis: reachable (Sidekiq adapter available)"
  else
    dim "redis: not reachable (jobs run :inline)"
  fi
  for k in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY; do
    [[ -n "${!k:-}" ]] && grn "$k: set" || dim "$k: unset"
  done
}

CMD=""
while (( $# )); do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2;;
    --port=*) PORT="${1#*=}"; shift;;
    --host) HOST="${2:?--host needs a value}"; shift 2;;
    --host=*) HOST="${1#*=}"; shift;;
    -h|--help) usage; exit 0;;
    setup|serve|test|lint|demo|doctor|help) CMD="$1"; shift;;
    *) die "unknown argument: $1  (run './run.sh --help')";;
  esac
done
[[ -n "$CMD" ]] || { usage; exit 1; }

case "$CMD" in
  setup) cmd_setup;;
  serve) cmd_serve;;
  test)  cmd_test "$@";;
  lint)  cmd_lint;;
  demo)  cmd_demo;;
  doctor) cmd_doctor;;
  help)  usage;;
esac
