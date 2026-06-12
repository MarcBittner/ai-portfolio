"""Live smoke + regression tests against a RUNNING slo-kit service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``SLO_KIT_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``SLO_KIT_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Traffic and faults are simulated and deterministic, so the SLO math and the
burn/recover behavior are reproducible against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("SLO_KIT_BASE_URL", "http://127.0.0.1:8011").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("SLO_KIT_LIVE") != "1",
    reason="live deploy tests; set SLO_KIT_LIVE=1 (or use ./run.sh smoke) to run",
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
    """Wrap get/post to retry transient free-tier responses (an instance can
    return intermittent 404/5xx while it recycles). Note: /v1/messages legitimately
    returns 500 under an injected fault, but the smoke suite never injects one
    before calling it, so retrying 500 here is safe."""
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
    _wait_until_ready(c)  # warm the service; wait out free-tier cold starts
    _install_retry(c)
    yield c
    c.close()


@pytest.fixture(scope="module")
def health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    return r.json()


def _reset(client):
    r = client.post("/admin/reset")
    assert r.status_code == 200, r.text
    return r.json()


def _loadtest(client, n, **extra):
    r = client.post("/admin/loadtest", json={"n": n, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["slo_status"] in ("healthy", "no_data", "at_risk")


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_metrics_and_slo_shapes(client):
    assert "slo_requests_total" in client.get("/metrics").text
    s = client.get("/slo").json()
    assert {"availability", "latency", "overall_status"} <= set(s)


def test_smoke_traffic_produces_traces(client):
    _reset(client)
    _loadtest(client, 20)
    assert client.get("/traces").json()["spans"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_steady_traffic_is_healthy(client):
    _reset(client)
    snap = _loadtest(client, 300)
    assert snap["overall_status"] == "healthy"
    assert snap["availability"]["budget_remaining"] == 1.0


def test_regression_incident_burns_budget(client):
    _reset(client)
    client.post("/admin/fault", json={"error_rate": 0.5, "latency_ms": 500})
    snap = _loadtest(client, 300)
    assert snap["overall_status"] == "at_risk"
    assert snap["availability"]["burn_rate"] > 1
    assert snap["availability"]["budget_remaining"] < 1.0
    assert snap["latency"]["status"] == "violated"


def test_regression_recovers_after_reset(client):
    # cardinal: clearing the fault + a fresh window returns the SLO to healthy
    client.post("/admin/fault", json={"error_rate": 0.5})
    _loadtest(client, 50)
    recovered = _reset(client)
    assert recovered["slo"]["overall_status"] == "healthy"
    assert _loadtest(client, 200)["overall_status"] == "healthy"


def test_regression_fault_validation(client):
    r = client.post("/admin/fault", json={"error_rate": 2.0})
    assert r.status_code == 422
    _reset(client)  # leave the live service clean for the next run
