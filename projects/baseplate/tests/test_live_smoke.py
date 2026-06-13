"""Live smoke + regression tests against a RUNNING baseplate service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``BASEPLATE_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``BASEPLATE_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Scaffolding, ingest scoring, and the SLO view are deterministic, so the
assertions hold against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("BASEPLATE_BASE_URL", "http://127.0.0.1:8024").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("BASEPLATE_LIVE") != "1",
    reason="live deploy tests; set BASEPLATE_LIVE=1 (or use ./run.sh smoke) to run",
)


def _wait_until_ready(c, timeout=120.0):
    """Poll /health until 200, tolerating free-tier cold-start 404/5xx."""
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
    """Wrap get/post to retry transient free-tier responses. The deliberate 400
    test targets POST /scaffold and still resolves after retries."""
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
    c.post("/admin/reset")
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
    assert health["catalog"] >= 2
    assert health["modules"] >= 1


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_catalog_seeded(client):
    names = {s["name"] for s in client.get("/catalog").json()["services"]}
    assert "rate-ingest" in names


def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


# ----------------------------- REGRESSION ----------------------------

def test_regression_scaffold_generates_valid_files(client):
    r = client.post("/scaffold", json={
        "description": "A Python FastAPI service called rate-ingest that reads "
                       "rates from Postgres and serves them over HTTP"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["spec"]["name"] == "rate-ingest"
    assert "Dockerfile" in body["files"]
    assert "deploy/k8s/rate-ingest.yaml" in body["files"]


def test_regression_scaffold_requires_input(client):
    assert client.post("/scaffold", json={}).status_code == 400


def test_regression_data_quality_sli(client):
    q = client.get("/quality").json()
    assert q["rows"] > 0
    assert 0.0 <= q["data_quality_pass_rate"] <= 1.0


def test_regression_slo_has_data_quality(client):
    v = client.get("/slo").json()
    names = {s["name"] for s in v["slos"]}
    assert "data-quality" in names


def test_regression_evals_pass(client):
    r = client.get("/evals").json()
    assert r["scaffold_pass"] == r["scaffold_total"]
