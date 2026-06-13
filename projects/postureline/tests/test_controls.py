"""Unified multi-framework controls: six frameworks, both surfaces map, roll-up."""

from postureline import controls, scan
from postureline.controls import CATALOG, catalog, evaluate, framework_rollup, frameworks


def test_catalog_carries_all_six_frameworks():
    assert frameworks() == ["SOC 2", "HIPAA", "ISO 27001", "NIST 800-53",
                            "NIST 800-171", "CMMC"]
    for row in catalog():
        for fw in frameworks():
            assert row["frameworks"].get(fw), f"{row['id']} missing {fw}"


def test_warehouse_governance_control_present():
    # GV1.1 is the warehouse-origin de-identification control, anchored on HIPAA.
    assert "GV1.1" in CATALOG
    gv = next(c for c in catalog() if c["id"] == "GV1.1")
    assert gv["frameworks"]["HIPAA"].startswith("164.514")


def test_evaluate_marks_referenced_controls_failing():
    findings = [
        {"id": "DB_EXPOSED", "resource": "db:27017", "severity": "critical",
         "control_ids": ["CC6.6", "CC7.2"], "surface": "exposure"},
    ]
    rows = {c["id"]: c for c in evaluate(findings)}
    assert rows["CC6.6"]["status"] == "fail" and rows["CC6.6"]["finding_count"] == 1
    assert rows["CC6.7"]["status"] == "pass"  # no finding maps to it


def test_evaluate_covers_whole_catalog():
    rows = evaluate([])
    assert {r["id"] for r in rows} == set(CATALOG)
    assert all(r["status"] == "pass" for r in rows)


def test_framework_rollup_aggregates_across_frameworks():
    findings = [
        {"id": "DB_EXPOSED", "resource": "db:27017", "severity": "critical",
         "control_ids": ["CC6.6"], "surface": "exposure"},
    ]
    rows = evaluate(findings)
    fw = {r["framework"]: r for r in framework_rollup(rows)}
    assert "CC6.6" in fw["SOC 2"]["failing_control_ids"]
    assert "164.312(e)(1)" in fw["HIPAA"]["failing_control_ids"]
    assert "A.8.20" in fw["ISO 27001"]["failing_control_ids"]
    assert "SC-7" in fw["NIST 800-53"]["failing_control_ids"]
    assert "SC.L2-3.13.1" in fw["CMMC"]["failing_control_ids"]
    assert {r["controls_total"] for r in framework_rollup(rows)} == {len(CATALOG)}


def test_both_surfaces_findings_map_to_catalog_controls():
    catalog_ids = {c["id"] for c in catalog()}
    for surface in ("warehouse", "exposure"):
        findings = scan.run(surface)["findings"]
        assert findings
        for f in findings:
            assert f["control_ids"]
            assert all(cid in catalog_ids for cid in f["control_ids"])


def test_rollup_consistent_for_both_surfaces():
    for surface in ("warehouse", "exposure"):
        r = scan.run(surface)
        failing = [c for c in r["controls"] if c["status"] == "fail"]
        for fw in r["framework_rollup"]:
            mapped = sum(1 for c in failing if fw["framework"] in c["frameworks"])
            assert mapped == fw["controls_failing"]
        assert len(r["framework_rollup"]) == len(controls.frameworks()) == 6
