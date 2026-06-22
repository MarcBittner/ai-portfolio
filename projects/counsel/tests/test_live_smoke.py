"""Live smoke + regression tests against a RUNNING counsel service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``COUNSEL_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``COUNSEL_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The dataset, grounding, verification, and trust gate are deterministic, so these
hold against any instance.
"""
from __future__ import annotations

import contextlib
import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("COUNSEL_BASE_URL", "http://127.0.0.1:8025").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("COUNSEL_LIVE") != "1",
    reason="live deploy tests; set COUNSEL_LIVE=1 (or use ./run.sh smoke) to run",
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


def _install_retry(c, tries=4, statuses=(404, 500, 502, 503, 504)):
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

    c.get = lambda url, **kw: _retry("GET", url, **kw)
    c.post = lambda url, **kw: _retry("POST", url, **kw)


@pytest.fixture(scope="module")
def client():
    c = httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=True)
    _wait_until_ready(c)
    _install_retry(c)
    # start each run from a clean queue (best-effort)
    with contextlib.suppress(Exception):
        c.post("/admin/reset_queue")
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
    assert health["accounts"] > 0 and health["transactions"] > 0
    assert health["offline_fallback"] is True


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-"):
        assert token not in blob


def test_smoke_llm_status(client):
    b = client.get("/llm").json()
    assert set(b["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert b["offline_fallback"] is True


# ----------------------------- REGRESSION ----------------------------

def test_regression_grounded_answer_verifies(client):
    b = client.post("/ask", json={"question": "What's my net worth?",
                                  "mode": "offline"}).json()
    assert b["refused"] is False
    assert b["intent"] == "net_worth"
    assert b["verified_ok"] is True
    assert b["citations"]


def test_regression_ungrounded_refuses(client):
    b = client.post("/ask", json={"question": "What's my credit score?",
                                  "mode": "offline"}).json()
    assert b["refused"] is True
    assert b["refusal_reason"] == "ungrounded"


def test_regression_guardrail_refuses(client):
    b = client.post("/ask", json={"question": "Which stock should I buy?",
                                  "mode": "offline"}).json()
    assert b["refused"] is True
    assert b["refusal_reason"].startswith("guardrail")


def test_regression_diagnostics_offline_all_pass(client):
    m = client.get("/diagnostics?mode=offline").json()["modes"]["offline"]
    assert m["passed"] == m["total"]
    assert m["grounded_verified"] == m["grounded_total"]


def test_regression_trust_gate_holds_over_http(client):
    client.post("/admin/reset_queue")
    p = client.post("/propose", json={"kind": "flag_charge"}).json()["proposal"]
    assert p["status"] == "pending"
    done = client.post("/decide", json={"id": p["id"], "approve": True}
                       ).json()["proposal"]
    assert done["status"] == "applied"
    assert done["effect"]["real_money_moved"] is False
    # double-decide refused
    r = client.post("/decide", json={"id": p["id"], "approve": False})
    assert r.status_code == 409
    client.post("/admin/reset_queue")


def test_regression_is_deterministic(client):
    body = {"question": "How much did I spend on dining last month?",
            "mode": "offline"}
    a = client.post("/ask", json=body).json()
    b = client.post("/ask", json=body).json()
    assert a["answer"] == b["answer"]
