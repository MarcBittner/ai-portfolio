"""Live smoke + regression tests against a RUNNING persona-twin service.

These hit a real HTTP endpoint — a locally-started server *or* a remote
deployment — not an in-process app. The same assertions run either way; only
``PERSONA_TWIN_BASE_URL`` changes, making this a deployment regression net.
OPT-IN: the whole module is skipped unless ``PERSONA_TWIN_LIVE=1`` is set, so the
normal offline suite (``./run.sh test``) stays fast and network-free.

Run locally (``./run.sh smoke`` starts a server, ingests the corpus, tears down):
    ./run.sh smoke

Run against a deployment (and optionally assert production backends):
    ./run.sh smoke --url https://persona-twin-usu4.onrender.com
    # or directly:
    PERSONA_TWIN_LIVE=1 \
    PERSONA_TWIN_BASE_URL=https://persona-twin-usu4.onrender.com \
    PERSONA_TWIN_EXPECT_ATLAS=1 PERSONA_TWIN_EXPECT_LLM=openrouter \
    pytest tests/test_live_smoke.py -v

Notes:
- Render's free tier cold-starts (~30-60s) after idle; timeouts are generous and
  the client fixture warms it up before assertions run.
- Generated text is non-deterministic, so regression checks assert *structural*
  invariants (grounding, tenant isolation, citation shape) — never exact wording.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

BASE_URL = os.environ.get(
    "PERSONA_TWIN_BASE_URL", "http://127.0.0.1:8000"
).rstrip("/")
EXPECT_ATLAS = os.environ.get("PERSONA_TWIN_EXPECT_ATLAS") == "1"
EXPECT_LLM = os.environ.get("PERSONA_TWIN_EXPECT_LLM")  # e.g. "openrouter"
KNOWN_PERSONAS = {"ada-quill", "buck-ramirez", "gus-okafor", "mei-tanaka"}

# A question whose wording lexically overlaps ada-quill's garden-journal doc
# ("balcony", "tomato", "garden", "compost"). Strong overlap means it retrieves
# reliably under BOTH the offline hash embedder (local) and a real embedder
# (remote) — recall on sparser phrasings is embedder-dependent, which would make
# the suite flaky across the two run modes.
GROUNDED_Q = "Tell me about your balcony tomato garden and compost."

# generous: a sleeping free-tier dyno can take ~60s to wake
TIMEOUT = httpx.Timeout(90.0, connect=30.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("PERSONA_TWIN_LIVE") != "1",
    reason="live deploy tests; set PERSONA_TWIN_LIVE=1 to run",
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


def _ask(client, persona_id, question, **extra):
    r = client.post("/ask", json={"persona_id": persona_id, "question": question, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["chunks_indexed"] > 0
    assert health["personas"] >= 1


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for secret in ("uri", "password", "secret", "mongodb+srv", "sk-", "api_key"):
        assert secret not in blob, f"/health must never expose {secret!r}"


def test_smoke_personas_listed(client):
    r = client.get("/personas")
    assert r.status_code == 200
    personas = r.json()
    assert isinstance(personas, list) and personas
    for p in personas:
        assert p["persona_id"] and p["name"]


def test_smoke_persona_detail_and_404(client):
    pid = sorted(KNOWN_PERSONAS)[0]
    assert client.get(f"/personas/{pid}").status_code == 200
    assert client.get("/personas/does-not-exist").status_code == 404


def test_smoke_ask_returns_grounded_answer(client):
    body = _ask(client, "ada-quill", GROUNDED_Q)
    assert body["answered"] is True
    assert body["answer"].strip()
    assert body["citations"], "an answerable question must return citations"


# ----------------------------- REGRESSION ----------------------------

def test_regression_known_corpus_loaded(health):
    assert health["personas"] == 4
    assert health["chunks_indexed"] >= 40


def test_regression_tenant_isolation(client):
    # every retrieved chunk must belong to the queried persona (vector-search filter)
    body = _ask(client, "ada-quill", "Tell me about your week.", debug=True)
    assert body["citations"]
    for c in body["citations"]:
        assert c["chunk_id"].startswith("ada-quill/"), f"cross-tenant leak: {c['chunk_id']}"


def test_regression_citations_have_scores(client):
    # use a query that reliably retrieves (hash-embedding recall is phrasing-sensitive);
    # the point of this test is citation *shape*, not recall on an arbitrary question.
    cites = _ask(client, "ada-quill", GROUNDED_Q)["citations"]
    assert cites, "the gardening query should retrieve at least one chunk"
    for c in cites:
        assert isinstance(c.get("score"), (int, float))
        assert c.get("doc_id") and c.get("chunk_id")


def test_regression_answer_shape_even_when_no_retrieval(client):
    # hash embeddings sometimes retrieve nothing for a given phrasing; the API must
    # still return a well-formed response (not 500) and never fabricate citations.
    body = _ask(client, "ada-quill", "What are you growing this season?")
    assert isinstance(body["answered"], bool)
    assert isinstance(body.get("citations", []), list)
    assert "answer" in body


def test_regression_retrieval_is_relevant(client):
    # lenient relevance guard: a gardening question should surface a garden-ish doc.
    cites = _ask(client, "ada-quill", GROUNDED_Q)["citations"]
    docs = " ".join(c.get("doc_id", "") for c in cites).lower()
    assert docs, "expected at least one citation"
    assert any(t in docs for t in ("garden", "tomato", "balcony", "plant")), f"irrelevant: {docs}"


def test_regression_unknown_persona_rejected(client):
    r = client.post("/ask", json={"persona_id": "nobody", "question": "hi"})
    assert r.status_code == 404


# --------------------- PROD CONFIG (opt-in strict) -------------------

@pytest.mark.skipif(not EXPECT_ATLAS, reason="set PERSONA_TWIN_EXPECT_ATLAS=1 to require Atlas")
def test_prod_vector_backend_is_atlas(health):
    assert health["vector_backend"] == "atlas", health


@pytest.mark.skipif(
    not EXPECT_LLM, reason="set PERSONA_TWIN_EXPECT_LLM=<provider> to require live inference"
)
def test_prod_llm_backend_present(health):
    assert EXPECT_LLM in health["llm_backends"], health
