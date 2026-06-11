"""Live smoke + regression tests against a RUNNING agent-sandbox service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. The same assertions run either way; only ``AGENT_SANDBOX_BASE_URL``
changes, making this a deployment regression net.

OPT-IN: skipped unless ``AGENT_SANDBOX_LIVE=1`` so ``./run.sh test`` stays fast
and network-free.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Assertions force the deterministic rule planner (``use_llm=false``) so they are
reproducible regardless of LLM backend.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("AGENT_SANDBOX_BASE_URL", "http://127.0.0.1:8004").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("AGENT_SANDBOX_LIVE") != "1",
    reason="live deploy tests; set AGENT_SANDBOX_LIVE=1 (or use ./run.sh smoke) to run",
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


def _run(client, query, **extra):
    r = client.post("/run", json={"query": query, "use_llm": False, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["tools"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_tools_listed(client):
    r = client.get("/tools")
    assert r.status_code == 200
    tools = r.json()
    assert isinstance(tools, list) and len(tools) >= 4
    for t in tools:
        assert t["name"] and t["description"]


def test_smoke_run_returns_answer(client):
    body = _run(client, "What is 2 + 2?")
    assert isinstance(body["answer"], str) and body["answer"].strip()
    assert isinstance(body["steps"], list)


# ----------------------------- REGRESSION ----------------------------

def test_regression_offline_uses_rule_planner(client):
    body = _run(client, "Convert 10 km to miles.")
    assert body["planner"] == "rule", body


def test_regression_trace_is_well_formed(client):
    body = _run(client, "What is 6 * 7?")
    assert body["n_steps"] == len(body["steps"])
    for s in body["steps"]:
        assert set(s) >= {"thought", "tool", "args", "observation", "ok"}
        assert isinstance(s["ok"], bool)
        assert isinstance(s["args"], dict)


def test_regression_is_deterministic(client):
    a = _run(client, "What is 100 - 58?")
    b = _run(client, "What is 100 - 58?")
    assert a["answer"] == b["answer"]
    assert a["n_steps"] == b["n_steps"]


def test_regression_unknown_provider_rejected(client):
    r = client.post("/run", json={"query": "hi", "provider": "no-such-provider"})
    assert r.status_code == 422
