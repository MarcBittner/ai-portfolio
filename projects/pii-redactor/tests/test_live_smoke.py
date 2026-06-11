"""Live smoke + regression tests against a RUNNING pii-redactor service.

Unlike the in-process ``test_api.py`` suite (FastAPI ``TestClient``), these hit a
real HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. The same assertions run either way; only ``PII_REDACTOR_BASE_URL``
changes. This makes the suite a deployment regression net: run it after every
ship to prove the live service still honours its contract.

OPT-IN: the module is skipped unless ``PII_REDACTOR_LIVE=1`` so the default
offline unit suite (``./run.sh test``) stays fast and network-free.

Run locally (``./run.sh smoke`` starts a server, runs this, tears it down):
    ./run.sh smoke

Run against a deployment:
    ./run.sh smoke --url https://pii-redactor.example.com
    # or directly:
    PII_REDACTOR_LIVE=1 PII_REDACTOR_BASE_URL=http://localhost:9084 \
        pytest tests/test_live_smoke.py -v

Assertions are structural/deterministic: the regex+checksum core is exercised
with ``use_llm=false`` so results are reproducible regardless of backend. The
cardinal invariant — a redaction must never leak the value it redacted — is
checked explicitly.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("PII_REDACTOR_BASE_URL", "http://127.0.0.1:8001").rstrip("/")

# generous: a sleeping free-tier dyno / cold container can take a while to wake
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("PII_REDACTOR_LIVE") != "1",
    reason="live deploy tests; set PII_REDACTOR_LIVE=1 (or use ./run.sh smoke) to run",
)

# A deterministic fixture string with one of each high-confidence, checksum-backed type.
SAMPLE = "Email bob@example.com, card 4111111111111111, SSN 123-45-6789."
SECRETS = ("bob@example.com", "4111111111111111", "123-45-6789")


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


def _detect(client, text=SAMPLE, **extra):
    r = client.post("/detect", json={"text": text, "use_llm": False, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def _redact(client, text=SAMPLE, style="mask", **extra):
    r = client.post(
        "/redact", json={"text": text, "style": style, "use_llm": False, **extra}
    )
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["types"] > 0
    assert isinstance(health["styles"], list) and health["styles"]


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_types_listed(client):
    r = client.get("/types")
    assert r.status_code == 200
    types = r.json()
    assert isinstance(types, list) and types
    for t in types:
        assert t["name"] and t["source"] in ("regex", "llm")


def test_smoke_detect_finds_known_pii(client):
    body = _detect(client)
    assert body["total"] >= 3, body
    assert set(body["counts"]) >= {"EMAIL", "CREDIT_CARD", "SSN"}, body["counts"]


# ----------------------------- REGRESSION ----------------------------

def test_regression_redaction_never_leaks_value(client):
    # The cardinal invariant: redacted output must not contain any redacted value.
    for style in ("token", "label", "mask", "partial", "hash"):
        redacted = _redact(client, style=style)["redacted"]
        for secret in SECRETS:
            assert secret not in redacted, f"style={style!r} leaked {secret!r}"


def test_regression_detect_is_deterministic(client):
    # Same input + use_llm=false → identical span set on every call (and any backend).
    a, b = _detect(client), _detect(client)
    assert a["counts"] == b["counts"]
    assert a["total"] == b["total"]


def test_regression_spans_are_well_formed(client):
    for s in _detect(client)["spans"]:
        assert 0 <= s["start"] < s["end"] <= len(SAMPLE)
        assert SAMPLE[s["start"]:s["end"]]  # non-empty slice
        assert s["type"] and s["source"] in ("regex", "llm")


def test_regression_clean_text_detects_nothing(client):
    body = _detect(client, text="The quick brown fox jumps over the lazy dog.")
    assert body["total"] == 0
    assert body["counts"] == {}


def test_regression_unknown_style_rejected(client):
    r = client.post("/redact", json={"text": SAMPLE, "style": "no-such-style"})
    assert r.status_code == 422


def test_regression_unknown_type_rejected(client):
    r = client.post("/detect", json={"text": SAMPLE, "types": ["NOPE"], "use_llm": False})
    assert r.status_code == 422
