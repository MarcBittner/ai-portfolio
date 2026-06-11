"""Live smoke + regression tests against a RUNNING doc-extract service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``DOC_EXTRACT_BASE_URL`` changes,
making this a deployment regression net.

OPT-IN: skipped unless ``DOC_EXTRACT_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Assertions force the deterministic regex extractor (``use_llm=false``).
"""
from __future__ import annotations

import os

import httpx
import pytest

BASE_URL = os.environ.get("DOC_EXTRACT_BASE_URL", "http://127.0.0.1:8003").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("DOC_EXTRACT_LIVE") != "1",
    reason="live deploy tests; set DOC_EXTRACT_LIVE=1 (or use ./run.sh smoke) to run",
)


@pytest.fixture(scope="module")
def client():
    c = httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=True)
    try:
        c.get("/health")
    except Exception as exc:  # noqa: BLE001
        c.close()
        pytest.skip(f"service unreachable at {BASE_URL}: {exc}")
    yield c
    c.close()


@pytest.fixture(scope="module")
def health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def schemas(client):
    r = client.get("/schemas")
    assert r.status_code == 200, r.text
    return r.json()


def _extract(client, schema, text, **extra):
    r = client.post(
        "/extract", json={"schema": schema, "text": text, "use_llm": False, **extra}
    )
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["schemas"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_schemas_listed(schemas):
    assert isinstance(schemas, list) and schemas
    for s in schemas:
        assert s["name"] and isinstance(s["fields"], list) and s["fields"]
        for f in s["fields"]:
            assert f["name"] and f["type"]


def test_smoke_extract_returns_fields(client, schemas):
    name = schemas[0]["name"]
    body = _extract(client, name, "Invoice #2024-001 dated 2024-06-10, total $4,200.00.")
    assert body["schema"] == name
    assert body["total"] == len(body["fields"]) > 0


# ----------------------------- REGRESSION ----------------------------

def test_regression_field_shape_and_confidence(client, schemas):
    name = schemas[0]["name"]
    body = _extract(client, name, "Invoice #2024-001 dated 2024-06-10, total $4,200.00.")
    assert 0 <= body["found"] <= body["total"]
    for f in body["fields"]:
        assert set(f) >= {"name", "type", "found", "valid", "confidence"}
        assert isinstance(f["found"], bool)
        assert 0.0 <= f["confidence"] <= 1.0
        if not f["found"]:
            assert f.get("value") in (None, "")


def test_regression_is_deterministic(client, schemas):
    name = schemas[0]["name"]
    text = "Invoice #2024-001 dated 2024-06-10, total $4,200.00."
    a = _extract(client, name, text)
    b = _extract(client, name, text)
    assert a["found"] == b["found"]
    assert [f["normalized"] for f in a["fields"]] == [
        f["normalized"] for f in b["fields"]
    ]


def test_regression_unknown_schema_rejected(client):
    r = client.post(
        "/extract", json={"schema": "no-such-schema", "text": "x", "use_llm": False}
    )
    assert r.status_code == 422
