"""Live smoke + regression tests against a RUNNING field-vault service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``FIELD_VAULT_BASE_URL`` changes,
making this a deployment regression net.

OPT-IN: skipped unless ``FIELD_VAULT_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

De-identification, policy, and the de-id score are deterministic, so the
assertions hold against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("FIELD_VAULT_BASE_URL", "http://127.0.0.1:8012").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("FIELD_VAULT_LIVE") != "1",
    reason="live deploy tests; set FIELD_VAULT_LIVE=1 (or use ./run.sh smoke) to run",
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
    test targets /records/<id> (a GET) and still resolves to 404 after retries."""
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
    c.post("/admin/reset")
    yield c
    c.close()


@pytest.fixture(scope="module")
def health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    return r.json()


def _access(client, **body):
    r = client.post("/access", json=body)
    assert r.status_code in (200, 404), r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["records"] > 0
    assert health["roles"] == 3


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_records_and_scores(client):
    assert client.get("/records").json()["records"]
    assert client.get("/scores").json()["providers"][0]["rank"] == 1


# ----------------------------- REGRESSION ----------------------------

def test_regression_surface_is_fully_deidentified(client):
    # cardinal invariant: no direct identifier appears in the clear on the surface
    for r in client.get("/records").json()["records"]:
        assert r["member_id"].startswith("tok_")
        assert r["member_name"].startswith("tok_")
        assert len(str(r["dob"])) == 4          # generalized to birth year


def test_regression_analyst_cannot_reidentify(client):
    r = _access(client, role="analyst", record_id="rec-0001",
                field="member_name", reidentify=True)
    assert r["allowed"] is False


def test_regression_reidentify_requires_role_and_purpose(client):
    no_purpose = _access(client, role="care_coordinator", record_id="rec-0001",
                         field="member_name", reidentify=True)
    assert no_purpose["allowed"] is False
    ok = _access(client, role="care_coordinator", record_id="rec-0001",
                 field="member_name", purpose="treatment", reidentify=True)
    assert ok["allowed"] is True and not str(ok["value"]).startswith("tok_")


def test_regression_scores_are_phi_free(client):
    for p in client.get("/scores").json()["providers"]:
        assert "member_name" not in p and "member_id" not in p


def test_regression_audit_chain_verifies(client):
    _access(client, role="analyst", record_id="rec-0001", field="dx_code")
    assert client.get("/audit/verify").json()["ok"] is True


def test_regression_unknown_record_404(client):
    assert client.get("/records/rec-9999").status_code == 404


# ------------------------------- LLM SURFACE -------------------------------

def test_smoke_llm_status(client):
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_regression_note_scrub_removes_phi(client):
    note = "Member Pat Doe (DOB 1980-01-02) at 415-555-0100 or pat.doe@example.com."
    r = client.post("/notes/detect", json={"note": note})
    assert r.status_code == 200, r.text
    out = r.json()
    # the LLM may or may not be configured; the chain always yields a result and
    # deterministic redaction must remove the structured PHI either way.
    assert "pat.doe@example.com" not in out["redacted"]
    assert "415-555-0100" not in out["redacted"]
    assert out["phi_found"] >= 2


def test_regression_kanon_finds_singletons(client):
    k = client.get("/privacy").json()
    assert k["k_min"] == 1
    assert k["singleton_count"] == k["records"]


def test_regression_evals_recall_is_high(client):
    ev = client.get("/evals").json()
    assert ev["notes"] > 0
    assert 0.0 <= ev["precision"] <= 1.0
    assert ev["recall"] >= 0.5  # offline detector is lossless; a live model may vary
