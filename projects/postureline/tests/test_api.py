from fastapi.testclient import TestClient

from postureline.api import app

client = TestClient(app)


def test_health():
    b = client.get("/health").json()
    assert b["status"] == "ok"
    assert set(b["surfaces"]) == {"warehouse", "exposure"}
    assert b["frameworks"] == 6 and b["controls"] > 0


def test_scan_both_surfaces():
    for surface in ("warehouse", "exposure"):
        b = client.get(f"/scan/{surface}").json()
        assert b["surface"] == surface
        assert b["findings"] and b["posture"]["grade"]
        assert {"controls", "framework_rollup", "extras"} <= set(b)
        assert all(f["control_ids"] for f in b["findings"])


def test_scan_unknown_surface_404():
    assert client.get("/scan/nope").status_code == 404


def test_controls_full_and_filtered_per_surface():
    full = client.get("/controls", params={"surface": "exposure"}).json()
    assert full["catalog"] and len(full["framework_rollup"]) == 6
    one = client.get("/controls", params={"surface": "exposure",
                                          "framework": "HIPAA"}).json()
    assert one["framework"] == "HIPAA" and len(one["framework_rollup"]) == 1
    assert all("framework_id" in c for c in one["controls"])
    bad = client.get("/controls", params={"surface": "exposure",
                                          "framework": "FedRAMP"}).json()
    assert "error" in bad


def test_posture_and_diff_per_surface():
    for surface in ("warehouse", "exposure"):
        p = client.get("/posture", params={"surface": surface}).json()
        assert p["posture"]["grade"]
        d = client.get("/diff", params={"surface": surface}).json()
        assert d["after"]["posture"]["score"] >= d["before"]["posture"]["score"]
        assert d["fixed_findings"]


def test_report_covers_findings():
    for surface in ("warehouse", "exposure"):
        n = client.get("/report", params={"surface": surface, "mode": "offline"}).json()
        assert n["summary"].strip() and n["top_risks"]
        assert n["remediation"] and n["residual_risk"]
    # exposure board report covers the criticals
    ex = client.post("/report", json={"surface": "exposure", "mode": "offline"}).json()
    covered = {r["id"] for r in ex["top_risks"]}
    assert {"ADMIN_EXPOSED", "DB_EXPOSED"} <= covered


def test_evidence_json_and_csv_per_surface():
    j = client.get("/evidence", params={"surface": "warehouse",
                                        "control": "CC6.1"}).json()
    assert j["control"] == "CC6.1" and j["controls"]
    assert j["controls"][0]["frameworks"]["CMMC"]
    csv_resp = client.get("/evidence", params={"surface": "exposure",
                                               "format": "csv"})
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "finding_id" in csv_resp.text and "CC6.6" in csv_resp.text


def test_warehouse_specific_endpoints():
    p = client.get("/policy").json()
    assert "CREATE OR REPLACE MASKING POLICY" in p["snowflake_ddl"]
    assert 'resource "snowflake_masking_policy"' in p["terraform"]
    assert p["coverage"]["fully_covered"] is False
    assert client.get("/policy/ddl").text.startswith("-- postureline")
    assert "terraform {" in client.get("/policy/terraform").text
    priv = client.get("/privacy").json()
    assert priv["kanon"]["k_min"] == 1 and len(priv["sweep"]) >= 3


def test_gate_both_surfaces():
    wg = client.get("/gate", params={"surface": "warehouse"}).json()
    assert wg["pass"] is False and wg["exit_code"] == 1
    eg = client.get("/gate", params={"surface": "exposure"}).json()
    assert eg["passed"] is False and eg["reasons"]


def test_evals_cover_both_surfaces():
    e = client.get("/evals").json()
    assert e["warehouse"]["sensitivity"]["recall"] >= 0.5
    assert e["warehouse"]["narrative"]["criticals_covered"] is True
    assert e["exposure"]["narrative"]["criticals_covered"] is True
    assert all(e["warehouse"]["invariants"].values())
    assert all(e["exposure"]["invariants"].values())


def test_llm_status():
    s = client.get("/llm").json()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_health_exposes_no_secrets():
    blob = str(client.get("/health").json()).lower()
    for token in ("password", "secret", "api_key", "sk-"):
        assert token not in blob
