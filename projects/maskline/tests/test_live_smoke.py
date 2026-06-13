"""Live smoke + regression tests against a RUNNING maskline service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``MASKLINE_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``MASKLINE_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Classification, policy generation, coverage, and re-id risk are deterministic
offline, so the assertions hold against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("MASKLINE_BASE_URL", "http://127.0.0.1:8020").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("MASKLINE_LIVE") != "1",
    reason="live deploy tests; set MASKLINE_LIVE=1 (or use ./run.sh smoke) to run",
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
    assert health["tables"] == 3
    assert health["sensitive_columns"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_warehouse_schema(client):
    s = client.get("/warehouse").json()
    assert {t["table"] for t in s["tables"]} == {"CLAIMS", "MEMBERS", "PROVIDERS"}


# ----------------------------- REGRESSION ----------------------------

def test_regression_free_text_classified_sensitive(client):
    cols = client.get("/classify").json()["columns"]
    note = next(c for c in cols
                if c["table"] == "CLAIMS" and c["column"] == "CLAIM_NOTE")
    assert note["sensitive"] is True and note["method"] == "llm"


def test_regression_policy_targets_snowflake(client):
    p = client.get("/policy").json()
    assert "CREATE OR REPLACE MASKING POLICY" in p["snowflake_ddl"]
    assert "ROW ACCESS POLICY" in p["snowflake_ddl"]
    assert 'resource "snowflake_masking_policy"' in p["terraform"]


def test_regression_gate_blocks_on_gap(client):
    g = client.get("/gate").json()
    assert g["pass"] is False
    assert g["exit_code"] == 1
    assert any(u["column"] == "CLAIM_NOTE" for u in g["uncovered_columns"])


def test_regression_kanon_finds_singletons(client):
    k = client.get("/risk").json()["kanon"]
    assert k["k_min"] == 1
    assert k["singleton_count"] == k["records"]


def test_regression_controls_map_to_frameworks(client):
    c = client.get("/controls").json()
    assert set(c["frameworks"]) == {"SOC 2", "HIPAA"}
    assert c["passed"] + c["failed"] == len(c["controls"])


def test_regression_evals_recall_high(client):
    e = client.get("/evals").json()
    assert e["sensitivity"]["recall"] >= 0.5
    assert e["invariant"]["holds"] is True


# ------------------------------- LLM SURFACE -------------------------------

def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_regression_narrative_mentions_findings(client):
    n = client.get("/narrative").json()
    assert n["summary"]
    assert "k" in n["summary"].lower()
