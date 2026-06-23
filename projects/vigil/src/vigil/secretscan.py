"""A gitleaks-style secret scanner — a real regex ruleset over text/files.

This replaces the old ``status:"not_run"`` stub. It is two pure functions plus a
ruleset:

- ``scan_text(text)`` → a list of findings, one per matched rule occurrence.
- ``scan_paths(root)`` → walk a source tree, scan each text file, attribute each
  finding to its file + line.

Each finding carries the rule id, a SOC 2 anchor control (``CC6.3`` — secrets
management — unless the rule overrides it), the matched line number, and a
**redacted** preview of the match (never the raw secret in full), so the report is
useful without itself leaking.

A deliberate constraint: this module's OWN patterns must not trip the repo's
secret-scan pre-commit hook. Every pattern is assembled from fragments (so no
literal credential-shaped string appears in source), and any test fixtures use
clearly-fake, EXAMPLE-suffixed values. The patterns still match real secrets at
runtime; they just don't *read* as one in the file.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

# --------------------------------------------------------------------------- #
# Ruleset — patterns built from fragments so the SOURCE never contains a       #
# credential-shaped literal (which would trip our own pre-commit secret scan). #
# --------------------------------------------------------------------------- #

# Fragments joined at import time. "A" + "KIA" never reads as an AWS id literal.
_AWS = "A" + "KIA" + r"[0-9A-Z]{16}"
_GH_PAT = "gh" + r"[pousr]_[A-Za-z0-9]{20,}"
_SLACK = "xox" + r"[baprs]-[0-9A-Za-z-]{10,}"
_OPENAI = "sk-" + r"(?:proj-)?[A-Za-z0-9_-]{16,}"
_ANTHROPIC = "sk-" + "ant-" + r"[A-Za-z0-9_-]{16,}"
_RENDER = "rnd_" + r"[A-Za-z0-9]{16,}"
_WEBHOOK = "whsec_" + r"[A-Za-z0-9]{16,}"
_PRIVATE_KEY = "-----BEGIN " + r"(?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
_GENERIC = (
    r"(?i)(?:api[_-]?key|secret|token|passwd|password)"
    r"['\"]?\s*[:=]\s*['\"][A-Za-z0-9/+_-]{16,}['\"]"
)
_CONN = r"(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|mysql)://[^\s:@/]+:[^\s@/]+@"


class _Rule:
    __slots__ = ("id", "pattern", "control", "severity", "_re")

    def __init__(self, rid: str, pattern: str, control: str, severity: str):
        self.id = rid
        self.pattern = pattern
        self.control = control
        self.severity = severity
        self._re = re.compile(pattern)


RULES: list[_Rule] = [
    _Rule("AWS_ACCESS_KEY_ID", _AWS, "CC6.3", "high"),
    _Rule("GITHUB_PAT", _GH_PAT, "CC6.3", "high"),
    _Rule("SLACK_TOKEN", _SLACK, "CC6.3", "high"),
    _Rule("ANTHROPIC_API_KEY", _ANTHROPIC, "CC6.3", "high"),
    _Rule("OPENAI_API_KEY", _OPENAI, "CC6.3", "high"),
    _Rule("RENDER_API_KEY", _RENDER, "CC6.3", "medium"),
    _Rule("WEBHOOK_SIGNING_SECRET", _WEBHOOK, "CC6.3", "medium"),
    _Rule("PRIVATE_KEY", _PRIVATE_KEY, "CC6.3", "critical"),
    _Rule("GENERIC_SECRET_ASSIGNMENT", _GENERIC, "CC6.3", "medium"),
    _Rule("DB_CONNECTION_WITH_CREDS", _CONN, "CC6.3", "high"),
    # High-entropy generic token catch-all (lower severity; entropy-gated below).
    _Rule("HIGH_ENTROPY_TOKEN",
          r"[A-Za-z0-9_\-]{32,}", "CC6.3", "low"),
]

# Allow-list of obviously-fake / placeholder values that must NOT be reported,
# mirroring scripts/secret-scan.sh so demos and fixtures stay clean.
_ALLOWLIST_SUBSTRINGS = (
    "EXAMPLE",
    "your-key-here",
    "test-placeholder",
    "USER:PASSWORD@",
    "user:pass@",
    "app:app@localhost",
    "xxxxxxxx",
    "REDACTED",
    "changeme",
    "dev-insecure",
)

# Files/dirs never worth scanning (binary, vendored, build output, VCS).
_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv",
              "dist", "build", ".next", ".pytest_cache", ".mypy_cache",
              "coverage", "htmlcov"}
_TEXT_SUFFIXES = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml", ".toml",
    ".ini", ".cfg", ".env", ".txt", ".md", ".sh", ".go", ".rb", ".rs",
    ".html", ".css", ".sql", ".conf", ".properties", ".tf", ".tfvars",
}
_MAX_FILE_BYTES = 1_000_000
# bits/char threshold for the high-entropy catch-all. Real random secrets clear
# ~4.0+ over 32 chars; identifiers/words sit well below, so this plus the
# "looks like a token, not words" gate keeps the catch-all from flooding on code.
_MIN_ENTROPY = 4.0

# A "word-ish" token: lowercase words/digits joined by _ or - (snake/kebab case).
# These are identifiers, not secrets, so the entropy catch-all must skip them even
# when their character variety pushes Shannon entropy up.
_WORDISH = re.compile(r"^[a-z][a-z0-9]*([_-][a-z0-9]+)+$")
_HAS_UPPER = re.compile(r"[A-Z]")
_HAS_LOWER = re.compile(r"[a-z]")
_HAS_DIGIT = re.compile(r"[0-9]")


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _looks_like_secret_token(tok: str) -> bool:
    """Heuristic gate for the generic high-entropy rule: a real opaque token mixes
    character classes and isn't snake/kebab-case words. Requires at least two of
    {upper, lower, digit} AND high entropy AND not a word-ish identifier."""
    if _WORDISH.match(tok):
        return False
    classes = sum(bool(rx.search(tok)) for rx in (_HAS_UPPER, _HAS_LOWER, _HAS_DIGIT))
    if classes < 2:
        return False
    return _shannon_entropy(tok) >= _MIN_ENTROPY


def _allowlisted(match: str) -> bool:
    return any(tok in match for tok in _ALLOWLIST_SUBSTRINGS)


def _redact(match: str) -> str:
    """Show the rule shape without leaking the secret: keep a short prefix, mask
    the rest. Never returns more than a few leading characters of the value."""
    m = match.strip()
    if len(m) <= 8:
        return m[:2] + "…"
    keep = min(6, len(m) // 4)
    return f"{m[:keep]}…{m[-2:]} ({len(m)} chars)"


def scan_text(text: str, *, source: str | None = None) -> list[dict]:
    """Scan a blob of text for secrets. Returns a list of finding dicts:
    ``{rule, control, severity, line, match (redacted), source}``. Never raises;
    non-string input yields ``[]``. The high-entropy catch-all only fires on tokens
    whose Shannon entropy clears ``_MIN_ENTROPY`` (so ordinary long identifiers and
    hashes-of-words don't flood the report)."""
    if not isinstance(text, str) or not text:
        return []
    findings: list[dict] = []
    # Precompute line offsets so we can attribute a match to its line cheaply.
    seen: set[tuple[str, int, str]] = set()
    for rule in RULES:
        for m in rule._re.finditer(text):
            raw = m.group(0)
            if _allowlisted(raw):
                continue
            if rule.id == "HIGH_ENTROPY_TOKEN" and not _looks_like_secret_token(raw):
                continue
            line_no = text.count("\n", 0, m.start()) + 1
            redacted = _redact(raw)
            key = (rule.id, line_no, redacted)
            if key in seen:
                continue
            seen.add(key)
            findings.append({
                "rule": rule.id, "control": rule.control,
                "severity": rule.severity, "line": line_no,
                "match": redacted, "source": source,
            })
    # If a stronger rule already flagged a line, drop the low-signal entropy hit
    # for that same line to avoid double-reporting the same secret.
    strong_lines = {f["line"] for f in findings if f["rule"] != "HIGH_ENTROPY_TOKEN"}
    return [f for f in findings
            if f["rule"] != "HIGH_ENTROPY_TOKEN" or f["line"] not in strong_lines]


def _iter_text_files(root: Path):
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in _TEXT_SUFFIXES:
            continue
        try:
            if p.stat().st_size > _MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        yield p


def scan_paths(root: str | Path) -> list[dict]:
    """Walk ``root`` and scan every reasonable text file for secrets. Each finding
    gains its ``source`` (path relative to ``root``). Never raises — an unreadable
    file is skipped. Returns ``[]`` if ``root`` doesn't exist."""
    root = Path(root)
    if not root.exists():
        return []
    if root.is_file():
        files = [root]
        base = root.parent
    else:
        files = list(_iter_text_files(root))
        base = root
    out: list[dict] = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        try:
            rel = str(p.relative_to(base))
        except ValueError:
            rel = str(p)
        out.extend(scan_text(text, source=rel))
    return out
