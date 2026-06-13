"""Warehouse surface: classification + policy-as-code + k-anon + CI gate."""

from postureline import classify, data, kanon, scan, warehouse_policy
from postureline.scanners.warehouse import gate


def setup_function():
    data.reset()


# --- warehouse introspection (Snowflake-compatible SQL on DuckDB) -----------

def test_tables_and_snowflake_types():
    assert set(data.tables()) == {"CLAIMS", "MEMBERS", "PROVIDERS"}
    cols = {c["name"]: c["type"] for c in data.columns("MEMBERS")}
    assert cols["MEMBER_NAME"] == "VARCHAR" and cols["DOB"] == "DATE"
    claims = {c["name"]: c["type"] for c in data.columns("CLAIMS")}
    assert claims["ALLOWED_AMOUNT"].startswith("NUMBER")
    n = data.query(f"SELECT COUNT(*) FROM {data.FQ}.MEMBERS")[0][0]
    assert n == 12


# --- classification (heuristics + LLM offline fallback for free-text PHI) ----

def test_structured_and_freetext_classification():
    rows = {(r["table"], r["column"]): r for r in classify.classify_all()}
    assert rows[("MEMBERS", "SSN")]["class"] == "direct"
    assert rows[("MEMBERS", "DOB")]["class"] == "quasi"
    assert rows[("CLAIMS", "DX_CODE")]["class"] == "clinical"
    assert rows[("CLAIMS", "ALLOWED_AMOUNT")]["class"] == "financial"
    note = rows[("CLAIMS", "CLAIM_NOTE")]
    assert note["method"] == "llm" and note["provider"] == "offline"
    assert note["sensitive"] is True
    assert {"EMAIL", "PHONE"} <= set(note["phi_types"])


# --- policy-as-code: Snowflake DDL + Terraform ------------------------------

def test_policy_as_code_generates_snowflake_and_terraform():
    classified = classify.classify_all()
    ddl = warehouse_policy.generate_snowflake_ddl(classified)
    assert "CREATE OR REPLACE MASKING POLICY MASK_DIRECT_IDENTIFIER" in ddl
    assert "CREATE OR REPLACE ROW ACCESS POLICY RAP_CLAIMS_BY_ROLE" in ddl
    assert "CURRENT_ROLE()" in ddl and "ANALYTICS.CLAIMS.MEMBERS" in ddl
    tf = warehouse_policy.generate_terraform(classified)
    assert 'resource "snowflake_masking_policy"' in tf
    assert 'resource "snowflake_row_access_policy"' in tf
    assert 'source  = "Snowflake-Labs/snowflake"' in tf


def test_coverage_gap_is_the_free_text_column():
    cov = warehouse_policy.coverage(classify.classify_all())
    assert cov["fully_covered"] is False
    gaps = {(u["table"], u["column"]) for u in cov["uncovered_columns"]}
    assert ("CLAIMS", "CLAIM_NOTE") in gaps
    assert ("MEMBERS", "SSN") not in gaps and ("MEMBERS", "DOB") not in gaps


# --- k-anonymity ------------------------------------------------------------

def test_kanon_finds_singletons_and_sweep_raises_k():
    k = kanon.k_anonymity()
    assert k["k_min"] == 1 and k["singleton_count"] == k["records"]
    assert k["within_tolerance"] is False
    sweep = kanon.generalization_sweep()
    assert len(sweep) >= 3
    # coarsest generalization raises k above the singleton-only baseline
    assert max(s["k_min"] for s in sweep) > 1


# --- CI gate ----------------------------------------------------------------

def test_gate_fails_on_uncovered_column():
    g = gate()
    assert g["pass"] is False and g["exit_code"] == 1
    assert "CLAIM_NOTE" in g["reason"]
    assert scan.gate()["pass"] is False


# --- the warehouse scanner emits findings mapped to controls ----------------

def test_warehouse_scan_emits_mapped_findings_and_posture():
    r = scan.run("warehouse")
    ids = {f["id"] for f in r["findings"]}
    assert "UNMASKED_PHI" in ids and "REID_RISK" in ids
    # UNMASKED_PHI → CC6.1 (access/masking); REID_RISK → GV1.1 (de-identification)
    by_id = {f["id"]: f for f in r["findings"]}
    assert by_id["UNMASKED_PHI"]["control_ids"] == ["CC6.1"]
    assert by_id["REID_RISK"]["control_ids"] == ["GV1.1"]
    assert r["posture"]["grade"] in ("A", "B", "C", "D", "F")
    assert r["extras"]["policy"]["snowflake_ddl"]


def test_warehouse_remediation_diff_clears_findings():
    d = scan.diff("warehouse")
    assert d["after"]["posture"]["score"] > d["before"]["posture"]["score"]
    assert {"UNMASKED_PHI", "REID_RISK"} <= set(d["fixed_findings"])
    assert {"CC6.1", "GV1.1"} <= set(d["controls_remediated"])
