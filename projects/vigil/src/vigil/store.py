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
"""


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
    seed_targets(config.SEED_TARGETS + config.load_file_targets())
    seed_default_checks()


# --------------------------------------------------------------------------- #
# Targets                                                                       #
# --------------------------------------------------------------------------- #

def seed_targets(targets: list[Target]) -> None:
    now = time.time()
    with _conn() as c:
        for t in targets:
            c.execute(
                """INSERT INTO targets (slug, name, url, health_path, repo,
                       self_monitor, tags, created_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(slug) DO UPDATE SET
                       name=excluded.name, url=excluded.url,
                       health_path=excluded.health_path, repo=excluded.repo,
                       self_monitor=excluded.self_monitor, tags=excluded.tags""",
                (t.slug, t.name, t.url, t.health_path, t.repo,
                 int(t.self_monitor), json.dumps(t.tags), now),
            )


def add_target(t: Target) -> None:
    seed_targets([t])


def remove_target(slug: str) -> bool:
    with _conn() as c:
        cur = c.execute("DELETE FROM targets WHERE slug=?", (slug,))
        return cur.rowcount > 0


def _row_to_target(r: sqlite3.Row) -> Target:
    return Target(
        slug=r["slug"], name=r["name"], url=r["url"],
        health_path=r["health_path"], repo=r["repo"],
        self_monitor=bool(r["self_monitor"]), tags=json.loads(r["tags"]),
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
