"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from agent_sandbox.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["tools"] == 4


def test_tools_listing():
    tools = client.get("/tools").json()
    names = {t["name"] for t in tools}
    assert names == {"calculator", "convert", "date_diff", "search"}


def test_run_chained():
    r = client.post("/run", json={
        "query": "What is 20% of the days between 2026-01-01 and 2026-02-01?"})
    body = r.json()
    assert body["n_steps"] == 2
    assert [s["tool"] for s in body["steps"]] == ["date_diff", "calculator"]
    assert body["answer"] == "6.2"


def test_run_single_tool():
    body = client.post("/run", json={"query": "Convert 10 km to miles"}).json()
    assert body["steps"][0]["tool"] == "convert"
    assert body["answer"].endswith("mi")


def test_run_empty_query_422():
    assert client.post("/run", json={"query": ""}).status_code == 422


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "agent-sandbox" in r.text.lower()
