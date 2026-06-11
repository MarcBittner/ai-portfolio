"""Live smoke + regression tests against a RUNNING forecast service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``FORECAST_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``FORECAST_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The classic-stats core is fully deterministic (``use_llm=false`` drops only the
NL summary), so horizons, band ordering and anomaly indices are pinned.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("FORECAST_BASE_URL", "http://127.0.0.1:8007").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("FORECAST_LIVE") != "1",
    reason="live deploy tests; set FORECAST_LIVE=1 (or use ./run.sh smoke) to run",
)

SERIES = [10.0, 12.0, 11.0, 13.0, 14.0, 15.0, 14.0, 16.0, 17.0, 18.0]


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
    return intermittent 404/5xx while it recycles). Deliberate-error assertions
    still observe their real status once the retries settle."""
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


def _forecast(client, series=SERIES, horizon=3, **extra):
    r = client.post(
        "/forecast",
        json={
            "series": series, "horizon": horizon, "method": "auto",
            "use_llm": False, **extra,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["methods"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_methods_listed(client):
    r = client.get("/methods")
    assert r.status_code == 200
    names = [m["name"] for m in r.json()]
    assert "auto" in names and len(names) > 1


def test_smoke_forecast_returns_horizon(client):
    body = _forecast(client, horizon=4)
    assert len(body["forecast"]) == 4
    assert isinstance(body["method"], str) and body["method"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_band_ordering(client):
    body = _forecast(client, horizon=5)
    for lo, mid, hi in zip(body["lower"], body["forecast"], body["upper"], strict=True):
        assert lo <= mid <= hi, (lo, mid, hi)


def test_regression_no_summary_when_llm_off(client):
    body = _forecast(client)
    assert body["summary"] in (None, "")  # NL summary requires use_llm=true


def test_regression_is_deterministic(client):
    a = _forecast(client, horizon=5)
    b = _forecast(client, horizon=5)
    assert a["method"] == b["method"]
    assert a["forecast"] == b["forecast"]


def test_regression_anomaly_flags_spike(client):
    # the detector scores each point against the *prior* window; a flat baseline
    # has zero variance (sd=0 → skipped), so use a small-variance baseline with a
    # clear outlier at index 8.
    series = [10.0, 11.0, 9.0, 10.5, 9.5, 10.0, 11.0, 9.0, 100.0, 10.0, 10.5, 9.5]
    r = client.post("/anomalies", json={"series": series, "window": 5, "threshold": 3.0})
    assert r.status_code == 200, r.text
    flagged = {a["index"] for a in r.json()["anomalies"]}
    assert 8 in flagged, flagged


def test_regression_short_series_rejected(client):
    r = client.post("/forecast", json={"series": [1.0], "horizon": 2})
    assert r.status_code == 422  # min_length=2
