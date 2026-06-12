"""Live smoke + regression tests against a RUNNING attack-surface service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``ATTACK_SURFACE_BASE_URL`` changes,
making this a deployment regression net. Exercises fixture mode only (the hosted
demo's default — no outbound scanning).

OPT-IN: skipped unless ``ATTACK_SURFACE_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("ATTACK_SURFACE_BASE_URL", "http://127.0.0.1:8015").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("ATTACK_SURFACE_LIVE") != "1",
    reason="live deploy tests; set ATTACK_SURFACE_LIVE=1 (or use ./run.sh smoke) to run",
)


def _wait_until_ready(c, timeout=120.0):
    """Poll /health until 200, tolerating free-tier cold-start 404/5xx and
    transient edge errors while a sleeping instance spins up."""
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


def _install_retry(c, tries=4, statuses=(404, 500, 502, 503, 504)):
    """Wrap get/post to retry transient free-tier responses while an instance
    recycles. Deliberate-error assertions still see their real status."""
    raw = c.request

    def _retry(method, url, **kw):
        resp = None
        for _ in range(tries):
            try:
                resp = raw(method, url, **kw)
                if resp.status_code not in statuses:
                    return resp
            except Exception:  # noqa: BLE001
                resp = None
            time.sleep(1.0)
        return resp if resp is not None else raw(method, url, **kw)

    def _get(url, **kw):
        return _retry("GET", url, **kw)

    def _post(url, **kw):
        return _retry("POST", url, **kw)

    c.get = _get
    c.post = _post


@pytest.fixture(scope="module")
def client():
    c = httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=True)
    _wait_until_ready(c)
    _install_retry(c)
    yield c
    c.close()


@pytest.fixture(scope="module")
def health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def report(client):
    r = client.get("/scan")
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["controls"] > 0
    assert health["fixture_findings"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_controls_catalog(client):
    fw = {c["framework"] for c in client.get("/controls").json()["controls"]}
    assert {"SOC 2", "ISO 27001"} <= fw


def test_smoke_scan_returns_report(report):
    assert report["findings"] and report["posture"]["grade"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_governed_evidence(report):
    # cardinal GRC invariant: every finding maps to a control, and every failing
    # control traces back to its findings (no orphan evidence either way).
    assert all(f["controls"] for f in report["findings"])
    for c in report["controls"]:
        if c["status"] == "fail":
            assert c["finding_count"] == len(c["findings"]) >= 1


def test_regression_critical_findings_present(report):
    rules = {f["rule_id"] for f in report["findings"] if f["severity"] == "critical"}
    assert {"ADMIN_NO_AUTH", "DB_EXPOSED"} <= rules


def test_regression_posture_rolls_up(report):
    p = report["posture"]
    assert 1 <= p["controls_failing"] <= p["controls_total"]
    assert sum(report["severity_counts"].values()) == len(report["findings"])


def test_regression_is_deterministic(client):
    a, b = client.get("/scan").json(), client.get("/scan").json()
    assert a["posture"] == b["posture"]
    assert a["severity_counts"] == b["severity_counts"]


def test_regression_invalid_mode_rejected(client):
    assert client.post("/scan", json={"mode": "aggressive"}).status_code == 422
