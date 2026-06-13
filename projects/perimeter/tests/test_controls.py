from perimeter.controls import (
    CATALOG,
    catalog,
    evaluate,
    framework_rollup,
    frameworks,
)


def test_catalog_carries_all_five_frameworks():
    assert frameworks() == ["SOC 2", "ISO 27001", "NIST 800-53",
                            "NIST 800-171", "CMMC"]
    for row in catalog():
        # every control crosswalks to a non-empty id in each framework
        for fw in frameworks():
            assert row["frameworks"].get(fw)


def test_evaluate_marks_referenced_controls_failing():
    findings = [
        {"rule_id": "DB_EXPOSED", "asset": "db:27017", "severity": "critical",
         "controls": ["CC6.6", "CC7.2"]},
    ]
    rows = {c["id"]: c for c in evaluate(findings)}
    assert rows["CC6.6"]["status"] == "fail"
    assert rows["CC6.6"]["finding_count"] == 1
    # a control with no mapped finding stays passing
    assert rows["CC6.7"]["status"] == "pass"


def test_evaluate_covers_whole_catalog():
    rows = evaluate([])
    assert {r["id"] for r in rows} == set(CATALOG)
    assert all(r["status"] == "pass" for r in rows)


def test_framework_rollup_aggregates_per_framework():
    findings = [
        {"rule_id": "DB_EXPOSED", "asset": "db:27017", "severity": "critical",
         "controls": ["CC6.6"]},
    ]
    rows = evaluate(findings)
    fw = {r["framework"]: r for r in framework_rollup(rows)}
    # CC6.6 fails → its mapped id fails in every framework's view
    assert fw["SOC 2"]["controls_failing"] == 1
    assert "CC6.6" in fw["SOC 2"]["failing_control_ids"]
    assert "A.8.20" in fw["ISO 27001"]["failing_control_ids"]
    assert "SC-7" in fw["NIST 800-53"]["failing_control_ids"]
    assert "SC.L2-3.13.1" in fw["CMMC"]["failing_control_ids"]
    # every framework reports the same control total (full crosswalk)
    assert {r["controls_total"] for r in framework_rollup(rows)} == {len(CATALOG)}


def test_framework_rollup_all_pass_when_no_findings():
    fw = framework_rollup(evaluate([]))
    assert all(r["status"] == "pass" and r["controls_failing"] == 0 for r in fw)
