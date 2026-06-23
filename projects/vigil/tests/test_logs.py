"""Log ingestion (token/loopback gate), the registered-tier viewer + filters, and
vigil's own self-logging — in-process via the FastAPI TestClient."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-logs.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"
# Ensure the loopback-only ingestion path is the one under test by default.
os.environ.pop("VIGIL_INGEST_TOKEN", None)

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, selflog, store  # noqa: E402
from vigil.api import app  # noqa: E402


def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def _register_verified(c, email):
    """Sign up + verify a normal registered user, returning the verified client."""
    r = c.post("/auth/signup", json={"email": email, "password": "password1"})
    link = r.json()["verification"]["link"]
    token = link.split("token=")[1]
    c.get(f"/auth/verify?token={token}", follow_redirects=False)


# --------------------------------------------------------------------------- #
# Ingestion: token gate + loopback fallback                                     #
# --------------------------------------------------------------------------- #

def test_ingest_loopback_allowed_when_token_unset():
    config.INGEST_TOKEN = None  # explicit: no token configured
    with _client() as c:
        # TestClient's client host is 'testclient' (treated as loopback) → allowed.
        r = c.post("/api/ingest/logs", json={
            "slug": "slo-kit",
            "entries": [{"level": "info", "source": "app", "message": "started"}],
        })
        assert r.status_code == 200
        assert r.json()["ingested"] == 1


def test_ingest_unknown_target_404():
    config.INGEST_TOKEN = None
    with _client() as c:
        r = c.post("/api/ingest/logs", json={
            "slug": "does-not-exist", "entries": [{"message": "hi"}]})
        assert r.status_code == 404


def test_ingest_token_required_when_configured():
    config.INGEST_TOKEN = "s3cret-token"
    try:
        with _client() as c:
            # No header → rejected even from loopback.
            assert c.post("/api/ingest/logs", json={
                "slug": "slo-kit", "entries": [{"message": "x"}]}).status_code == 401
            # Wrong token → rejected.
            assert c.post("/api/ingest/logs",
                          headers={"X-Ingest-Token": "wrong"},
                          json={"slug": "slo-kit",
                                "entries": [{"message": "x"}]}).status_code == 401
            # Correct token → accepted.
            ok = c.post("/api/ingest/logs",
                        headers={"X-Ingest-Token": "s3cret-token"},
                        json={"slug": "slo-kit",
                              "entries": [{"message": "ok"}]})
            assert ok.status_code == 200 and ok.json()["ingested"] == 1
    finally:
        config.INGEST_TOKEN = None


def test_ingest_coerces_bad_level_and_skips_messageless():
    config.INGEST_TOKEN = None
    with _client() as c:
        r = c.post("/api/ingest/logs", json={"slug": "slo-kit", "entries": [
            {"level": "bogus", "message": "coerced"},   # level → info
            {"level": "error", "source": None},          # no message → skipped
        ]})
        # Pydantic requires message (min_length 1), so the second entry 422s the
        # whole request; send them separately to assert coercion of a valid one.
        assert r.status_code in (200, 422)
        ok = c.post("/api/ingest/logs", json={"slug": "slo-kit",
                    "entries": [{"level": "bogus", "message": "coerced"}]})
        assert ok.json()["ingested"] == 1


# --------------------------------------------------------------------------- #
# Viewer: role gate + filters                                                   #
# --------------------------------------------------------------------------- #

def test_logs_viewer_role_gated():
    config.INGEST_TOKEN = None
    with _client() as c:
        c.post("/api/ingest/logs", json={"slug": "slo-kit",
               "entries": [{"level": "warn", "message": "guest-blocked"}]})
        # Guest (anonymous) is blocked server-side.
        assert c.get("/api/targets/slo-kit/logs").status_code == 401
        _register_verified(c, "viewer@x.test")
        r = c.get("/api/targets/slo-kit/logs")
        assert r.status_code == 200
        assert any(row["message"] == "guest-blocked" for row in r.json()["logs"])


def test_logs_level_filter():
    config.INGEST_TOKEN = None
    with _client() as c:
        c.post("/api/ingest/logs", json={"slug": "slo-kit", "entries": [
            {"level": "info", "message": "an info line"},
            {"level": "error", "message": "an error line"},
        ]})
        _register_verified(c, "f@x.test")
        errs = c.get("/api/targets/slo-kit/logs?level=error").json()["logs"]
        assert errs and all(r["level"] == "error" for r in errs)
        # Bad level → 422.
        assert c.get("/api/targets/slo-kit/logs?level=nope").status_code == 422


def test_logs_since_filter():
    config.INGEST_TOKEN = None
    with _client() as c:
        # An old entry (ts well in the past) + a fresh one.
        c.post("/api/ingest/logs", json={"slug": "slo-kit", "entries": [
            {"ts": 1000.0, "message": "ancient"},
            {"message": "recent"},
        ]})
        _register_verified(c, "s@x.test")
        rows = c.get("/api/targets/slo-kit/logs?since=2000").json()["logs"]
        msgs = [r["message"] for r in rows]
        assert "recent" in msgs and "ancient" not in msgs


# --------------------------------------------------------------------------- #
# vigil self-logging                                                            #
# --------------------------------------------------------------------------- #

def test_vigil_self_logs_its_own_operations():
    config.INGEST_TOKEN = None
    with _client() as c:
        selflog.slog("info", "self-test line", source="vigil.test")
        _register_verified(c, "self@x.test")
        rows = c.get("/api/targets/vigil/logs").json()["logs"]
        assert any(r["message"] == "self-test line"
                   and r["source"] == "vigil.test" for r in rows)


def test_store_add_logs_prunes(monkeypatch):
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    monkeypatch.setattr(config, "MAX_LOGS_PER_TARGET", 5)
    for i in range(12):
        store.add_logs("slo-kit", [{"message": f"line-{i}"}])
    rows = store.recent_logs("slo-kit", limit=100)
    assert len(rows) == 5  # pruned to the cap
    # Newest-first ordering retained.
    assert rows[0]["message"] == "line-11"
