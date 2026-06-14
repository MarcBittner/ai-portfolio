"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from agent_sandbox.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["tools"] == 4
    assert "ollama" in body


def test_providers_endpoint():
    assert client.get("/providers").json()["available"]["mock"] is True


def test_tools_listing():
    tools = client.get("/tools").json()
    names = {t["name"] for t in tools}
    assert names == {"calculator", "convert", "date_diff", "search"}


def test_run_chained_rule_planner():
    r = client.post("/run", json={
        "query": "What is 20% of the days between 2026-01-01 and 2026-02-01?",
        "use_llm": False})
    body = r.json()
    assert body["planner"] == "rule"
    assert [s["tool"] for s in body["steps"]] == ["date_diff", "calculator"]
    assert body["answer"] == "6.2"


def test_run_single_tool_rule():
    body = client.post("/run", json={
        "query": "Convert 10 km to miles", "use_llm": False}).json()
    assert body["steps"][0]["tool"] == "convert"
    assert body["answer"].endswith("mi")


def test_llm_planner_mock_falls_back_to_rule():
    # provider=mock -> llm_plan returns None -> rule planner; routing reported
    body = client.post("/run", json={
        "query": "Convert 10 km to miles", "use_llm": True, "provider": "mock"}).json()
    assert body["planner"] == "rule"
    assert body["routing"]["provider"] == "mock"
    assert body["steps"][0]["tool"] == "convert"


def test_run_empty_query_422():
    assert client.post("/run", json={"query": ""}).status_code == 422


def test_tool_endpoint_executes_server_side():
    # The browser-driven loop posts each chosen step here; the tool runs server-side.
    body = client.post("/tool", json={
        "name": "calculator", "args": {"expression": "20/100*31"}}).json()
    assert body["name"] == "calculator" and body["ok"] is True
    assert body["observation"] == "6.2"


def test_tool_endpoint_unknown_tool_is_safe():
    body = client.post("/tool", json={"name": "rm_rf", "args": {}}).json()
    assert body["ok"] is False and "unknown tool" in body["observation"]


def test_tool_endpoint_bad_args_is_safe():
    # untrusted/wrong args must not crash the server
    body = client.post("/tool", json={
        "name": "calculator", "args": {"nope": 1}}).json()
    assert body["ok"] is False and "bad arguments" in body["observation"]


def test_tool_endpoint_drives_a_browser_loop():
    # simulate the browser loop: plan in browser, execute each step via /tool
    d1 = client.post("/tool", json={
        "name": "date_diff",
        "args": {"start": "2026-01-01", "end": "2026-02-01"}}).json()
    assert d1["ok"] and d1["observation"] == "31"
    d2 = client.post("/tool", json={
        "name": "calculator",
        "args": {"expression": f"20/100*{d1['observation']}"}}).json()
    assert d2["ok"] and d2["observation"] == "6.2"


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "agent-sandbox" in r.text.lower()
