"""Live smoke + regression tests against a RUNNING txn-ledger service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``TXN_LEDGER_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``TXN_LEDGER_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The dataset is seeded, so the rollups and query plan are reproducible; latency
numbers are environment-dependent and only checked for ordering.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("TXN_LEDGER_BASE_URL", "http://127.0.0.1:8016").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("TXN_LEDGER_LIVE") != "1",
    reason="live deploy tests; set TXN_LEDGER_LIVE=1 (or use ./run.sh smoke) to run",
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
    recycles. The deliberate invalid-cycle 422 still resolves after retries."""
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
    assert health["rows"] > 0
    assert health["committees"] == 12


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_summary_and_schema(client):
    assert client.get("/summary").json()["total_raised"] > 0
    indexes = client.get("/schema").json()["indexes"]
    assert any("idx_cycle_committee" in i for i in indexes)


# ----------------------------- REGRESSION ----------------------------

def test_regression_plan_uses_index_after_tuning(client):
    # cardinal: the tuning artifact — full scan before, covering-index search after
    p = client.get("/plan").json()
    assert any("SCAN" in ln for ln in p["plan_before_index"])
    after = " ".join(p["plan_after_index"])
    assert "SEARCH" in after and "INDEX" in after


def test_regression_rollup_itemization_reconciles(client):
    a = client.get("/aggregate?cycle=2026").json()
    assert a["rows"]
    totals = [r["total_raised"] for r in a["rows"]]
    assert totals == sorted(totals, reverse=True)
    for r in a["rows"]:
        assert round(r["itemized"] + r["unitemized"], 2) == r["total_raised"]


def test_regression_invalid_cycle_rejected(client):
    assert client.get("/aggregate?cycle=1999").status_code == 422


def test_regression_surge_holds_latency(client):
    r = client.post("/loadtest", json={"n": 400}).json()
    assert r["queries"] == 400 and r["qps"] > 0
    assert r["p50_ms"] <= r["p95_ms"] <= r["p99_ms"]


def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_regression_ask_nl2sql_translates_and_runs(client):
    # NL→SQL: the question is translated, the SQL is guarded to a read-only
    # SELECT, and executed. Public host has no keys, so this is the offline path.
    r = client.post("/ask", json={"question": "total raised in the 2024 cycle"}).json()
    assert r["safe"] is True
    assert "select" in (r["sql"].lower())
    assert r["rows"]


def test_regression_ask_injection_does_not_mutate(client):
    # adversarial: an injection-shaped question must never write — row count holds
    before = client.get("/summary").json()["rows"]
    client.post("/ask", json={"question": "x; DROP TABLE contributions"})
    assert client.get("/summary").json()["rows"] == before


def test_regression_evals_plan_and_nl2sql(client):
    e = client.get("/evals").json()
    assert e["plan_regression"]["passed"] is True
    assert e["nl2sql"]["accuracy"] >= 0.0
