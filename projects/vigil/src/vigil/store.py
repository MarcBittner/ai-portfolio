"""SQLite persistence: targets, the probe time series, users, and alert rules.

One small, dependency-free data layer. SQLite is the portfolio's standard for
stateful demos (rate-atlas, txn-ledger, arbiter) — a single file, zero external
service, fine for a single-instance monitor. Every table is created on import so a
fresh deploy is self-seeding; the seed registry from ``config`` is upserted on
first run, then runtime additions (admin API / targets.json) merge over it.

State that matters here:
- ``targets`` — the monitored-app registry (seed + runtime additions).
- ``probes`` — the up/down/latency/status time series (self-pruning).
- ``users`` — auth identities, roles, email-verification tokens.
- ``alert_rules`` — per-app threshold→channel alerting config.
- ``alert_events`` — a log of fired alerts (so the dashboard can show history).

Connections are created per-call with ``check_same_thread=False`` so the async
poller and the request handlers can share the file safely (WAL mode + short-lived
connections; SQLite serializes writers).
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager

from vigil import config
from vigil.config import Target

_SCHEMA = """
CREATE TABLE IF NOT EXISTS targets (
    slug         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    health_path  TEXT NOT NULL DEFAULT '/health',
    repo         TEXT,
    self_monitor INTEGER NOT NULL DEFAULT 0,
    tags         TEXT NOT NULL DEFAULT '[]',
    metrics_path TEXT,
    created_at   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS probes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT NOT NULL,
    ts           REAL NOT NULL,
    up           INTEGER NOT NULL,
    http_status  INTEGER,
    response_ms  REAL,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_probes_slug_ts ON probes(slug, ts DESC);
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    role          TEXT NOT NULL DEFAULT 'registered',
    verified      INTEGER NOT NULL DEFAULT 0,
    verify_token  TEXT,
    oauth_provider TEXT,
    created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL,
    metric     TEXT NOT NULL,          -- availability | error_rate | response_ms | down
    comparator TEXT NOT NULL,          -- lt | gt
    threshold  REAL NOT NULL,
    channel    TEXT NOT NULL,          -- console | email | sms | webhook
    target_addr TEXT,                  -- email/phone/url for the channel
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id    INTEGER,
    slug       TEXT NOT NULL,
    ts         REAL NOT NULL,
    channel    TEXT NOT NULL,
    message    TEXT NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,            -- FK -> targets.slug
    name        TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT 'GET',
    path        TEXT NOT NULL,            -- appended to target.url
    headers     TEXT NOT NULL DEFAULT '{}',   -- JSON object
    body        TEXT,                     -- request body (nullable)
    assertions  TEXT NOT NULL DEFAULT '[]',   -- JSON list of assertion dicts
    required    INTEGER NOT NULL DEFAULT 1,    -- does this check gate "up"?
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_slug ON checks(slug);
CREATE TABLE IF NOT EXISTS check_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    INTEGER NOT NULL,
    slug        TEXT NOT NULL,
    ts          REAL NOT NULL,
    passed      INTEGER NOT NULL,
    http_status INTEGER,
    response_ms REAL,
    error       TEXT,
    detail      TEXT                      -- JSON: per-assertion results + snippet
);
CREATE INDEX IF NOT EXISTS idx_check_results_cid_ts ON check_results(check_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_check_results_slug_ts ON check_results(slug, ts DESC);
CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    slug    TEXT NOT NULL,                 -- target slug ('vigil' for self logs)
    ts      REAL NOT NULL,
    level   TEXT NOT NULL DEFAULT 'info',  -- debug | info | warn | error
    source  TEXT,                          -- emitting component (nullable)
    message TEXT NOT NULL,
    meta    TEXT                           -- JSON object of structured fields
);
CREATE INDEX IF NOT EXISTS idx_logs_slug_ts ON logs(slug, ts DESC);
CREATE TABLE IF NOT EXISTS metric_samples (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug   TEXT NOT NULL,
    ts     REAL NOT NULL,
    name   TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '{}',     -- JSON object of label k/v
    value  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_samples_slug_name_ts
    ON metric_samples(slug, name, ts DESC);
CREATE TABLE IF NOT EXISTS quality (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL,
    commit_sha    TEXT,
    ts            REAL NOT NULL,
    lint_errors   INTEGER NOT NULL DEFAULT 0,
    tests_passed  INTEGER NOT NULL DEFAULT 0,
    tests_failed  INTEGER NOT NULL DEFAULT 0,
    coverage_pct  REAL,
    complexity    REAL,
    grade         TEXT NOT NULL,
    raw           TEXT                          -- JSON blob of the original payload
);
CREATE INDEX IF NOT EXISTS idx_quality_slug_ts ON quality(slug, ts DESC);
CREATE TABLE IF NOT EXISTS pushes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    commit_sha  TEXT,
    ts          REAL NOT NULL,
    pusher      TEXT,
    message     TEXT,
    scan        TEXT                            -- JSON: per-push live scan result
);
CREATE INDEX IF NOT EXISTS idx_pushes_slug_ts ON pushes(slug, ts DESC);
CREATE TABLE IF NOT EXISTS repo_scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    commit_sha  TEXT,
    ts          REAL NOT NULL,
    findings    TEXT NOT NULL DEFAULT '[]'      -- JSON list of secretscan findings
);
CREATE INDEX IF NOT EXISTS idx_repo_scans_slug_ts ON repo_scans(slug, ts DESC);
"""

# Levels the logs API accepts; anything else is coerced to 'info' on ingest.
LOG_LEVELS = ("debug", "info", "warn", "error")


@contextmanager
def _conn():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=10)
    c.row_factory = sqlite3.Row
    try:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=5000")
        yield c
        c.commit()
    finally:
        c.close()


def init_db() -> None:
    """Create tables and upsert the seed + file registry. Idempotent."""
    with _conn() as c:
        c.executescript(_SCHEMA)
        _migrate(c)
    seed_targets(config.SEED_TARGETS + config.load_file_targets())
    seed_default_checks()


def _migrate(c: sqlite3.Connection) -> None:
    """Add columns introduced after the first schema so an existing DB file (e.g. a
    persistent disk that predates the metrics scrape) gains them without a wipe.
    ``ADD COLUMN`` is a no-op-on-conflict pattern guarded by a column probe."""
    cols = {r["name"] for r in c.execute("PRAGMA table_info(targets)").fetchall()}
    if "metrics_path" not in cols:
        c.execute("ALTER TABLE targets ADD COLUMN metrics_path TEXT")


# --------------------------------------------------------------------------- #
# Targets                                                                       #
# --------------------------------------------------------------------------- #

def seed_targets(targets: list[Target]) -> None:
    now = time.time()
    with _conn() as c:
        for t in targets:
            c.execute(
                """INSERT INTO targets (slug, name, url, health_path, repo,
                       self_monitor, tags, metrics_path, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(slug) DO UPDATE SET
                       name=excluded.name, url=excluded.url,
                       health_path=excluded.health_path, repo=excluded.repo,
                       self_monitor=excluded.self_monitor, tags=excluded.tags,
                       metrics_path=excluded.metrics_path""",
                (t.slug, t.name, t.url, t.health_path, t.repo,
                 int(t.self_monitor), json.dumps(t.tags), t.metrics_path, now),
            )


def add_target(t: Target) -> None:
    seed_targets([t])


def remove_target(slug: str) -> bool:
    with _conn() as c:
        cur = c.execute("DELETE FROM targets WHERE slug=?", (slug,))
        return cur.rowcount > 0


def _row_to_target(r: sqlite3.Row) -> Target:
    cols = r.keys()
    return Target(
        slug=r["slug"], name=r["name"], url=r["url"],
        health_path=r["health_path"], repo=r["repo"],
        self_monitor=bool(r["self_monitor"]), tags=json.loads(r["tags"]),
        metrics_path=(r["metrics_path"] if "metrics_path" in cols else None),
    )


def list_targets() -> list[Target]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM targets ORDER BY self_monitor DESC, slug"
        ).fetchall()
    return [_row_to_target(r) for r in rows]


def get_target(slug: str) -> Target | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM targets WHERE slug=?", (slug,)).fetchone()
    return _row_to_target(r) if r else None


# --------------------------------------------------------------------------- #
# Probes (time series)                                                          #
# --------------------------------------------------------------------------- #

def record_probe(slug: str, up: bool, http_status: int | None,
                 response_ms: float | None, error: str | None) -> None:
    with _conn() as c:
        c.execute(
            """INSERT INTO probes (slug, ts, up, http_status, response_ms, error)
               VALUES (?,?,?,?,?,?)""",
            (slug, time.time(), int(up), http_status, response_ms, error),
        )
        # Self-prune: keep only the most recent MAX_HISTORY_PER_TARGET rows.
        c.execute(
            """DELETE FROM probes WHERE slug=? AND id NOT IN (
                   SELECT id FROM probes WHERE slug=? ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_HISTORY_PER_TARGET),
        )


def recent_probes(slug: str, limit: int = 100) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM probes WHERE slug=? ORDER BY ts DESC LIMIT ?",
            (slug, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def last_probe(slug: str) -> dict | None:
    rows = recent_probes(slug, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Synthetic checks + their results                                              #
# --------------------------------------------------------------------------- #

def _row_to_check(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["headers"] = json.loads(d.get("headers") or "{}")
    d["assertions"] = json.loads(d.get("assertions") or "[]")
    d["required"] = bool(d["required"])
    d["enabled"] = bool(d["enabled"])
    return d


def add_check(slug: str, name: str, path: str, *, method: str = "GET",
              headers: dict | None = None, body: str | None = None,
              assertions: list | None = None, required: bool = True,
              enabled: bool = True) -> dict:
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO checks (slug, name, method, path, headers, body,
                   assertions, required, enabled, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (slug, name, (method or "GET").upper(), path,
             json.dumps(headers or {}), body, json.dumps(assertions or []),
             int(required), int(enabled), time.time()),
        )
        cid = cur.lastrowid
        r = c.execute("SELECT * FROM checks WHERE id=?", (cid,)).fetchone()
    return _row_to_check(r)


# Columns a caller may PATCH, mapped to their JSON-encode (or identity) transform.
_CHECK_UPDATABLE = {
    "name": lambda v: v,
    "method": lambda v: (v or "GET").upper(),
    "path": lambda v: v,
    "headers": json.dumps,
    "body": lambda v: v,
    "assertions": json.dumps,
    "required": lambda v: int(bool(v)),
    "enabled": lambda v: int(bool(v)),
}


def update_check(check_id: int, **fields) -> dict | None:
    sets, vals = [], []
    for k, v in fields.items():
        if v is None or k not in _CHECK_UPDATABLE:
            continue
        sets.append(f"{k}=?")
        vals.append(_CHECK_UPDATABLE[k](v))
    if not sets:
        return get_check(check_id)
    vals.append(check_id)
    with _conn() as c:
        cur = c.execute(f"UPDATE checks SET {', '.join(sets)} WHERE id=?", vals)
        if cur.rowcount == 0:
            return None
    return get_check(check_id)


def delete_check(check_id: int) -> bool:
    with _conn() as c:
        cur = c.execute("DELETE FROM checks WHERE id=?", (check_id,))
        c.execute("DELETE FROM check_results WHERE check_id=?", (check_id,))
        return cur.rowcount > 0


def list_checks(slug: str | None = None, enabled_only: bool = False) -> list[dict]:
    q = "SELECT * FROM checks"
    conds, params = [], []
    if slug is not None:
        conds.append("slug=?")
        params.append(slug)
    if enabled_only:
        conds.append("enabled=1")
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY slug, id"
    with _conn() as c:
        rows = c.execute(q, params).fetchall()
    return [_row_to_check(r) for r in rows]


def get_check(check_id: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM checks WHERE id=?", (check_id,)).fetchone()
    return _row_to_check(r) if r else None


def seed_default_checks() -> None:
    """Seed a default 'health' check for any target that has none, preserving the
    original behavior (GET the health path, status in 2xx–3xx counts as up). This
    keeps existing dashboards identical: a target with only the seeded check is
    'up' exactly when its /health returns 200–399."""
    for t in list_targets():
        if list_checks(t.slug):
            continue
        add_check(
            t.slug, name="health", path=t.health_path, method="GET",
            assertions=[{"type": "status", "op": "in", "value": [200, 399]}],
            required=True, enabled=True,
        )


def record_check_result(check_id: int, slug: str, passed: bool,
                        http_status: int | None, response_ms: float | None,
                        error: str | None, detail: dict | None) -> None:
    with _conn() as c:
        c.execute(
            """INSERT INTO check_results (check_id, slug, ts, passed, http_status,
                   response_ms, error, detail)
               VALUES (?,?,?,?,?,?,?,?)""",
            (check_id, slug, time.time(), int(passed), http_status, response_ms,
             error, json.dumps(detail) if detail is not None else None),
        )
        # Self-prune per check, mirroring the probes time series.
        c.execute(
            """DELETE FROM check_results WHERE check_id=? AND id NOT IN (
                   SELECT id FROM check_results WHERE check_id=?
                   ORDER BY id DESC LIMIT ?)""",
            (check_id, check_id, config.MAX_HISTORY_PER_TARGET),
        )


def _row_to_check_result(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["passed"] = bool(d["passed"])
    d["detail"] = json.loads(d["detail"]) if d.get("detail") else None
    return d


def recent_check_results(check_id: int, limit: int = 50) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM check_results WHERE check_id=? ORDER BY ts DESC LIMIT ?",
            (check_id, limit),
        ).fetchall()
    return [_row_to_check_result(r) for r in rows]


def last_check_result(check_id: int) -> dict | None:
    rows = recent_check_results(check_id, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Logs (ingested structured log lines — self-pruning per slug)                  #
# --------------------------------------------------------------------------- #

def add_logs(slug: str, entries: list[dict]) -> int:
    """Insert a batch of structured log entries for ``slug``; return the count
    actually stored. Each entry: ``{ts?, level, source?, message, meta?}``. An
    unknown/absent level is coerced to 'info'; a missing message is skipped.
    Self-prunes to ``config.MAX_LOGS_PER_TARGET`` rows per slug after the batch."""
    now = time.time()
    rows = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        msg = e.get("message")
        if msg is None:
            continue
        level = str(e.get("level") or "info").lower()
        if level not in LOG_LEVELS:
            level = "info"
        ts = e.get("ts")
        ts = float(ts) if isinstance(ts, (int, float)) else now
        meta = e.get("meta")
        rows.append((slug, ts, level, e.get("source"), str(msg),
                     json.dumps(meta) if meta is not None else None))
    if not rows:
        return 0
    with _conn() as c:
        c.executemany(
            """INSERT INTO logs (slug, ts, level, source, message, meta)
               VALUES (?,?,?,?,?,?)""",
            rows,
        )
        c.execute(
            """DELETE FROM logs WHERE slug=? AND id NOT IN (
                   SELECT id FROM logs WHERE slug=? ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_LOGS_PER_TARGET),
        )
    return len(rows)


def _row_to_log(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["meta"] = json.loads(d["meta"]) if d.get("meta") else None
    return d


def recent_logs(slug: str | None = None, level: str | None = None,
                limit: int = 200, since: float | None = None) -> list[dict]:
    """Newest-first log rows, optionally filtered by slug, level, and a ``since``
    epoch timestamp (rows with ``ts >= since``). ``limit`` is clamped to 1000."""
    limit = max(1, min(int(limit or 200), 1000))
    conds, params = [], []
    if slug is not None:
        conds.append("slug=?")
        params.append(slug)
    if level is not None:
        conds.append("level=?")
        params.append(level)
    if since is not None:
        conds.append("ts>=?")
        params.append(float(since))
    q = "SELECT * FROM logs"
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY ts DESC, id DESC LIMIT ?"
    params.append(limit)
    with _conn() as c:
        rows = c.execute(q, params).fetchall()
    return [_row_to_log(r) for r in rows]


# --------------------------------------------------------------------------- #
# Metric samples (scraped app metrics — self-pruning per slug)                  #
# --------------------------------------------------------------------------- #

def record_metrics(slug: str, ts: float, samples: list[tuple]) -> int:
    """Persist a scrape: ``samples`` is a list of ``(name, labels:dict, value)``.
    Returns the count stored (capped to ``config.MAX_SERIES_PER_SCRAPE``). Skips
    non-finite values (NaN/Inf) — they can't render and aren't worth storing.
    Self-prunes to ``config.MAX_METRICS_PER_TARGET`` rows per slug."""
    import math

    rows = []
    for s in (samples or [])[: config.MAX_SERIES_PER_SCRAPE]:
        try:
            name, labels, value = s
        except (ValueError, TypeError):
            continue
        if value is None or not math.isfinite(value):
            continue
        rows.append((slug, ts, str(name),
                     json.dumps(labels or {}, sort_keys=True), float(value)))
    if not rows:
        return 0
    with _conn() as c:
        c.executemany(
            """INSERT INTO metric_samples (slug, ts, name, labels, value)
               VALUES (?,?,?,?,?)""",
            rows,
        )
        c.execute(
            """DELETE FROM metric_samples WHERE slug=? AND id NOT IN (
                   SELECT id FROM metric_samples WHERE slug=?
                   ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_METRICS_PER_TARGET),
        )
    return len(rows)


def _row_to_sample(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["labels"] = json.loads(d["labels"]) if d.get("labels") else {}
    return d


def metric_series(slug: str, name: str, limit: int = 100) -> list[dict]:
    """Time series (newest-first) for one metric ``name`` of a target. Multiple
    label sets of the same name are interleaved by ts; the caller groups them."""
    limit = max(1, min(int(limit or 100), 2000))
    with _conn() as c:
        rows = c.execute(
            """SELECT * FROM metric_samples WHERE slug=? AND name=?
               ORDER BY ts DESC, id DESC LIMIT ?""",
            (slug, name, limit),
        ).fetchall()
    return [_row_to_sample(r) for r in rows]


def latest_metrics(slug: str, limit: int = 200) -> list[dict]:
    """The most recent scrape's samples for a target — one row per (name, labels)
    at its newest ts. Drives the 'latest values' table + the series picker."""
    limit = max(1, min(int(limit or 200), 2000))
    with _conn() as c:
        # Newest ts per (name, labels), then the value at that ts.
        rows = c.execute(
            """SELECT m.* FROM metric_samples m
               JOIN (SELECT name, labels, MAX(ts) AS mts
                     FROM metric_samples WHERE slug=?
                     GROUP BY name, labels) g
                 ON m.name=g.name AND m.labels=g.labels AND m.ts=g.mts
               WHERE m.slug=?
               ORDER BY m.name LIMIT ?""",
            (slug, slug, limit),
        ).fetchall()
    return [_row_to_sample(r) for r in rows]


def distinct_metric_names(slug: str) -> list[str]:
    with _conn() as c:
        rows = c.execute(
            "SELECT DISTINCT name FROM metric_samples WHERE slug=? ORDER BY name",
            (slug,),
        ).fetchall()
    return [r["name"] for r in rows]


# --------------------------------------------------------------------------- #
# Code-quality (ingested per-commit lint/test/coverage results — self-pruning)  #
# --------------------------------------------------------------------------- #

def add_quality(slug: str, *, commit_sha: str | None, lint_errors: int,
                tests_passed: int, tests_failed: int, coverage_pct: float | None,
                complexity: float | None, grade: str, raw: dict | None) -> dict:
    """Insert one code-quality result for ``slug`` and return the stored row.
    Self-prunes to ``config.MAX_QUALITY_PER_TARGET`` rows per slug."""
    ts = time.time()
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO quality (slug, commit_sha, ts, lint_errors, tests_passed,
                   tests_failed, coverage_pct, complexity, grade, raw)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (slug, commit_sha, ts, int(lint_errors), int(tests_passed),
             int(tests_failed), coverage_pct, complexity, grade,
             json.dumps(raw) if raw is not None else None),
        )
        qid = cur.lastrowid
        c.execute(
            """DELETE FROM quality WHERE slug=? AND id NOT IN (
                   SELECT id FROM quality WHERE slug=? ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_QUALITY_PER_TARGET),
        )
        r = c.execute("SELECT * FROM quality WHERE id=?", (qid,)).fetchone()
    return _row_to_quality(r)


def _row_to_quality(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["raw"] = json.loads(d["raw"]) if d.get("raw") else None
    return d


def list_quality(slug: str, limit: int = 30) -> list[dict]:
    """Newest-first code-quality rows for a target (latest + trend)."""
    limit = max(1, min(int(limit or 30), 500))
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM quality WHERE slug=? ORDER BY ts DESC, id DESC LIMIT ?",
            (slug, limit),
        ).fetchall()
    return [_row_to_quality(r) for r in rows]


def latest_quality(slug: str) -> dict | None:
    rows = list_quality(slug, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Pushes + per-push repo scans (per-commit history for the webhook pipeline)     #
# --------------------------------------------------------------------------- #

def record_push(slug: str, commit_sha: str | None, pusher: str | None,
                message: str | None, scan: dict | None) -> dict:
    """Record one push event (one row per affected slug) + its live-scan result.
    Self-prunes to ``config.MAX_PUSHES_PER_TARGET`` rows per slug."""
    ts = time.time()
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO pushes (slug, commit_sha, ts, pusher, message, scan)
               VALUES (?,?,?,?,?,?)""",
            (slug, commit_sha, ts, pusher, message,
             json.dumps(scan) if scan is not None else None),
        )
        pid = cur.lastrowid
        c.execute(
            """DELETE FROM pushes WHERE slug=? AND id NOT IN (
                   SELECT id FROM pushes WHERE slug=? ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_PUSHES_PER_TARGET),
        )
        r = c.execute("SELECT * FROM pushes WHERE id=?", (pid,)).fetchone()
    return _row_to_push(r)


def _row_to_push(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["scan"] = json.loads(d["scan"]) if d.get("scan") else None
    return d


def list_pushes(slug: str, limit: int = 30) -> list[dict]:
    """Newest-first push rows for a target (per-push history surface)."""
    limit = max(1, min(int(limit or 30), 500))
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM pushes WHERE slug=? ORDER BY ts DESC, id DESC LIMIT ?",
            (slug, limit),
        ).fetchall()
    return [_row_to_push(r) for r in rows]


def record_repo_scan(slug: str, commit_sha: str | None,
                     findings: list[dict]) -> dict:
    """Persist a CI-pushed repo secret-scan result, keyed by commit. The security
    report surfaces the latest one for a slug when no local checkout is available.
    Self-prunes to ``config.MAX_REPO_SCANS_PER_TARGET`` rows per slug."""
    ts = time.time()
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO repo_scans (slug, commit_sha, ts, findings)
               VALUES (?,?,?,?)""",
            (slug, commit_sha, ts, json.dumps(findings or [])),
        )
        rid = cur.lastrowid
        c.execute(
            """DELETE FROM repo_scans WHERE slug=? AND id NOT IN (
                   SELECT id FROM repo_scans WHERE slug=? ORDER BY id DESC LIMIT ?)""",
            (slug, slug, config.MAX_REPO_SCANS_PER_TARGET),
        )
        r = c.execute("SELECT * FROM repo_scans WHERE id=?", (rid,)).fetchone()
    return _row_to_repo_scan(r)


def _row_to_repo_scan(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["findings"] = json.loads(d["findings"]) if d.get("findings") else []
    return d


def latest_repo_scan(slug: str) -> dict | None:
    with _conn() as c:
        r = c.execute(
            "SELECT * FROM repo_scans WHERE slug=? ORDER BY ts DESC, id DESC LIMIT 1",
            (slug,),
        ).fetchone()
    return _row_to_repo_scan(r) if r else None


# --------------------------------------------------------------------------- #
# Users                                                                         #
# --------------------------------------------------------------------------- #

def create_user(email: str, password_hash: str | None, role: str,
                verified: bool, verify_token: str | None,
                oauth_provider: str | None = None) -> dict | None:
    try:
        with _conn() as c:
            cur = c.execute(
                """INSERT INTO users (email, password_hash, role, verified,
                       verify_token, oauth_provider, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (email.lower(), password_hash, role, int(verified),
                 verify_token, oauth_provider, time.time()),
            )
            uid = cur.lastrowid
    except sqlite3.IntegrityError:
        return None
    return get_user_by_id(uid)


def get_user_by_email(email: str) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM users WHERE email=?", (email.lower(),)).fetchone()
    return dict(r) if r else None


def get_user_by_id(uid: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return dict(r) if r else None


def verify_user_by_token(token: str) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM users WHERE verify_token=?", (token,)).fetchone()
        if not r:
            return None
        c.execute(
            "UPDATE users SET verified=1, verify_token=NULL WHERE id=?", (r["id"],)
        )
    return get_user_by_id(r["id"])


def set_user_role(email: str, role: str) -> dict | None:
    with _conn() as c:
        cur = c.execute(
            "UPDATE users SET role=? WHERE email=?", (role, email.lower())
        )
        if cur.rowcount == 0:
            return None
    return get_user_by_email(email)


def list_users() -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT id, email, role, verified, oauth_provider, created_at "
            "FROM users ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# Alert rules + events                                                          #
# --------------------------------------------------------------------------- #

def add_alert_rule(slug: str, metric: str, comparator: str, threshold: float,
                   channel: str, target_addr: str | None) -> dict:
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO alert_rules (slug, metric, comparator, threshold,
                   channel, target_addr, enabled, created_at)
               VALUES (?,?,?,?,?,?,1,?)""",
            (slug, metric, comparator, threshold, channel, target_addr, time.time()),
        )
        rid = cur.lastrowid
        r = c.execute("SELECT * FROM alert_rules WHERE id=?", (rid,)).fetchone()
    return dict(r)


def list_alert_rules(slug: str | None = None) -> list[dict]:
    with _conn() as c:
        if slug:
            rows = c.execute(
                "SELECT * FROM alert_rules WHERE slug=? AND enabled=1", (slug,)
            ).fetchall()
        else:
            rows = c.execute("SELECT * FROM alert_rules WHERE enabled=1").fetchall()
    return [dict(r) for r in rows]


def record_alert_event(rule_id: int | None, slug: str, channel: str,
                       message: str, delivered: bool) -> None:
    with _conn() as c:
        c.execute(
            """INSERT INTO alert_events (rule_id, slug, ts, channel, message, delivered)
               VALUES (?,?,?,?,?,?)""",
            (rule_id, slug, time.time(), channel, message, int(delivered)),
        )


def recent_alert_events(limit: int = 50) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM alert_events ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]
