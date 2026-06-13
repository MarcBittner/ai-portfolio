from fastapi.testclient import TestClient

from quorum.api import app

client = TestClient(app)


def test_health_and_workflows():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["workflows"] == 2 and b["contracts"] > 0
    wf = client.get("/workflows").json()["workflows"]
    assert {w["name"] for w in wf} == {"contract-review", "policy-qa"}


def test_review_flags_risks_and_returns_trace():
    r = client.post("/review", json={"contract_id": "saas-002"}).json()
    assert r["risk_report"]["count"] >= 3
    classes = set(r["risk_report"]["by_class"])
    assert "data_sharing" in classes and "auto_renewal" in classes
    # trace shows every agent + its routing tier
    steps = {s["step"] for s in r["trace"]}
    assert "clause_extractor" in steps and "redline_drafter" in steps
    assert all("provider" in s and "latency_ms" in s for s in r["trace"])
    assert r["audit_verified"] is True
    assert r["exec_summary"]


def test_review_unknown_contract_404():
    assert client.post("/review", json={"contract_id": "nope"}).status_code == 404


def test_review_raw_text_redacts_pii_in_trace():
    text = ("CONTRACT: test\n\nClause 1: Auto-renews for successive terms; "
            "contact jane.doe@example.com or acct 4929114450021188.")
    r = client.post("/review", json={"text": text}).json()
    import json
    blob = json.dumps(r["trace"])
    assert "jane.doe@example.com" not in blob
    assert "4929114450021188" not in blob


def test_trace_endpoint_returns_audit():
    rid = client.post("/review", json={"contract_id": "msa-001"}).json()["run_id"]
    t = client.get(f"/trace/{rid}").json()
    assert t["run_id"] == rid
    assert t["audit"] and t["audit_verified"] is True
    assert t["rollup"]["steps"] == len(t["trace"])


def test_trace_unknown_run_404():
    assert client.get("/trace/run-doesnotexist").status_code == 404


def test_run_named_workflow_policy_qa():
    r = client.post("/run", json={
        "workflow": "policy-qa",
        "payload": {"question": "What is the uptime SLA?"}}).json()
    assert r["workflow"] == "policy-qa"
    assert r["result"].get("grounded") is True
    assert r["audit_verified"] is True


def test_run_unknown_workflow_404():
    r = client.post("/run", json={"workflow": "nope", "payload": {}})
    assert r.status_code == 404
    assert "available" in r.json()


def test_evals_endpoint():
    e = client.get("/evals").json()
    assert e["recall"] >= 0.9
    assert e["pii_leaks_in_audit"] == 0
    assert e["audit_verified"] is True


def test_llm_status():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True
