from attack_surface import narrative
from attack_surface.scanner import remediation_diff, scan_fixture


def test_offline_narrative_shape_and_covers_all_criticals():
    report = scan_fixture()
    out = narrative.generate(report, mode="offline")
    assert out["provider"] == "offline"
    assert isinstance(out["summary"], str) and out["summary"].strip()
    # the summary names the grade and references the criticals
    assert report["posture"]["grade"] in out["summary"]
    covered = {r["rule_id"] for r in out["remediations"]}
    crits = {f["rule_id"] for f in report["findings"] if f["severity"] == "critical"}
    assert crits <= covered, "every critical must have remediation guidance"
    # every remediation has concrete steps and a known finding
    for rem in out["remediations"]:
        assert rem["rule_id"] and rem["steps"].strip()


def test_remediation_covers_criticals_and_highs():
    report = scan_fixture()
    out = narrative.generate(report, mode="offline")
    covered = {r["rule_id"] for r in out["remediations"]}
    must = {f["rule_id"] for f in report["findings"]
            if f["severity"] in ("critical", "high")}
    assert must <= covered


def test_evaluate_coverage_complete():
    ev = narrative.evaluate(mode="offline")
    assert ev["criticals_covered"] is True
    assert ev["coverage_complete"] is True
    assert ev["missed"] == []
    assert "ADMIN_NO_AUTH" in ev["criticals"] and "DB_EXPOSED" in ev["criticals"]


def test_parse_falls_back_when_model_returns_garbage():
    report = scan_fixture()
    # _parse must yield the full offline shape when the model output is unusable
    out = narrative._parse("not json at all", report)
    crits = {f["rule_id"] for f in report["findings"] if f["severity"] == "critical"}
    assert crits <= {r["rule_id"] for r in out["remediations"]}
    assert out["summary"].strip()


def test_remediation_diff_raises_posture_and_flips_controls():
    d = remediation_diff()
    assert d["before"]["posture"]["score"] < d["after"]["posture"]["score"]
    assert d["score_delta"] == (d["after"]["posture"]["score"]
                                - d["before"]["posture"]["score"])
    # the two criticals are the fixed findings
    assert set(d["fixed_findings"]) == {"ADMIN_NO_AUTH", "DB_EXPOSED"}
    # controls they uniquely hit flip fail → pass (ADMIN's ISO:A.5.15, DB's ISO:A.8.20)
    assert "ISO:A.5.15" in d["controls_remediated"]
    assert "ISO:A.8.20" in d["controls_remediated"]
    # grade improves D → B
    assert d["before"]["posture"]["grade"] == "D"
    assert d["after"]["posture"]["grade"] == "B"


def test_remediated_scan_drops_the_two_criticals():
    after = scan_fixture(remediated=True)
    rules = {f["rule_id"] for f in after["findings"]}
    assert "ADMIN_NO_AUTH" not in rules and "DB_EXPOSED" not in rules
    # invariants still hold on the remediated state
    assert all(f["controls"] for f in after["findings"])
    for c in after["controls"]:
        if c["status"] == "fail":
            assert c["finding_count"] == len(c["findings"]) >= 1
