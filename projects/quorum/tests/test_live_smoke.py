"""Live smoke + regression tests against a RUNNING quorum service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``QUORUM_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``QUORUM_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The orchestrator runs every agent offline-deterministically with zero keys, so
the contract-review flags and the governance invariants hold against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("QUORUM_BASE_URL", "http://127.0.0.1:8021").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("QUORUM_LIVE") != "1",
    reason="live deploy tests; set QUORUM_LIVE=1 (or use ./run.sh smoke) to run",
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
    """Wrap get/post to retry transient free-tier responses. The deliberate 404
    test targets /trace/<id> (a GET) and still resolves to 404 after retries."""
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
    assert health["workflows"] == 2
    assert health["contracts"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_workflows_listed(client):
    wf = client.get("/workflows").json()["workflows"]
    assert {w["name"] for w in wf} == {"contract-review", "policy-qa"}


def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


# ----------------------------- REGRESSION ----------------------------

def test_regression_review_flags_planted_risks(client):
    r = client.post("/review", json={"contract_id": "saas-002"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["risk_report"]["count"] >= 3
    assert "data_sharing" in out["risk_report"]["by_class"]
    assert out["audit_verified"] is True


def test_regression_trace_has_routing_telemetry(client):
    rid = client.post("/review", json={"contract_id": "msa-001"}).json()["run_id"]
    t = client.get(f"/trace/{rid}").json()
    assert t["audit_verified"] is True
    assert all("provider" in s and "latency_ms" in s for s in t["trace"])


def test_regression_no_raw_pii_in_trace_or_audit(client):
    text = ("CONTRACT: t\n\nClause 1: contact jane.doe@example.com or "
            "acct 4929114450021188.")
    out = client.post("/review", json={"text": text}).json()
    rid = out["run_id"]
    t = client.get(f"/trace/{rid}").json()
    blob = str(out) + str(t)
    assert "jane.doe@example.com" not in blob
    assert "4929114450021188" not in blob


def test_regression_second_workflow_same_engine(client):
    r = client.post("/run", json={
        "workflow": "policy-qa",
        "payload": {"question": "What is the refund window?"}})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["result"].get("grounded") is True
    assert out["audit_verified"] is True


def test_regression_unknown_run_404(client):
    assert client.get("/trace/run-nope").status_code == 404


def test_regression_evals_recall_high(client):
    ev = client.get("/evals").json()
    assert ev["recall"] >= 0.9
    assert ev["pii_leaks_in_audit"] == 0
