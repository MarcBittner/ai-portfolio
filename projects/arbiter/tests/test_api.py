import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ARBITER_DB", str(tmp_path / "t.db"))
    import arbiter.api as api
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
    assert "arbiter" in body
    assert "x-arbiter-strategy" in r.headers


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


def test_traffic_and_judge_prompt(client):
    t = client.get("/traffic?n=6&seed=1").json()
    assert len(t["requests"]) >= 6 and "messages" in t["requests"][0]
    jp = client.get("/judge-prompt").json()
    assert "evaluation judge" in jp["system"] and "{candidate}" in jp["user_template"]


def test_observe_client_browser_to_host(client):
    # browser-executed observation: baseline priced as sonnet, candidate as haiku,
    # texts identical + judge_score high -> real measured quality + real $ delta
    client.put("/config", json={"min_samples": 1})
    obs = {
        "messages": [{"role": "user", "content": "classify this ticket as a bug"}],
        "max_tokens": 200, "temperature": 0.0, "wants_json": False,
        "baseline": {"model_id": "claude-sonnet-4-6", "executor": "qwen2.5:14b",
                     "text": "Category: bug", "in_tokens": 120, "out_tokens": 8},
        "candidates": [{"model_id": "claude-haiku-4-5", "executor": "llama3.2:3b",
                        "text": "Category: bug", "in_tokens": 120, "out_tokens": 8,
                        "judge_score": 0.97, "judge_reason": "equivalent"}],
    }
    r = client.post("/observe/client", json=obs).json()
    assert r["candidates"] and r["candidates"][0]["retained"] > 0.9
    assert r["candidates"][0]["saved_per_req"] > 0  # sonnet list > haiku list
    q = client.get("/quality").json()["quality"]
    assert any(s["candidate_model"] == "claude-haiku-4-5" for s in q)
    ops = client.get("/opportunities").json()["opportunities"]
    assert any(o["kind"] == "route" for o in ops)  # real measured route opportunity


def test_reset(client):
    client.post("/simulate", json={"n": 10, "seed": 1})
    assert client.post("/reset").json()["ok"] is True
    assert client.get("/report").json()["summary"]["requests"] == 0


def test_static_index_served(client):
    static = os.path.join(
        os.path.dirname(importlib.import_module("arbiter.api").__file__),
        "static", "index.html")
    if not os.path.exists(static):
        pytest.skip("console not built yet")
    r = client.get("/")
    assert r.status_code == 200
