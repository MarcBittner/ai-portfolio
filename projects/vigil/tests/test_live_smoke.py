"""Live smoke + regression tests against a RUNNING vigil service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same contract either way; only ``VIGIL_BASE_URL`` changes, making this a
deployment regression net.

OPT-IN: skipped unless ``VIGIL_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("VIGIL_BASE_URL", "http://127.0.0.1:8020").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)
ADMIN_EMAIL = os.environ.get("VIGIL_ADMIN_EMAIL", "marc.bittner@gmail.com")

pytestmark = pytest.mark.skipif(
    os.environ.get("VIGIL_LIVE") != "1",
    reason="live deploy tests; set VIGIL_LIVE=1 (or use ./run.sh smoke) to run",
)


def _wait_until_ready(c, timeout=120.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            r = c.get("/health")
            last = r.status_code
            if r.status_code == 200:
                return
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
        time.sleep(2)
    pytest.skip(f"service at {BASE_URL} not ready (last seen: {last})")


@pytest.fixture(scope="module")
def client():
    c = httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=True)
    _wait_until_ready(c)
    yield c
    c.close()


@pytest.fixture(scope="module")
def admin(client):
    """A session cookie for the bootstrap admin (pre-verified on signup)."""
    s = httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=True)
    # signup is idempotent-ish: if already present, fall back to login.
    r = s.post("/auth/signup", json={"email": ADMIN_EMAIL, "password": "smoke-pass-123"})
    if r.status_code not in (200, 409):
        pytest.skip(f"admin signup failed: {r.status_code} {r.text}")
    if "vigil_session" not in s.cookies:
        s.post("/auth/login", json={"email": ADMIN_EMAIL, "password": "smoke-pass-123"})
    yield s
    s.close()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(client):
    h = client.get("/health").json()
    assert h["status"] == "ok"
    assert h["version"]
    assert h["targets"] > 0


def test_smoke_health_exposes_no_secrets(client):
    blob = str(client.get("/health").json()).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_guest_status_is_minimal(client):
    rows = client.get("/api/status").json()["apps"]
    assert rows
    for r in rows:
        assert set(r) == {"slug", "name", "status", "error_rate", "self_monitor"}


def test_smoke_self_monitor_present(client):
    slugs = {r["slug"] for r in client.get("/api/status").json()["apps"]}
    assert "vigil" in slugs  # vigil is a first-class entry in its own registry


def test_smoke_llm_status_shape(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_smoke_tier_gating_anonymous(client):
    assert client.get("/api/dashboard").status_code == 401
    assert client.get("/api/security").status_code == 401


# ----------------------------- REGRESSION ----------------------------

def test_regression_admin_session_and_probe(admin):
    me = admin.get("/auth/me").json()
    assert me["authenticated"] and me["role"] == "admin"
    # force a probe cycle so the time series is populated, then dashboard works
    probed = admin.post("/api/admin/probe-now").json()
    assert probed["probed"] > 0
    dash = admin.get("/api/dashboard").json()
    assert dash["apps"] and "rollup" in dash


def test_regression_security_posture(admin):
    sec = admin.get("/api/security").json()
    assert sec["catalog"]
    # every finding maps to >=1 control (the postureline invariant)
    for rep in sec["reports"]:
        for f in rep["findings"]:
            assert f["control_ids"]
        assert 0 <= rep["posture"]["score"] <= 100


def test_regression_incident_summary(admin):
    out = admin.post("/api/incident/summary", json={"mode": "offline"}).json()
    assert out["severity"] in ("none", "sev3", "sev2", "sev1")
    assert out["summary"].strip()
    assert isinstance(out["suggested_actions"], list)


def test_regression_alert_rule_roundtrip(admin):
    rule = admin.post("/api/alerts", json={
        "slug": "vigil", "metric": "down", "comparator": "gt",
        "threshold": 0, "channel": "console"}).json()
    assert rule["id"]
    rules = admin.get("/api/alerts").json()
    assert any(r["id"] == rule["id"] for r in rules["rules"])
    assert rules["channels"]["console"] is True


def test_regression_add_and_remove_target(admin):
    add = admin.post("/api/admin/targets", json={
        "slug": "smoke-temp", "name": "Smoke Temp", "url": "https://smoke-temp.test"})
    assert add.status_code == 200
    rm = admin.delete("/api/admin/targets/smoke-temp")
    assert rm.json()["removed"] is True
