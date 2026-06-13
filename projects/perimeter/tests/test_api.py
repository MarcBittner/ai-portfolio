from fastapi.testclient import TestClient

from perimeter.api import app

client = TestClient(app)


def test_health():
    b = client.get("/health").json()
    assert b["status"] == "ok"
    assert b["controls"] > 0 and b["frameworks"] == 5
    assert b["exposures"] > 0 and b["grade"]


def test_inventory():
    b = client.get("/inventory").json()
    assert b["summary"]["hosts"] > 0 and b["summary"]["internet_open_services"] > 0
    assert b["hosts"] and b["hosts"][0]["services"]


def test_exposures_carry_controls_and_evidence():
    b = client.get("/exposures").json()
    assert b["findings"]
    assert all(f["controls"] and "evidence" in f for f in b["findings"])
    assert sum(b["severity_counts"].values()) == len(b["findings"])


def test_posture_has_framework_rollup():
    b = client.get("/posture").json()
    assert b["posture"]["grade"] and b["posture"]["controls_failing"] >= 1
    assert len(b["framework_rollup"]) == 5


def test_controls_full_and_filtered():
    full = client.get("/controls").json()
    assert full["catalog"] and len(full["framework_rollup"]) == 5
    one = client.get("/controls", params={"framework": "CMMC"}).json()
    assert one["framework"] == "CMMC"
    assert len(one["framework_rollup"]) == 1
    assert all("framework_id" in c for c in one["controls"])


def test_controls_unknown_framework():
    b = client.get("/controls", params={"framework": "FedRAMP"}).json()
    assert "error" in b


def test_diff_improves():
    d = client.get("/diff").json()
    assert d["after"]["posture"]["score"] > d["before"]["posture"]["score"]
    assert d["fixed_findings"]


def test_gate_decision():
    b = client.get("/gate").json()
    # default estate has open criticals → gate fails with reasons
    assert b["passed"] is False and b["reasons"]


def test_report_covers_criticals():
    n = client.get("/report", params={"mode": "offline"}).json()
    assert n["summary"].strip() and n["top_risks"]
    assert n["remediation"] and n["residual_risk"]
    covered = {r["rule_id"] for r in n["top_risks"]}
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= covered


def test_evidence_json_and_csv():
    j = client.get("/evidence", params={"control": "CC6.6"}).json()
    assert j["control"] == "CC6.6" and j["controls"]
    assert j["controls"][0]["frameworks"]["CMMC"]
    csv_resp = client.get("/evidence", params={"format": "csv"})
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "rule_id" in csv_resp.text and "CC6.6" in csv_resp.text


def test_evals_cover_criticals():
    e = client.get("/evals").json()
    assert e["criticals_covered"] is True and e["coverage_complete"] is True


def test_llm_status():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True
