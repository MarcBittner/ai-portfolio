"""MongoDB persistence — the durable backend behind ``vigil.store``.

Selected only when ``config.MONGODB_URI`` is set; otherwise vigil runs on the
default SQLite backend (``_store_sqlite``) and ``pymongo`` is never imported. This
module implements the **same public function surface** as the SQLite backend
(identical names, signatures, and return shapes — including opaque **string ids**),
so api.py / the SPA / the prober are backend-agnostic.

Why this data model (it is *not* a 1:1 dump of the SQLite tables):

- **``targets`` — checks embedded.** ``_id`` is the slug; the target's synthetic
  checks live in an embedded ``checks`` array of subdocuments (each with a stable
  string ``id``). A target's checks are bounded and *always* read together with the
  target during a poll, so embedding makes the common read a single document fetch
  and admin check-CRUD a single array update (``$push`` / positional ``$set`` /
  ``$pull``). No join, no second collection.

- **Time-series collections + TTL.** ``probes``, ``check_results``, ``logs`` and
  ``metric_samples`` are append-only time series. They are created as native
  MongoDB **time-series collections** (``timeField='ts'`` + a ``metaField``), with a
  **TTL** (``expireAfterSeconds``) so retention is **time-based and self-managing** —
  this intentionally *replaces* SQLite's count-based manual pruning. (Behaviour
  change: a 14-day-old probe is expired by the server rather than capped at N rows.)
  On a server too old for time-series collections we fall back to an ordinary
  collection with a TTL index on ``ts`` — same retention semantics, detected at
  ``init_db`` time.

- **Standard indexed collections.** ``users`` (unique ``email``), ``alert_rules``,
  ``alert_events``, ``quality``, ``pushes``, ``repo_scans`` are plain documents with
  compound indexes matching the read paths (``{slug:1, ts:-1}`` etc.).

Ids: Mongo ``_id`` is an ``ObjectId``; we return it to callers as ``str(_id)`` and
accept the string form back (``ObjectId(s)``). Embedded check ids are freshly minted
``str(ObjectId())`` strings stored on the subdoc as ``id``.
"""

from __future__ import annotations

import math
import time

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError, OperationFailure
from pymongo.operations import IndexModel

try:  # bson ships with pymongo
    from bson import ObjectId
except ImportError:  # pragma: no cover - pymongo always provides bson
    from bson.objectid import ObjectId  # type: ignore

from vigil import config
from vigil.config import Target

# Mirrors the SQLite backend so callers importing ``store.LOG_LEVELS`` are identical.
LOG_LEVELS = ("debug", "info", "warn", "error")

# The four append-only time series → their Mongo time-series metaField shape.
_TS_COLLECTIONS = {
    "probes": "slug",
    "check_results": "meta",      # {slug, check_id}
    "logs": "meta",               # {slug, level, source}
    "metric_samples": "meta",     # {slug, name}
}

_client: MongoClient | None = None
_db = None


# --------------------------------------------------------------------------- #
# Connection + id helpers                                                       #
# --------------------------------------------------------------------------- #

def _database():
    """Lazily create the shared MongoClient + handle to the DEDICATED vigil DB.

    The client is created once per process and is thread-safe (pymongo pools
    connections), matching how the async poller + request handlers share it."""
    global _client, _db
    if _db is None:
        _client = MongoClient(config.MONGODB_URI, tz_aware=False,
                              appname="vigil", serverSelectionTimeoutMS=8000)
        _db = _client[config.MONGODB_DB]
    return _db


def _oid(value: object) -> ObjectId | None:
    """Coerce an opaque string id back to an ObjectId, or None if it isn't valid."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except Exception:  # noqa: BLE001 — an invalid id is a clean 'not found'
        return None


def _new_id() -> str:
    """Mint a fresh opaque string id (for embedded check subdocuments)."""
    return str(ObjectId())


# --------------------------------------------------------------------------- #
# Schema / index bootstrap                                                      #
# --------------------------------------------------------------------------- #

def _ensure_timeseries(db, name: str, meta_field: str) -> None:
    """Create ``name`` as a native time-series collection with a TTL, falling back
    to a plain collection + TTL index on ``ts`` on older servers. Idempotent."""
    existing = set(db.list_collection_names())
    if name not in existing:
        try:
            db.create_collection(
                name,
                timeseries={"timeField": "ts", "metaField": meta_field,
                            "granularity": "seconds"},
                expireAfterSeconds=config.MONGODB_TTL_SECONDS,
            )
            return
        except (OperationFailure, NotImplementedError, TypeError):
            # Server (or mongomock) too old / unable to create a time-series
            # collection — fall back to a normal collection with a TTL index on a
            # Date field (same time-based retention semantics).
            db.create_collection(name)
    # Plain-collection fallback (or pre-existing plain collection): ensure a TTL
    # index. Time-series collections manage their own TTL, so guard with a probe.
    try:
        opts = db[name].options()
    except Exception:  # noqa: BLE001 — mongomock/old driver may lack .options()
        opts = {}
    if "timeseries" not in opts:
        # ts is stored as an epoch float here (not a BSON date), so a TTL index on it
        # can't be used by Mongo's TTL monitor (which requires a Date). For the
        # fallback path we instead store ``ts`` as a float AND keep an indexed
        # ``_expire_at`` Date for TTL. Create that index here.
        db[name].create_index(
            [("_expire_at", ASCENDING)], expireAfterSeconds=0,
            name="ttl_expire_at", background=True,
        )
        db[name].create_index([("ts", DESCENDING)], name="ts_desc", background=True)


def init_db() -> None:
    """Create collections + indexes and upsert the seed/file registry. Idempotent.

    Mirrors the SQLite backend's ``init_db``: every collection/index the read paths
    need is created here, then the seed targets + default checks are upserted."""
    db = _database()

    # Time-series (or fallback) collections for the four append-only series.
    _ensure_timeseries(db, "probes", "slug")
    _ensure_timeseries(db, "check_results", "meta")
    _ensure_timeseries(db, "logs", "meta")
    _ensure_timeseries(db, "metric_samples", "meta")

    # Read-path indexes on the time series (time-series collections support
    # secondary indexes on meta + time fields).
    db.probes.create_index([("slug", ASCENDING), ("ts", DESCENDING)],
                           name="slug_ts", background=True)
    db.check_results.create_index(
        [("meta.check_id", ASCENDING), ("ts", DESCENDING)],
        name="cid_ts", background=True)
    db.check_results.create_index(
        [("meta.slug", ASCENDING), ("ts", DESCENDING)],
        name="slug_ts", background=True)
    db.logs.create_index([("meta.slug", ASCENDING), ("ts", DESCENDING)],
                         name="slug_ts", background=True)
    db.logs.create_index([("meta.level", ASCENDING), ("ts", DESCENDING)],
                         name="level_ts", background=True)
    db.metric_samples.create_index(
        [("meta.slug", ASCENDING), ("meta.name", ASCENDING), ("ts", DESCENDING)],
        name="slug_name_ts", background=True)

    # Standard collections + their compound indexes.
    db.users.create_indexes([IndexModel([("email", ASCENDING)], unique=True,
                                         name="email_unique")])
    db.alert_rules.create_index([("slug", ASCENDING), ("enabled", ASCENDING)],
                               name="slug_enabled", background=True)
    db.alert_events.create_index([("ts", DESCENDING)], name="ts_desc",
                                background=True)
    for coll in ("quality", "pushes", "repo_scans"):
        db[coll].create_index([("slug", ASCENDING), ("ts", DESCENDING)],
                             name="slug_ts", background=True)

    seed_targets(config.SEED_TARGETS + config.load_file_targets())
    seed_default_checks()


# --------------------------------------------------------------------------- #
# Targets (checks embedded as a subdocument array)                              #
# --------------------------------------------------------------------------- #

def _target_doc(t: Target, now: float) -> dict:
    return {
        "_id": t.slug, "name": t.name, "url": t.url,
        "health_path": t.health_path, "repo": t.repo,
        "self_monitor": bool(t.self_monitor), "tags": list(t.tags),
        "metrics_path": t.metrics_path, "created_at": now,
    }


def seed_targets(targets: list[Target]) -> None:
    """Upsert each target's scalar fields, preserving any embedded ``checks`` array
    (the seed must not clobber admin-defined checks). Mirrors the SQLite upsert."""
    db = _database()
    now = time.time()
    for t in targets:
        doc = _target_doc(t, now)
        # created_at only set on insert; never overwrite the embedded checks.
        db.targets.update_one(
            {"_id": t.slug},
            {"$set": {k: v for k, v in doc.items() if k != "created_at"},
             "$setOnInsert": {"created_at": now, "checks": []}},
            upsert=True,
        )


def add_target(t: Target) -> None:
    seed_targets([t])


def remove_target(slug: str) -> bool:
    db = _database()
    res = db.targets.delete_one({"_id": slug})
    return res.deleted_count > 0


def _doc_to_target(d: dict) -> Target:
    return Target(
        slug=d["_id"], name=d["name"], url=d["url"],
        health_path=d.get("health_path", "/health"), repo=d.get("repo"),
        self_monitor=bool(d.get("self_monitor")), tags=list(d.get("tags") or []),
        metrics_path=d.get("metrics_path"),
    )


def list_targets() -> list[Target]:
    db = _database()
    cur = db.targets.find().sort([("self_monitor", DESCENDING), ("_id", ASCENDING)])
    return [_doc_to_target(d) for d in cur]


def get_target(slug: str) -> Target | None:
    db = _database()
    d = db.targets.find_one({"_id": slug})
    return _doc_to_target(d) if d else None


# --------------------------------------------------------------------------- #
# Probes (time series)                                                          #
# --------------------------------------------------------------------------- #

def record_probe(slug: str, up: bool, http_status: int | None,
                 response_ms: float | None, error: str | None) -> None:
    db = _database()
    db.probes.insert_one({
        "slug": slug, "ts": time.time(), "up": int(bool(up)),
        "http_status": http_status, "response_ms": response_ms, "error": error,
        "_expire_at": _expire_at(),
    })
    # Retention is TTL-based (see module docstring) — no manual prune.


def _probe_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "slug": d["slug"], "ts": d["ts"],
        "up": int(d.get("up", 0)), "http_status": d.get("http_status"),
        "response_ms": d.get("response_ms"), "error": d.get("error"),
    }


def recent_probes(slug: str, limit: int = 100) -> list[dict]:
    db = _database()
    cur = db.probes.find({"slug": slug}).sort("ts", DESCENDING).limit(int(limit))
    return [_probe_view(d) for d in cur]


def last_probe(slug: str) -> dict | None:
    rows = recent_probes(slug, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Synthetic checks (embedded in the target document)                            #
# --------------------------------------------------------------------------- #

def _check_view(slug: str, sub: dict) -> dict:
    """Shape an embedded check subdoc to match the SQLite ``checks`` row exactly."""
    return {
        "id": sub["id"], "slug": slug, "name": sub["name"],
        "method": sub.get("method", "GET"), "path": sub.get("path", "/"),
        "headers": dict(sub.get("headers") or {}),
        "body": sub.get("body"),
        "assertions": list(sub.get("assertions") or []),
        "required": bool(sub.get("required", True)),
        "enabled": bool(sub.get("enabled", True)),
        "created_at": sub.get("created_at"),
    }


def add_check(slug: str, name: str, path: str, *, method: str = "GET",
              headers: dict | None = None, body: str | None = None,
              assertions: list | None = None, required: bool = True,
              enabled: bool = True) -> dict:
    db = _database()
    sub = {
        "id": _new_id(), "name": name, "method": (method or "GET").upper(),
        "path": path, "headers": dict(headers or {}), "body": body,
        "assertions": list(assertions or []), "required": bool(required),
        "enabled": bool(enabled), "created_at": time.time(),
    }
    db.targets.update_one({"_id": slug}, {"$push": {"checks": sub}})
    return _check_view(slug, sub)


_CHECK_UPDATABLE = {
    "name": lambda v: v,
    "method": lambda v: (v or "GET").upper(),
    "path": lambda v: v,
    "headers": lambda v: dict(v or {}),
    "body": lambda v: v,
    "assertions": lambda v: list(v or []),
    "required": lambda v: bool(v),
    "enabled": lambda v: bool(v),
}


def _find_check(check_id: str) -> tuple[str, dict] | None:
    """Locate an embedded check by its string id → (slug, subdoc).

    Filters to the owning target with ``{"checks.id": ...}`` (index-eligible) then
    picks the matching subdoc in Python — avoids relying on the ``$`` positional
    projection so the same code works on any server/driver."""
    db = _database()
    d = db.targets.find_one({"checks.id": str(check_id)}, {"_id": 1, "checks": 1})
    if not d:
        return None
    for sub in d.get("checks") or []:
        if sub.get("id") == str(check_id):
            return d["_id"], sub
    return None


def update_check(check_id: str | int, **fields) -> dict | None:
    db = _database()
    found = _find_check(str(check_id))
    if not found:
        return None
    slug, _sub = found
    sets = {}
    for k, v in fields.items():
        if v is None or k not in _CHECK_UPDATABLE:
            continue
        sets[f"checks.$.{k}"] = _CHECK_UPDATABLE[k](v)
    if sets:
        db.targets.update_one(
            {"_id": slug, "checks.id": str(check_id)}, {"$set": sets})
    return get_check(check_id)


def delete_check(check_id: str | int) -> bool:
    db = _database()
    res = db.targets.update_one(
        {"checks.id": str(check_id)},
        {"$pull": {"checks": {"id": str(check_id)}}})
    if res.modified_count:
        # Drop this check's result history too (mirrors the SQLite cascade).
        db.check_results.delete_many({"meta.check_id": str(check_id)})
        return True
    return False


def list_checks(slug: str | None = None, enabled_only: bool = False) -> list[dict]:
    db = _database()
    q = {} if slug is None else {"_id": slug}
    out: list[dict] = []
    for d in db.targets.find(q).sort("_id", ASCENDING):
        for sub in d.get("checks") or []:
            if enabled_only and not sub.get("enabled", True):
                continue
            out.append(_check_view(d["_id"], sub))
    return out


def get_check(check_id: str | int) -> dict | None:
    found = _find_check(str(check_id))
    if not found:
        return None
    slug, sub = found
    return _check_view(slug, sub)


def seed_default_checks() -> None:
    """Seed a default 'health' check for any target that has none (identical policy
    to the SQLite backend)."""
    for t in list_targets():
        if list_checks(t.slug):
            continue
        add_check(
            t.slug, name="health", path=t.health_path, method="GET",
            assertions=[{"type": "status", "op": "in", "value": [200, 399]}],
            required=True, enabled=True,
        )


def record_check_result(check_id: str | int, slug: str, passed: bool,
                        http_status: int | None, response_ms: float | None,
                        error: str | None, detail: dict | None) -> None:
    db = _database()
    db.check_results.insert_one({
        "meta": {"slug": slug, "check_id": str(check_id)},
        "ts": time.time(), "passed": int(bool(passed)),
        "http_status": http_status, "response_ms": response_ms,
        "error": error, "detail": detail, "_expire_at": _expire_at(),
    })


def _check_result_view(d: dict) -> dict:
    meta = d.get("meta") or {}
    return {
        "id": str(d["_id"]), "check_id": meta.get("check_id"),
        "slug": meta.get("slug"), "ts": d["ts"],
        "passed": bool(d.get("passed")), "http_status": d.get("http_status"),
        "response_ms": d.get("response_ms"), "error": d.get("error"),
        "detail": d.get("detail"),
    }


def recent_check_results(check_id: str | int, limit: int = 50) -> list[dict]:
    db = _database()
    cur = (db.check_results.find({"meta.check_id": str(check_id)})
           .sort("ts", DESCENDING).limit(int(limit)))
    return [_check_result_view(d) for d in cur]


def last_check_result(check_id: str | int) -> dict | None:
    rows = recent_check_results(check_id, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Logs (time series, TTL-retained)                                              #
# --------------------------------------------------------------------------- #

def _expire_at():
    """Absolute expiry Date for the fallback (plain-collection) TTL index. Native
    time-series collections manage their own TTL and ignore this field; carrying it
    on every doc keeps the two paths uniform and the fallback self-pruning."""
    import datetime
    return datetime.datetime.utcnow() + datetime.timedelta(
        seconds=config.MONGODB_TTL_SECONDS)


def add_logs(slug: str, entries: list[dict]) -> int:
    now = time.time()
    docs = []
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
        docs.append({
            "meta": {"slug": slug, "level": level, "source": e.get("source")},
            "ts": ts, "message": str(msg), "log_meta": e.get("meta"),
            "_expire_at": _expire_at(),
        })
    if not docs:
        return 0
    _database().logs.insert_many(docs)
    return len(docs)


def _log_view(d: dict) -> dict:
    meta = d.get("meta") or {}
    return {
        "id": str(d["_id"]), "slug": meta.get("slug"), "ts": d["ts"],
        "level": meta.get("level"), "source": meta.get("source"),
        "message": d.get("message"), "meta": d.get("log_meta"),
    }


def recent_logs(slug: str | None = None, level: str | None = None,
                limit: int = 200, since: float | None = None) -> list[dict]:
    limit = max(1, min(int(limit or 200), 1000))
    q: dict = {}
    if slug is not None:
        q["meta.slug"] = slug
    if level is not None:
        q["meta.level"] = level
    if since is not None:
        q["ts"] = {"$gte": float(since)}
    cur = _database().logs.find(q).sort("ts", DESCENDING).limit(limit)
    return [_log_view(d) for d in cur]


# --------------------------------------------------------------------------- #
# Metric samples (time series, TTL-retained)                                    #
# --------------------------------------------------------------------------- #

def record_metrics(slug: str, ts: float, samples: list[tuple]) -> int:
    docs = []
    for s in (samples or [])[: config.MAX_SERIES_PER_SCRAPE]:
        try:
            name, labels, value = s
        except (ValueError, TypeError):
            continue
        if value is None or not math.isfinite(value):
            continue
        docs.append({
            "meta": {"slug": slug, "name": str(name)},
            "ts": ts, "labels": dict(labels or {}), "value": float(value),
            "_expire_at": _expire_at(),
        })
    if not docs:
        return 0
    _database().metric_samples.insert_many(docs)
    return len(docs)


def _sample_view(d: dict) -> dict:
    meta = d.get("meta") or {}
    return {
        "id": str(d["_id"]), "slug": meta.get("slug"), "ts": d["ts"],
        "name": meta.get("name"), "labels": dict(d.get("labels") or {}),
        "value": d.get("value"),
    }


def metric_series(slug: str, name: str, limit: int = 100) -> list[dict]:
    limit = max(1, min(int(limit or 100), 2000))
    cur = (_database().metric_samples
           .find({"meta.slug": slug, "meta.name": name})
           .sort("ts", DESCENDING).limit(limit))
    return [_sample_view(d) for d in cur]


def latest_metrics(slug: str, limit: int = 200) -> list[dict]:
    """The newest sample per (name, labels) for a target — one row each, at its most
    recent ts. Matches the SQLite ``latest_metrics`` shape + ordering (by name)."""
    limit = max(1, min(int(limit or 200), 2000))
    db = _database()
    # Newest-first scan, dedup by (name, labels) keeping the first (newest) seen.
    seen: dict[tuple, dict] = {}
    cur = db.metric_samples.find({"meta.slug": slug}).sort("ts", DESCENDING)
    for d in cur:
        view = _sample_view(d)
        key = (view["name"], _labels_key(view["labels"]))
        if key not in seen:
            seen[key] = view
    rows = sorted(seen.values(), key=lambda r: r["name"])
    return rows[:limit]


def _labels_key(labels: dict) -> str:
    import json as _json
    return _json.dumps(labels or {}, sort_keys=True)


def distinct_metric_names(slug: str) -> list[str]:
    names = _database().metric_samples.distinct("meta.name", {"meta.slug": slug})
    return sorted(names)


# --------------------------------------------------------------------------- #
# Code-quality (standard collection, TTL-free; trimmed to N like SQLite)        #
# --------------------------------------------------------------------------- #

def _trim(coll, slug: str, keep: int) -> None:
    """Keep only the newest ``keep`` docs for ``slug`` in a standard collection
    (mirrors SQLite's count-based prune for the non-time-series surfaces)."""
    db = _database()
    skip = db[coll].count_documents({"slug": slug}) - keep
    if skip <= 0:
        return
    olds = (db[coll].find({"slug": slug}, {"_id": 1})
            .sort("ts", DESCENDING).skip(keep))
    ids = [o["_id"] for o in olds]
    if ids:
        db[coll].delete_many({"_id": {"$in": ids}})


def add_quality(slug: str, *, commit_sha: str | None, lint_errors: int,
                tests_passed: int, tests_failed: int, coverage_pct: float | None,
                complexity: float | None, grade: str, raw: dict | None) -> dict:
    db = _database()
    doc = {
        "slug": slug, "commit_sha": commit_sha, "ts": time.time(),
        "lint_errors": int(lint_errors), "tests_passed": int(tests_passed),
        "tests_failed": int(tests_failed), "coverage_pct": coverage_pct,
        "complexity": complexity, "grade": grade, "raw": raw,
    }
    res = db.quality.insert_one(doc)
    _trim("quality", slug, config.MAX_QUALITY_PER_TARGET)
    doc["_id"] = res.inserted_id
    return _quality_view(doc)


def _quality_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "slug": d["slug"], "commit_sha": d.get("commit_sha"),
        "ts": d["ts"], "lint_errors": d.get("lint_errors", 0),
        "tests_passed": d.get("tests_passed", 0),
        "tests_failed": d.get("tests_failed", 0),
        "coverage_pct": d.get("coverage_pct"), "complexity": d.get("complexity"),
        "grade": d.get("grade"), "raw": d.get("raw"),
    }


def list_quality(slug: str, limit: int = 30) -> list[dict]:
    limit = max(1, min(int(limit or 30), 500))
    cur = (_database().quality.find({"slug": slug})
           .sort("ts", DESCENDING).limit(limit))
    return [_quality_view(d) for d in cur]


def latest_quality(slug: str) -> dict | None:
    rows = list_quality(slug, 1)
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# Pushes + repo scans (standard collections, trimmed like SQLite)               #
# --------------------------------------------------------------------------- #

def record_push(slug: str, commit_sha: str | None, pusher: str | None,
                message: str | None, scan: dict | None) -> dict:
    db = _database()
    doc = {
        "slug": slug, "commit_sha": commit_sha, "ts": time.time(),
        "pusher": pusher, "message": message, "scan": scan,
    }
    res = db.pushes.insert_one(doc)
    _trim("pushes", slug, config.MAX_PUSHES_PER_TARGET)
    doc["_id"] = res.inserted_id
    return _push_view(doc)


def _push_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "slug": d["slug"], "commit_sha": d.get("commit_sha"),
        "ts": d["ts"], "pusher": d.get("pusher"), "message": d.get("message"),
        "scan": d.get("scan"),
    }


def list_pushes(slug: str, limit: int = 30) -> list[dict]:
    limit = max(1, min(int(limit or 30), 500))
    cur = (_database().pushes.find({"slug": slug})
           .sort("ts", DESCENDING).limit(limit))
    return [_push_view(d) for d in cur]


def record_repo_scan(slug: str, commit_sha: str | None,
                     findings: list[dict]) -> dict:
    db = _database()
    doc = {
        "slug": slug, "commit_sha": commit_sha, "ts": time.time(),
        "findings": list(findings or []),
    }
    res = db.repo_scans.insert_one(doc)
    _trim("repo_scans", slug, config.MAX_REPO_SCANS_PER_TARGET)
    doc["_id"] = res.inserted_id
    return _repo_scan_view(doc)


def _repo_scan_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "slug": d["slug"], "commit_sha": d.get("commit_sha"),
        "ts": d["ts"], "findings": list(d.get("findings") or []),
    }


def latest_repo_scan(slug: str) -> dict | None:
    d = _database().repo_scans.find_one({"slug": slug}, sort=[("ts", DESCENDING)])
    return _repo_scan_view(d) if d else None


# --------------------------------------------------------------------------- #
# Users                                                                         #
# --------------------------------------------------------------------------- #

def create_user(email: str, password_hash: str | None, role: str,
                verified: bool, verify_token: str | None,
                oauth_provider: str | None = None) -> dict | None:
    db = _database()
    doc = {
        "email": email.lower(), "password_hash": password_hash, "role": role,
        "verified": int(bool(verified)), "verify_token": verify_token,
        "oauth_provider": oauth_provider, "created_at": time.time(),
    }
    try:
        res = db.users.insert_one(doc)
    except DuplicateKeyError:
        return None
    doc["_id"] = res.inserted_id
    return _user_view(doc)


def _user_view(d: dict, *, public: bool = False) -> dict:
    out = {
        "id": str(d["_id"]), "email": d.get("email"), "role": d.get("role"),
        "verified": int(d.get("verified", 0)),
        "oauth_provider": d.get("oauth_provider"),
        "created_at": d.get("created_at"),
    }
    if not public:
        out["password_hash"] = d.get("password_hash")
        out["verify_token"] = d.get("verify_token")
    return out


def get_user_by_email(email: str) -> dict | None:
    d = _database().users.find_one({"email": email.lower()})
    return _user_view(d) if d else None


def get_user_by_id(uid: str | int) -> dict | None:
    oid = _oid(uid)
    if oid is None:
        return None
    d = _database().users.find_one({"_id": oid})
    return _user_view(d) if d else None


def verify_user_by_token(token: str) -> dict | None:
    db = _database()
    d = db.users.find_one({"verify_token": token})
    if not d:
        return None
    db.users.update_one({"_id": d["_id"]},
                        {"$set": {"verified": 1, "verify_token": None}})
    return get_user_by_id(str(d["_id"]))


def set_user_role(email: str, role: str) -> dict | None:
    db = _database()
    res = db.users.update_one({"email": email.lower()}, {"$set": {"role": role}})
    if res.matched_count == 0:
        return None
    return get_user_by_email(email)


def list_users() -> list[dict]:
    cur = _database().users.find().sort("created_at", ASCENDING)
    return [_user_view(d, public=True) for d in cur]


# --------------------------------------------------------------------------- #
# Alert rules + events                                                          #
# --------------------------------------------------------------------------- #

def add_alert_rule(slug: str, metric: str, comparator: str, threshold: float,
                   channel: str, target_addr: str | None) -> dict:
    db = _database()
    doc = {
        "slug": slug, "metric": metric, "comparator": comparator,
        "threshold": threshold, "channel": channel, "target_addr": target_addr,
        "enabled": 1, "created_at": time.time(),
    }
    res = db.alert_rules.insert_one(doc)
    doc["_id"] = res.inserted_id
    return _rule_view(doc)


def _rule_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "slug": d["slug"], "metric": d.get("metric"),
        "comparator": d.get("comparator"), "threshold": d.get("threshold"),
        "channel": d.get("channel"), "target_addr": d.get("target_addr"),
        "enabled": int(d.get("enabled", 1)), "created_at": d.get("created_at"),
    }


def list_alert_rules(slug: str | None = None) -> list[dict]:
    q = {"enabled": 1}
    if slug:
        q["slug"] = slug
    cur = _database().alert_rules.find(q)
    return [_rule_view(d) for d in cur]


def record_alert_event(rule_id: str | int | None, slug: str, channel: str,
                       message: str, delivered: bool) -> None:
    _database().alert_events.insert_one({
        "rule_id": str(rule_id) if rule_id is not None else None,
        "slug": slug, "ts": time.time(), "channel": channel,
        "message": message, "delivered": int(bool(delivered)),
    })


def _event_view(d: dict) -> dict:
    return {
        "id": str(d["_id"]), "rule_id": d.get("rule_id"), "slug": d.get("slug"),
        "ts": d["ts"], "channel": d.get("channel"), "message": d.get("message"),
        "delivered": int(d.get("delivered", 0)),
    }


def recent_alert_events(limit: int = 50) -> list[dict]:
    cur = _database().alert_events.find().sort("ts", DESCENDING).limit(int(limit))
    return [_event_view(d) for d in cur]
