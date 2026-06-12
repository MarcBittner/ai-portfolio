"""Live smoke + regression tests against a RUNNING reconcile service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``RECONCILE_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``RECONCILE_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Assertions force the deterministic parser (``use_llm=false``), so the verdicts,
recoverable totals and eval numbers are reproducible regardless of LLM backend.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("RECONCILE_BASE_URL", "http://127.0.0.1:8009").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("RECONCILE_LIVE") != "1",
    reason="live deploy tests; set RECONCILE_LIVE=1 (or use ./run.sh smoke) to run",
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


def _analyze(client, sample, **extra):
    r = client.post("/analyze", json={"sample": sample, "use_llm": False, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["baseline_lines"] > 0
    assert health["market_codes"] > 0
    assert health["samples"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_samples_baseline_rates(client):
    assert client.get("/samples").json()[0]["name"]
    assert client.get("/baseline").json()["lines"]
    assert client.get("/rates").json()["rates"]


def test_smoke_analyze_returns_report(client):
    b = _analyze(client, "change-order-overcharged")
    assert b["lines"] and "summary" in b and "review_queue" in b


# ----------------------------- REGRESSION ----------------------------

def test_regression_overcharged_flags_and_recovers(client):
    b = _analyze(client, "change-order-overcharged")
    assert b["summary"]["flagged_over"] == 3
    assert b["summary"]["recoverable_total"] > 0
    assert b["review_queue"]["count"] >= 3


def test_regression_clean_order_is_all_ok(client):
    b = _analyze(client, "change-order-clean")
    assert b["summary"]["flagged_over"] == 0
    assert b["summary"]["recoverable_total"] == 0


def test_regression_recoverable_lines_need_review(client):
    # cardinal money-path invariant across every sample
    samples = ("change-order-clean", "change-order-overcharged", "change-order-ambiguous")
    for sample in samples:
        for ln in _analyze(client, sample)["lines"]:
            if ln["recoverable"] > 0:
                assert ln["needs_review"] is True, ln


def test_regression_is_deterministic(client):
    a = _analyze(client, "change-order-overcharged")
    b = _analyze(client, "change-order-overcharged")
    assert a["summary"] == b["summary"]
    assert [ln["verdict"] for ln in a["lines"]] == [ln["verdict"] for ln in b["lines"]]


def test_regression_eval_has_teeth(client):
    agg = client.get("/eval").json()["aggregate"]
    assert agg["precision"] == 1.0
    assert agg["recall"] < 1.0


def test_regression_unknown_sample_rejected(client):
    assert client.post("/analyze", json={"sample": "no-such-sample"}).status_code == 404


def test_regression_missing_input_rejected(client):
    assert client.post("/analyze", json={"use_llm": False}).status_code == 422
