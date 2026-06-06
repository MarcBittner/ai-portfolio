#!/usr/bin/env bash
# Scan the staged diff for secret-shaped strings. Exit 1 on a hit.
# Usage: scripts/secret-scan.sh   (run before every commit; also usable
# as .git/hooks/pre-commit — see README)
set -euo pipefail

# Added lines only
diff_added() { git diff --cached --no-color | grep '^+' | grep -v '^+++' || true; }

PATTERNS=(
  'sk-ant-[a-zA-Z0-9_-]{16,}'                 # Anthropic keys
  'sk-(proj-)?[a-zA-Z0-9_-]{20,}'             # OpenAI keys
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  'ghp_[a-zA-Z0-9]{20,}'                      # GitHub PAT
  'gho_[a-zA-Z0-9]{20,}'
  'xox[bpars]-[a-zA-Z0-9-]{10,}'              # Slack tokens
  'whsec_[a-zA-Z0-9]{16,}'                    # webhook signing keys
  '-----BEGIN( RSA| EC| OPENSSH)? PRIVATE KEY' # private key blocks
  'mongodb(\+srv)?://[a-zA-Z0-9._%-]+:[^@/ ]+@' # connection string w/ creds
  'redis://[a-zA-Z0-9._%-]+:[^@/ ]+@'
  'postgres(ql)?://[a-zA-Z0-9._%-]+:[^@/ ]+@'
)

# Placeholder values that are allowed to look credential-shaped
ALLOWLIST=(
  'USER:PASSWORD@'
  'user:pass@'
  'sk-ant-your-key-here'
  'sk-your-key-here'
  'test-placeholder'
)

hits=""
for pat in "${PATTERNS[@]}"; do
  matches=$(diff_added | grep -nE -e "$pat" || true)
  [ -z "$matches" ] && continue
  while IFS= read -r line; do
    allowed=0
    for ok in "${ALLOWLIST[@]}"; do
      if [[ "$line" == *"$ok"* ]]; then allowed=1; break; fi
    done
    [ "$allowed" -eq 0 ] && hits+="[$pat] $line"$'\n'
  done <<<"$matches"
done

if [ -n "$hits" ]; then
  echo "✗ SECRET-SHAPED STRINGS IN STAGED DIFF — commit blocked:" >&2
  printf '%s' "$hits" >&2
  exit 1
fi
echo "✔ secret scan clean"
