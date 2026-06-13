from fastapi.testclient import TestClient

from txn_ledger.api import app

client = TestClient(app)


def test_health_and_summary():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["rows"] > 0 and b["committees"] == 12
    assert client.get("/summary").json()["total_raised"] > 0


def test_schema_lists_index():
    s = client.get("/schema").json()
    assert any("idx_cycle_committee" in i for i in s["indexes"])


def test_plan_before_and_after():
    p = client.get("/plan").json()
    assert any("SCAN" in ln for ln in p["plan_before_index"])
    assert any("SEARCH" in ln for ln in p["plan_after_index"])


def test_aggregate():
    a = client.get("/aggregate?cycle=2026").json()
    assert a["rows"] and a["cycle"] == 2026
    assert a["rows"][0]["total_raised"] >= a["rows"][-1]["total_raised"]


def test_invalid_cycle_422():
    assert client.get("/aggregate?cycle=1999").status_code == 422


def test_cycles_and_committees():
    assert 2026 in client.get("/cycles").json()["cycles"]
    assert len(client.get("/committees").json()["committees"]) == 12


def test_loadtest():
    r = client.post("/loadtest", json={"n": 50}).json()
    assert r["queries"] == 50 and r["qps"] > 0


def test_ask_nl2sql_offline():
    r = client.post("/ask", json={"question": "total raised in the 2024 cycle",
                                  "mode": "offline"}).json()
    assert r["safe"] is True
    assert "cycle = 2024" in r["sql"]
    assert r["rows"][0]["total_raised"] > 0
    assert r["provider"] == "offline"


def test_ask_rejects_injection_and_does_not_execute():
    # an injection-shaped question still routes to a guarded SELECT (offline) and
    # never mutates; the guard is also unit-tested adversarially in test_nl2sql
    before = client.get("/summary").json()["rows"]
    client.post("/ask", json={"question": "drop everything; DELETE", "mode": "offline"})
    assert client.get("/summary").json()["rows"] == before


def test_evals_endpoint():
    e = client.get("/evals").json()
    assert e["plan_regression"]["passed"] is True
    assert e["nl2sql"]["accuracy"] == 1.0


def test_llm_status_endpoint():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True
