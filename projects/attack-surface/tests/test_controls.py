from attack_surface.controls import CATALOG, catalog, evaluate


def test_catalog_has_both_frameworks():
    fw = {c["framework"] for c in catalog()}
    assert "SOC 2" in fw and "ISO 27001" in fw


def test_evaluate_marks_referenced_controls_failing():
    findings = [
        {"rule_id": "DB_EXPOSED", "asset": "db:5432", "severity": "critical",
         "controls": ["SOC2:CC6.6", "ISO:A.8.20"]},
    ]
    rows = {c["id"]: c for c in evaluate(findings)}
    assert rows["SOC2:CC6.6"]["status"] == "fail"
    assert rows["SOC2:CC6.6"]["finding_count"] == 1
    # a control with no mapped finding stays passing
    assert rows["SOC2:CC6.1"]["status"] == "pass"


def test_evaluate_covers_whole_catalog():
    rows = evaluate([])
    assert {r["id"] for r in rows} == set(CATALOG)
    assert all(r["status"] == "pass" for r in rows)
