"""Live smoke + regression tests against a RUNNING synth-data service.

Unlike the in-process ``test_api.py`` (FastAPI ``TestClient``), these hit a real
HTTP endpoint — a locally-started server *or* a remote deployment — over the
network. Same assertions either way; only ``SYNTH_DATA_BASE_URL`` changes,
making this a deployment regression net.

OPT-IN: skipped unless ``SYNTH_DATA_LIVE=1`` so ``./run.sh test`` stays fast.

    ./run.sh smoke                                   # local server, auto start/stop
    ./run.sh smoke --url https://deploy.example.com  # remote deployment

Generation is seeded, so a fixed (preset, n, seed) reproduces byte-for-byte —
the suite pins that, plus the PII-free-by-construction guarantee.
"""
from __future__ import annotations

import os

import httpx
import pytest

BASE_URL = os.environ.get("SYNTH_DATA_BASE_URL", "http://127.0.0.1:8006").rstrip("/")
TIMEOUT = httpx.Timeout(60.0, connect=20.0)

pytestmark = pytest.mark.skipif(
    os.environ.get("SYNTH_DATA_LIVE") != "1",
    reason="live deploy tests; set SYNTH_DATA_LIVE=1 (or use ./run.sh smoke) to run",
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
def presets(client):
    r = client.get("/schemas")
    assert r.status_code == 200, r.text
    return r.json()


def _generate(client, preset, n=5, seed=42, **extra):
    r = client.post(
        "/generate",
        json={"preset": preset, "n": n, "seed": seed, "use_llm": False, **extra},
    )
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------- SMOKE -------------------------------

def test_smoke_health_ok(health):
    assert health["status"] == "ok"
    assert health["version"]
    assert health["types"] > 0
    assert health["presets"] > 0


def test_smoke_health_exposes_no_secrets(health):
    blob = str(health).lower()
    for token in ("password", "secret", "api_key", "sk-", "mongodb+srv"):
        assert token not in blob, f"/health must never expose {token!r}"


def test_smoke_presets_listed(presets):
    assert isinstance(presets, list) and presets
    for p in presets:
        assert p["name"] and isinstance(p["fields"], list) and p["fields"]


def test_smoke_generate_returns_rows(client, presets):
    body = _generate(client, presets[0]["name"], n=5)
    assert body["n"] == 5 and body["seed"] == 42
    assert body["columns"]
    assert len(body["rows"]) == 5
    for row in body["rows"]:
        assert set(row) >= set(body["columns"])


# ----------------------------- REGRESSION ----------------------------

def test_regression_same_seed_is_reproducible(client, presets):
    name = presets[0]["name"]
    a = _generate(client, name, n=8, seed=123)
    b = _generate(client, name, n=8, seed=123)
    assert a["rows"] == b["rows"], "identical (preset, n, seed) must reproduce exactly"


def test_regression_different_seed_differs(client, presets):
    name = presets[0]["name"]
    a = _generate(client, name, n=8, seed=1)
    b = _generate(client, name, n=8, seed=2)
    assert a["rows"] != b["rows"], "different seeds should yield different data"


def test_regression_pii_free_by_construction(client, presets):
    # any generated email must sit on an RFC-2606 example.* domain (no real PII)
    for preset in presets:
        body = _generate(client, preset["name"], n=10, seed=7)
        for row in body["rows"]:
            for value in row.values():
                if not (isinstance(value, str) and "@" in value):
                    continue
                domain = value.split("@")[-1]
                if "." in domain:
                    assert "example" in domain, f"non-example email: {value!r}"


def test_regression_unknown_preset_rejected(client):
    r = client.post(
        "/generate", json={"preset": "no-such-preset", "n": 3, "use_llm": False}
    )
    assert r.status_code == 422
