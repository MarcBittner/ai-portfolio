"""Live smoke + regression tests against a RUNNING perimeter service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``PERIMETER_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``PERIMETER_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("PERIMETER_BASE_URL", "http://127.0.0.1:8022").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("PERIMETER_LIVE") != "1",
    reason="live deploy tests; set PERIMETER_LIVE=1 (or use ./run.sh smoke) to run",
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
    recycles. Deliberate-error assertions still see their real status."""
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


@pytest.fixture(scope="module")
def posture(client):
    r = client.get("/posture")
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["controls"] > 0 and health["frameworks"] == 5
    assert health["exposures"] > 0 and health["grade"]


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_posture_returns_grade(posture):
    assert posture["posture"]["grade"]
    assert len(posture["framework_rollup"]) == 5


def test_smoke_exposures_present(client):
    e = client.get("/exposures").json()
    assert e["findings"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_governed_evidence(client):
    e = client.get("/exposures").json()["findings"]
    assert all(f["controls"] for f in e)  # every finding maps to a control
    cs = client.get("/controls").json()["controls"]
    for c in cs:
        if c["status"] == "fail":
            assert c["finding_count"] == len(c["findings"]) >= 1


def test_regression_critical_exposures_present(client):
    e = client.get("/exposures").json()["findings"]
    rules = {f["rule_id"] for f in e if f["severity"] == "critical"}
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= rules


def test_regression_multiframework_crosswalk(client):
    cs = client.get("/controls").json()["controls"]
    db = next(c for c in cs if c["id"] == "CC6.6")
    assert {"SOC 2", "ISO 27001", "NIST 800-53", "NIST 800-171", "CMMC"} \
        <= set(db["frameworks"])


def test_regression_is_deterministic(client):
    a = client.get("/posture").json()
    b = client.get("/posture").json()
    assert a["posture"] == b["posture"]
    assert a["severity_counts"] == b["severity_counts"]


def test_regression_remediation_diff(client):
    d = client.get("/diff").json()
    assert d["before"]["posture"]["score"] < d["after"]["posture"]["score"]
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= set(d["fixed_findings"])
    assert {"CC6.1", "CC6.6"} <= set(d["controls_remediated"])


def test_regression_gate_fails_on_open_criticals(client):
    g = client.get("/gate").json()
    assert g["passed"] is False and g["reasons"]


def test_smoke_report_covers_criticals(client):
    n = client.get("/report", params={"mode": "offline"}).json()
    assert n["summary"].strip() and n["top_risks"]
    covered = {r["rule_id"] for r in n["top_risks"]}
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= covered


def test_smoke_evals_cover_criticals(client):
    e = client.get("/evals").json()
    assert e["criticals_covered"] is True and e["coverage_complete"] is True


def test_smoke_evidence_export(client):
    j = client.get("/evidence", params={"control": "CC6.6"}).json()
    assert j["controls"] and j["controls"][0]["frameworks"]["CMMC"]
    csv_resp = client.get("/evidence", params={"format": "csv"})
    assert csv_resp.headers["content-type"].startswith("text/csv")


def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_regression_no_secrets(client):
    blob = str(client.get("/llm").json()).lower()
    for token in ("password", "secret", "sk-ant", "sk-or", "api_key"):
        assert token not in blob
