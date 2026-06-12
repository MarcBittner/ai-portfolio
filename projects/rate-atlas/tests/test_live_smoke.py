"""Live smoke + regression tests against a RUNNING rate-atlas service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``RATE_ATLAS_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``RATE_ATLAS_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Ingest, normalization, and comparison are deterministic, so these hold against
any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("RATE_ATLAS_BASE_URL", "http://127.0.0.1:8014").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("RATE_ATLAS_LIVE") != "1",
    reason="live deploy tests; set RATE_ATLAS_LIVE=1 (or use ./run.sh smoke) to run",
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
    recycles. The deliberate /compare/00000 404 still resolves after retries."""
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


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["sources"] > 0
    assert health["total_rows"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_sources_and_procedures(client):
    assert client.get("/sources").json()["sources"]
    assert client.get("/procedures").json()["procedures"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_three_distinct_shapes_normalized(client):
    # cardinal: differently-shaped files all land in one model
    shapes = {s["shape"] for s in client.get("/sources").json()["sources"]}
    assert {"cms_nested_json", "flat_json", "pipe_csv"} <= shapes


def test_regression_compare_shows_cross_payer_spread(client):
    b = client.get("/compare/70450").json()
    assert b["stats"]["spread_pct"] > 0                       # rates actually differ
    assert b["quotes"] == sorted(b["quotes"], key=lambda q: q["rate"])
    assert len({q["hospital"] for q in b["quotes"]}) >= 2     # across hospitals


def test_regression_is_deterministic(client):
    a = client.get("/compare/70450").json()["stats"]
    b = client.get("/compare/70450").json()["stats"]
    assert a == b


def test_regression_outliers_have_z(client):
    for o in client.get("/outliers?threshold=2.0").json()["outliers"]:
        assert abs(o["zscore"]) >= 2.0


def test_regression_unknown_code_404(client):
    assert client.get("/compare/00000").status_code == 404
