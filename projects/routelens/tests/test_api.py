import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ROUTELENS_DB", str(tmp_path / "t.db"))
    import routelens.api as api
    importlib.reload(api)
    return TestClient(api.app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert "providers" in r.json()


def test_openai_compatible_completion(client):
    r = client.post("/v1/chat/completions", json={
        "model": "claude-opus-4-8",
        "messages": [{"role": "user", "content": "hello there"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert "routelens" in body
    assert "x-routelens-strategy" in r.headers


def test_config_roundtrip(client):
    r = client.put("/config", json={"mode": "route", "floor": 0.95})
    assert r.json()["mode"] == "route"
    assert r.json()["floor"] == 0.95


def test_simulate_then_report_and_opportunities(client):
    r = client.post("/simulate", json={"n": 40, "seed": 1})
    assert r.status_code == 200
    assert r.json()["ran"] >= 40
    rep = client.get("/report").json()
    assert "summary" in rep and "projection" in rep and "cache" in rep
    ops = client.get("/opportunities").json()["opportunities"]
    # caching opportunities are structural and present even offline
    assert any(o["kind"] in ("response-cache", "prompt-cache") for o in ops)


def test_models_and_rules_generate(client):
    assert client.get("/models").json()["models"]
    client.post("/simulate", json={"n": 20, "seed": 2})
    r = client.post("/rules/generate")
    assert r.status_code == 200
    assert "rules" in r.json()


def test_reset(client):
    client.post("/simulate", json={"n": 10, "seed": 1})
    assert client.post("/reset").json()["ok"] is True
    assert client.get("/report").json()["summary"]["requests"] == 0


def test_static_index_served(client):
    static = os.path.join(
        os.path.dirname(importlib.import_module("routelens.api").__file__),
        "static", "index.html")
    if not os.path.exists(static):
        pytest.skip("console not built yet")
    r = client.get("/")
    assert r.status_code == 200
