"""Live smoke + regression tests against a RUNNING multimodal-ocr service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``MULTIMODAL_OCR_BASE_URL`` changes,
making this a deployment regression net.

OPT-IN: skipped unless ``MULTIMODAL_OCR_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Assertions run the bundled samples with ``use_llm=false`` (deterministic regex
detection), and check the cardinal invariant: detected PII is never echoed in
the redacted text.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("MULTIMODAL_OCR_BASE_URL", "http://127.0.0.1:8008").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("MULTIMODAL_OCR_LIVE") != "1",
    reason="live deploy tests; set MULTIMODAL_OCR_LIVE=1 (or use ./run.sh smoke) to run",
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


@pytest.fixture(scope="module")
def samples(client):
    r = client.get("/samples")
    assert r.status_code == 200, r.text
    return r.json()


def _process(client, sample, **extra):
    r = client.post("/process", json={"sample": sample, "use_llm": False, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["samples"] > 0
    assert health["types"] > 0
    assert health["ocr_backend"] in ("tesseract", "samples-only")


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_samples_listed(samples):
    assert isinstance(samples, list) and samples
    for s in samples:
        assert s["name"] and isinstance(s["tokens"], list) and s["tokens"]
        for t in s["tokens"]:
            assert set(t) >= {"text", "x", "y", "w", "h"}


def test_smoke_process_returns_pipeline(client, samples):
    body = _process(client, samples[0]["name"])
    assert body["text"] and isinstance(body["redacted_text"], str)
    assert isinstance(body["findings"], list)
    assert isinstance(body["boxes"], list)


# ----------------------------- REGRESSION ----------------------------

def test_regression_redaction_never_echoes_pii(client, samples):
    # cardinal invariant: every detected PII snippet must be gone from redacted_text
    for sample in samples:
        body = _process(client, sample["name"])
        for f in body["findings"]:
            snip = f.get("snippet", "")
            if len(snip) >= 4:  # ignore trivially short matches
                assert snip not in body["redacted_text"], f"leaked {snip!r}"


def test_regression_counts_match_findings(client, samples):
    body = _process(client, samples[0]["name"])
    assert sum(body["counts"].values()) == len(body["findings"])
    for b in body["boxes"]:
        assert set(b) >= {"x", "y", "w", "h", "type"}


def test_regression_is_deterministic(client, samples):
    name = samples[0]["name"]
    a, b = _process(client, name), _process(client, name)
    assert a["counts"] == b["counts"]
    assert a["redacted_text"] == b["redacted_text"]


def test_regression_unknown_sample_rejected(client):
    r = client.post("/process", json={"sample": "no-such-sample", "use_llm": False})
    assert r.status_code == 422
