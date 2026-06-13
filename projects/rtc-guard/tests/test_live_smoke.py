"""Live smoke + regression tests against a RUNNING rtc-guard service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``RTC_GUARD_BASE_URL`` changes, making
this a deployment regression net.

OPT-IN: skipped unless ``RTC_GUARD_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

The token core is deterministic, so mint/verify and the adversarial suite are
reproducible against any instance.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("RTC_GUARD_BASE_URL", "http://127.0.0.1:8013").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("RTC_GUARD_LIVE") != "1",
    reason="live deploy tests; set RTC_GUARD_LIVE=1 (or use ./run.sh smoke) to run",
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


def _mint(client, **body):
    r = client.post("/v1/token", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["templates"] > 0
    assert health["threats"] >= 6


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "signing-key", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_mint_returns_scoped_token(client):
    b = _mint(client, identity="alice", room="room-a", template="publisher")
    assert b["token"].count(".") == 2
    assert b["claims"]["video"]["room"] == "room-a"


# ----------------------------- REGRESSION ----------------------------

def test_regression_minted_token_verifies(client):
    tok = _mint(client, identity="alice", room="room-a")["token"]
    v = client.post("/v1/verify", json={"token": tok, "expected_room": "room-a"}).json()
    assert v["valid"] is True


def test_regression_cross_room_replay_rejected(client):
    tok = _mint(client, identity="alice", room="room-a")["token"]
    v = client.post("/v1/verify", json={"token": tok, "expected_room": "room-b"}).json()
    assert v["valid"] is False


def test_regression_tampered_token_rejected(client):
    # flip a char in the signature → verification must fail
    tok = _mint(client, identity="alice", room="room-a")["token"]
    h, b, s = tok.split(".")
    bad = f"{h}.{b}.{('A' if s[0] != 'A' else 'B') + s[1:]}"
    assert client.post("/v1/verify", json={"token": bad}).json()["valid"] is False


def test_regression_adversary_blocks_everything(client):
    # cardinal invariant: every forgery/replay/escalation attempt is blocked
    a = client.get("/adversary").json()
    assert a["block_rate"] == 1.0
    assert all(c["blocked"] for c in a["checks"])


def test_regression_threat_model_covers_agent_path(client):
    cats = {t["category"] for t in client.get("/threat-model").json()["threats"]}
    assert {"token", "room", "agent", "egress"} <= cats


def test_regression_unknown_template_rejected(client):
    assert client.post("/v1/token", json={"template": "root"}).status_code == 422


def test_regression_grant_auditor_flags_over_permissioned(client):
    # the LLM grant auditor (or its deterministic fallback) must flag an
    # over-permissioned viewer; the security core is untouched by this layer.
    r = client.post("/grant/audit", json={
        "identity": "eve", "room": "", "role": "viewer", "ttl": 86_400,
        "roomJoin": True, "canSubscribe": True, "canPublish": True,
        "canPublishData": True})
    b = r.json()
    assert b["least_privilege"] is False
    assert b["by_severity"]["high"] >= 1
    assert b["explanation"]


def test_regression_grant_auditor_passes_clean_viewer(client):
    r = client.post("/grant/audit", json={
        "identity": "alice", "room": "room-a", "role": "viewer", "ttl": 300,
        "roomJoin": True, "canSubscribe": True})
    assert r.json()["least_privilege"] is True


def test_regression_evals_recall(client):
    b = client.get("/evals").json()
    assert b["recall"] == 1.0 and b["false_negatives"] == 0


def test_smoke_llm_status_no_secrets(client):
    b = client.get("/llm").json()
    assert b["offline_fallback"] is True
    assert set(b["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    # status reports booleans only — never a key value
    assert all(isinstance(v, bool) for v in b["providers"].values())
