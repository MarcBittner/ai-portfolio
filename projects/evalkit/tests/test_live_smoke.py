"""Live smoke + regression tests against a RUNNING evalkit service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``EVALKIT_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``EVALKIT_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The exact-match metric is fully deterministic, so the scores are pinned exactly.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("EVALKIT_BASE_URL", "http://127.0.0.1:8002").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("EVALKIT_LIVE") != "1",
    reason="live deploy tests; set EVALKIT_LIVE=1 (or use ./run.sh smoke) to run",
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


@pytest.fixture(scope="module")
def exact_metric(client):
    """Discover the deterministic exact-match metric's name (don't hard-code it)."""
    r = client.get("/metrics")
    assert r.status_code == 200, r.text
    names = [m["name"] for m in r.json() if m.get("source") != "llm"]
    for n in names:
        if "exact" in n.lower():
            return n
    pytest.skip(f"no exact-match metric among {names}")


def _evaluate(client, items, **extra):
    r = client.post("/evaluate", json={"items": items, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["metrics"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_metrics_listed(client):
    r = client.get("/metrics")
    assert r.status_code == 200
    metrics = r.json()
    assert isinstance(metrics, list) and metrics
    for m in metrics:
        assert m["name"] and m["description"] and m["source"]


def test_smoke_evaluate_returns_scores(client, exact_metric):
    body = _evaluate(
        client, [{"prediction": "cat", "reference": "cat"}], metrics=[exact_metric]
    )
    assert body["n"] == 1
    assert exact_metric in body["aggregate"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_exact_match_scores_are_pinned(client, exact_metric):
    # one hit, one miss → per-item 1.0 / 0.0, aggregate exactly 0.5 (deterministic)
    items = [
        {"prediction": "cat", "reference": "cat"},
        {"prediction": "dog", "reference": "wolf"},
    ]
    body = _evaluate(client, items, metrics=[exact_metric])
    assert body["n"] == 2
    by_index = {p["index"]: p["scores"][exact_metric] for p in body["per_item"]}
    assert by_index[0] == 1.0
    assert by_index[1] == 0.0
    assert body["aggregate"][exact_metric] == 0.5


def test_regression_gate_fails_below_threshold(client, exact_metric):
    items = [
        {"prediction": "cat", "reference": "cat"},
        {"prediction": "dog", "reference": "wolf"},
    ]
    body = _evaluate(
        client, items, metrics=[exact_metric], thresholds={exact_metric: 0.9}
    )
    assert body["gate"] is not None
    assert body["gate"]["passed"] is False  # 0.5 < 0.9


def test_regression_unknown_metric_rejected(client):
    r = client.post(
        "/evaluate",
        json={
            "items": [{"prediction": "a", "reference": "a"}],
            "metrics": ["no_such_metric"],
        },
    )
    assert r.status_code == 422


def test_regression_empty_items_rejected(client):
    r = client.post("/evaluate", json={"items": []})
    assert r.status_code == 422
