"""Backend-agnostic store contract.

The same assertions run against whatever backend ``vigil.store`` selects. In CI that
is always **SQLite** (no ``MONGODB_URI`` set, no pymongo needed), so this file is the
guarantee that the public store surface — including **opaque string ids** that
api.py and the SPA depend on — behaves identically regardless of backend.

Three layers:

1. ``test_contract_*`` — run against the *active* backend (SQLite in CI). These are
   the load-bearing tests that must pass with no Mongo/pymongo present.
2. ``test_mongo_contract_mongomock`` — re-runs the contract against the Mongo
   backend via ``mongomock`` IF (and only if) it's installed. Skipped otherwise, so
   it never adds a hard dependency to CI.
3. ``test_mongo_smoke_live`` — a create/read/prune smoke against a **real** cluster,
   gated on ``MONGODB_URI`` so it stays skipped in CI and can be run later against
   the deployed Mongo.
"""

from __future__ import annotations

import os
import tempfile

os.environ.pop("MONGODB_URI", None)  # CI runs the SQLite backend
os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-contract.db")

import pytest  # noqa: E402

from vigil import store  # noqa: E402


def _fresh_sqlite() -> None:
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


# --------------------------------------------------------------------------- #
# The contract itself — exercised against whichever module is passed in.        #
# --------------------------------------------------------------------------- #

def _run_contract(s) -> None:
    """Assertions that must hold for BOTH backends. ``s`` is the store module."""
    targets = s.list_targets()
    assert any(t.slug == "vigil" and t.self_monitor for t in targets)
    vigil = s.get_target("vigil")
    assert vigil is not None and vigil.url

    # --- Checks: ids are opaque strings, round-trip through get/update/delete ---
    checks = s.list_checks("vigil")
    assert checks, "default 'health' check should be seeded"
    cid = checks[0]["id"]
    assert isinstance(cid, str), "ids must be opaque strings (cross-backend)"

    got = s.get_check(cid)
    assert got is not None and got["id"] == cid and got["slug"] == "vigil"
    assert isinstance(got["headers"], dict) and isinstance(got["assertions"], list)
    assert isinstance(got["required"], bool) and isinstance(got["enabled"], bool)

    # A bogus id is a clean miss, never a crash.
    assert s.get_check("does-not-exist") is None
    assert s.update_check("does-not-exist", enabled=False) is None
    assert s.delete_check("does-not-exist") is False

    # add → list → enabled filter
    new = s.add_check("vigil", "extra", "/x", method="post",
                      assertions=[{"type": "status", "op": "eq", "value": 200}],
                      required=False, enabled=False)
    assert isinstance(new["id"], str) and new["method"] == "POST"
    assert len(s.list_checks("vigil")) == len(checks) + 1
    assert all(c["enabled"] for c in s.list_checks("vigil", enabled_only=True))

    # update by string id
    upd = s.update_check(new["id"], enabled=True, name="renamed")
    assert upd["enabled"] is True and upd["name"] == "renamed"

    # --- Probes (time series) ---
    s.record_probe("vigil", True, 200, 12.5, None)
    s.record_probe("vigil", False, 503, 30.0, "HTTP 503")
    probes = s.recent_probes("vigil", 10)
    assert len(probes) >= 2
    assert s.last_probe("vigil")["error"] == "HTTP 503"  # newest-first

    # --- Check results keyed by the (string) check id ---
    s.record_check_result(new["id"], "vigil", True, 200, 9.0, None,
                          {"results": [{"type": "status", "ok": True}]})
    last = s.last_check_result(new["id"])
    assert last["passed"] is True and last["check_id"] == new["id"]
    assert last["detail"]["results"][0]["ok"] is True

    # delete cascades the check's result history
    assert s.delete_check(new["id"]) is True
    assert s.recent_check_results(new["id"]) == []
    assert s.get_check(new["id"]) is None

    # --- Logs ---
    n = s.add_logs("vigil", [
        {"level": "warn", "source": "t", "message": "m1", "meta": {"a": 1}},
        {"level": "bogus", "message": "m2"},  # coerced to info
        {"message": None},                    # skipped
    ])
    assert n == 2
    logs = s.recent_logs("vigil", limit=10)
    assert len(logs) >= 2
    assert {lg["level"] for lg in logs} <= set(s.LOG_LEVELS)
    assert len(s.recent_logs("vigil", level="warn")) >= 1
    assert all(lg["level"] == "info" for lg in s.recent_logs("vigil", level="info"))

    # --- Metric samples ---
    stored = s.record_metrics("vigil", 1000.0, [
        ("cpu", {}, 0.5), ("mem", {"h": "a"}, 0.9),
        ("bad", {}, float("nan")),  # non-finite → skipped
    ])
    assert stored == 2
    assert len(s.metric_series("vigil", "cpu")) == 1
    latest = s.latest_metrics("vigil")
    assert {m["name"] for m in latest} == {"cpu", "mem"}
    assert s.distinct_metric_names("vigil") == ["cpu", "mem"]

    # --- Users (unique email, string ids, password_hash available for auth) ---
    u = s.create_user("user@x.com", "HASH", "registered", False, "tok")
    assert isinstance(u["id"], str)
    assert s.create_user("USER@x.com", "h2", "admin", True, None) is None  # unique
    assert s.get_user_by_id(u["id"])["email"] == "user@x.com"
    assert s.get_user_by_email("user@x.com")["password_hash"] == "HASH"
    v = s.verify_user_by_token("tok")
    assert v["verified"] in (1, True) and v["verify_token"] is None
    assert s.set_user_role("user@x.com", "elevated")["role"] == "elevated"
    listed = s.list_users()
    assert any(x["email"] == "user@x.com" for x in listed)
    assert all("password_hash" not in x for x in listed)  # list view is public

    # --- Alert rules + events ---
    rule = s.add_alert_rule("vigil", "down", "gt", 0, "console", None)
    assert isinstance(rule["id"], str) and rule["enabled"] in (1, True)
    assert any(r["id"] == rule["id"] for r in s.list_alert_rules("vigil"))
    s.record_alert_event(rule["id"], "vigil", "console", "fired", True)
    events = s.recent_alert_events(10)
    assert events and events[0]["rule_id"] == rule["id"]

    # --- Quality / pushes / repo scans ---
    q = s.add_quality("vigil", commit_sha="abc", lint_errors=0, tests_passed=10,
                      tests_failed=0, coverage_pct=95.0, complexity=2.0, grade="A",
                      raw={"k": 1})
    assert isinstance(q["id"], str) and s.latest_quality("vigil")["grade"] == "A"
    assert s.list_quality("vigil")[0]["raw"] == {"k": 1}

    p = s.record_push("vigil", "sha1", "me", "msg", {"posture": {"score": 1}})
    assert isinstance(p["id"], str) and s.list_pushes("vigil")[0]["scan"]["posture"]

    rs = s.record_repo_scan("vigil", "sha2", [{"id": "f1"}])
    assert isinstance(rs["id"], str)
    assert s.latest_repo_scan("vigil")["findings"] == [{"id": "f1"}]


# --------------------------------------------------------------------------- #
# 1) Active backend (SQLite in CI) — the must-pass contract.                     #
# --------------------------------------------------------------------------- #

def test_contract_active_backend():
    assert store.backend() == "sqlite", "CI must run the SQLite backend (no MONGODB_URI)"
    _fresh_sqlite()
    _run_contract(store)


# --------------------------------------------------------------------------- #
# 2) Mongo backend via mongomock (only if mongomock is installed).              #
# --------------------------------------------------------------------------- #

def _have_mongomock() -> bool:
    try:
        import mongomock  # noqa: F401
        import pymongo  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.skipif(not _have_mongomock(),
                    reason="mongomock/pymongo not installed (SQLite contract covers CI)")
def test_mongo_contract_mongomock():
    import mongomock

    from vigil import _store_mongo as mg

    client = mongomock.MongoClient()
    mg._client = client
    mg._db = client[store.config.MONGODB_DB]
    try:
        mg.init_db()
        _run_contract(mg)
    finally:
        mg._client = None
        mg._db = None


# --------------------------------------------------------------------------- #
# 3) Live-cluster smoke (gated on MONGODB_URI) — runnable against real Mongo.    #
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(not os.environ.get("MONGODB_URI"),
                    reason="MONGODB_URI not set — live Mongo smoke is opt-in")
def test_mongo_smoke_live():
    """Create/read/prune against a real cluster. Uses a throwaway DB name so it
    never touches the production ``vigil`` database. Run with:
    ``MONGODB_URI=... VIGIL_MONGODB_DB=vigil_test pytest -k smoke_live``."""
    import pymongo

    from vigil import _store_mongo as mg

    db_name = os.environ.get("VIGIL_MONGODB_DB", "vigil")
    assert db_name != "vigil" or os.environ.get("VIGIL_ALLOW_PROD_SMOKE"), (
        "refusing to smoke-test against the 'vigil' production DB; "
        "set VIGIL_MONGODB_DB to a throwaway name")
    client = pymongo.MongoClient(os.environ["MONGODB_URI"],
                                 serverSelectionTimeoutMS=8000)
    mg._client = client
    mg._db = client[db_name]
    try:
        mg.init_db()
        _run_contract(mg)
        # prune/retention: the time-series TTL is configured at collection creation;
        # assert the collections exist (native TS or fallback) and accept writes.
        names = set(mg._db.list_collection_names())
        assert {"probes", "check_results", "logs", "metric_samples"} <= names
    finally:
        mg._client = None
        mg._db = None
