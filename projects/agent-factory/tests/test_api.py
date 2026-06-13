from fastapi.testclient import TestClient

from agent_factory.api import app

client = TestClient(app)


def test_health_and_providers():
    h = client.get("/health").json()
    assert h["status"] == "ok"
    assert h["active_mode"] in ("offline", "free", "paid")
    p = client.get("/providers").json()
    assert "active_mode" in p and "available" in p


def test_tools_and_templates():
    tools = client.get("/tools").json()
    assert any(t["name"] == "calculator" for t in tools)
    tpls = {t["name"]: t for t in client.get("/templates").json()}
    assert "researcher" in tpls
    assert tpls["calculator"]["spec"]["tools"]  # full spec returned


def test_spec_validate_ok_and_bad():
    ok = client.post("/spec/validate", json={"name": "x", "tools": ["calculator"]})
    assert ok.status_code == 200 and ok.json()["valid"] is True
    bad = client.post("/spec/validate", json={"tools": ["nope"]})
    assert bad.status_code == 422


def test_run_with_template():
    r = client.post("/run", json={"task": "what is 9 * 9?", "template": "calculator"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "81"
    assert body["agent"] == "calculator"
    assert body["spec"]["tools"]


def test_run_with_inline_spec():
    spec = {"name": "mini", "tools": ["kb_search"], "planner": "rule"}
    r = client.post("/run", json={"task": "what is rag retrieval?", "spec": spec})
    assert r.status_code == 200
    assert r.json()["steps"][0]["tool"] == "kb_search"


def test_run_default_template_and_bad_template():
    r = client.post("/run", json={"task": "hello"})
    assert r.status_code == 200 and r.json()["agent"] == "assistant"
    bad = client.post("/run", json={"task": "hi", "template": "ghost"})
    assert bad.status_code == 422


def test_index_served():
    assert client.get("/").status_code == 200
