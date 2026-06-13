from fastapi.testclient import TestClient

from maskline.api import app

client = TestClient(app)


def _reset():
    client.post("/admin/reset")


def test_health():
    _reset()
    b = client.get("/health").json()
    assert b["status"] == "ok"
    assert b["tables"] == 3
    assert b["columns"] > 0
    assert b["sensitive_columns"] > 0


def test_warehouse_schema():
    s = client.get("/warehouse").json()
    assert s["engine"].startswith("duckdb")
    names = {t["table"] for t in s["tables"]}
    assert names == {"CLAIMS", "MEMBERS", "PROVIDERS"}


def test_classify_marks_free_text_sensitive():
    s = client.get("/classify").json()
    note = next(c for c in s["columns"]
                if c["table"] == "CLAIMS" and c["column"] == "CLAIM_NOTE")
    assert note["method"] == "llm" and note["sensitive"] is True


def test_policy_artifacts_generated():
    p = client.get("/policy").json()
    assert "CREATE OR REPLACE MASKING POLICY" in p["snowflake_ddl"]
    assert 'resource "snowflake_masking_policy"' in p["terraform"]
    assert p["coverage"]["fully_covered"] is False
    # plain-text variants are paste-ready
    assert client.get("/policy/ddl").text.startswith("-- maskline")
    assert "terraform {" in client.get("/policy/terraform").text


def test_gate_fails():
    g = client.get("/gate").json()
    assert g["pass"] is False and g["exit_code"] == 1


def test_scan_full_result():
    s = client.get("/scan").json()
    assert {"classified", "coverage", "risk", "controls", "summary", "gate"} <= set(s)
    assert s["controls"]["grade"] in ("A", "B", "C", "D", "F")


def test_risk_and_controls():
    r = client.get("/risk").json()
    assert r["kanon"]["k_min"] == 1
    assert r["kanon"]["singleton_count"] == r["kanon"]["records"]
    assert len(r["sweep"]) >= 3
    c = client.get("/controls").json()
    assert set(c["frameworks"]) == {"SOC 2", "HIPAA"}


def test_narrative_and_evals():
    n = client.get("/narrative").json()
    assert n["summary"] and "k" in n["summary"].lower()
    e = client.get("/evals").json()
    assert e["sensitivity"]["recall"] >= 0.5
    assert e["invariant"]["holds"] is True


def test_llm_status():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_health_exposes_no_secrets():
    blob = str(client.get("/health").json()).lower()
    for token in ("password", "secret", "api_key", "sk-"):
        assert token not in blob
