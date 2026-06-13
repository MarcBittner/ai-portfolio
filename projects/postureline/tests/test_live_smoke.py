"""Live smoke + regression tests against a RUNNING postureline service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``POSTURELINE_BASE_URL`` changes, making
this a deployment regression net for BOTH surfaces.

OPT-IN: skipped unless ``POSTURELINE_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Everything trust-critical (classification, policy, coverage, k-anon, fingerprint,
posture, crosswalk) is deterministic offline, so the assertions hold against any
instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get(
    "POSTURELINE_BASE_URL", "http://127.0.0.1:8025").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("POSTURELINE_LIVE") != "1",
    reason="live deploy tests; set POSTURELINE_LIVE=1 (or use ./run.sh smoke) to run",
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
    yield c
    c.close()


@pytest.fixture(scope="module")
def health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok" and health["version"]
    assert set(health["surfaces"]) == {"warehouse", "exposure"}
    assert health["frameworks"] == 6


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_both_surfaces_scan(client):
    for surface in ("warehouse", "exposure"):
        b = client.get(f"/scan/{surface}").json()
        assert b["surface"] == surface and b["findings"]
        assert all(f["control_ids"] for f in b["findings"])


# ----------------------------- REGRESSION ----------------------------

def test_regression_warehouse_policy_and_gate(client):
    p = client.get("/policy").json()
    assert "CREATE OR REPLACE MASKING POLICY" in p["snowflake_ddl"]
    assert 'resource "snowflake_masking_policy"' in p["terraform"]
    g = client.get("/gate", params={"surface": "warehouse"}).json()
    assert g["pass"] is False and g["exit_code"] == 1
    assert any(u["column"] == "CLAIM_NOTE" for u in g["uncovered_columns"])


def test_regression_warehouse_kanon(client):
    k = client.get("/privacy").json()["kanon"]
    assert k["k_min"] == 1 and k["singleton_count"] == k["records"]


def test_regression_exposure_diff_improves(client):
    d = client.get("/diff", params={"surface": "exposure"}).json()
    assert d["after"]["posture"]["score"] > d["before"]["posture"]["score"]
    assert {"DB_EXPOSED", "ADMIN_EXPOSED"} <= set(d["fixed_findings"])


def test_regression_controls_six_frameworks(client):
    c = client.get("/controls", params={"surface": "exposure"}).json()
    assert len(c["framework_rollup"]) == 6


def test_regression_evals_cover_both(client):
    e = client.get("/evals").json()
    assert e["warehouse"]["sensitivity"]["recall"] >= 0.5
    assert e["exposure"]["narrative"]["criticals_covered"] is True


# ------------------------------- LLM SURFACE -------------------------------

def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_regression_board_report_covers_criticals(client):
    n = client.get("/report", params={"surface": "exposure", "mode": "offline"}).json()
    assert n["summary"]
    covered = {r["id"] for r in n["top_risks"]}
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= covered
