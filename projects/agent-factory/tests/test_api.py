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


def test_tool_endpoint_executes_server_side():
    # the browser→host Ollama loop dispatches each step here; tools run server-side
    r = client.post("/tool", json={"tool": "calculator",
                                    "args": {"expression": "3 * (4 + 5)"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["observation"] == "27"
    assert body["tool"] == "calculator"


def test_tool_endpoint_enforces_allowlist():
    # a crafted browser request can't run a tool outside the agent's allowlist
    r = client.post("/tool", json={"tool": "calculator",
                                   "args": {"expression": "1+1"},
                                   "tools": ["kb_search"]})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "not in allowlist" in body["observation"]


def test_tool_endpoint_unknown_tool_and_bad_args():
    assert client.post("/tool", json={"tool": "ghost", "args": {}}).status_code == 422
    # validation failure becomes a failed observation, never a 500
    bad = client.post("/tool", json={"tool": "calculator",
                                     "args": {"wrong": "x"}})
    assert bad.status_code == 200 and bad.json()["ok"] is False


def test_index_served():
    assert client.get("/").status_code == 200
