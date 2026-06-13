from perimeter import controls, risk
from perimeter.scan import remediation_diff, scan


def _posture_for(findings):
    rows = controls.evaluate(findings)
    fw = controls.framework_rollup(rows)
    return risk.posture(findings, rows, fw)


def test_score_is_severity_weighted_and_saturating():
    assert risk.score_for(0) == 100
    # higher penalty → strictly lower score, never below 0
    assert risk.score_for(10) > risk.score_for(30) > risk.score_for(120) >= 0
    # one critical (10) outweighs several lows (1 each)
    def _f(sev):
        return {"rule_id": "X", "asset": "h:1", "severity": sev, "controls": ["CC6.6"]}
    crit = _posture_for([_f("critical")])
    lows = _posture_for([_f("low")] * 4)
    assert crit["score"] < lows["score"]


def test_grade_bands():
    assert risk.grade(95) == "A"
    assert risk.grade(80) == "B"
    assert risk.grade(65) == "C"
    assert risk.grade(50) == "D"
    assert risk.grade(20) == "F"


def test_posture_reports_control_and_framework_totals():
    p = scan()["posture"]
    assert 0 <= p["score"] <= 100 and p["grade"]
    assert p["controls_failing"] >= 1
    assert p["frameworks_total"] == 5


def test_remediation_diff_improves_posture():
    d = remediation_diff()
    assert d["after"]["posture"]["score"] > d["before"]["posture"]["score"]
    assert d["score_delta"] > 0
    # the top exposures are the ones fixed
    assert {"DB_EXPOSED", "ADMIN_EXPOSED", "EOL_SOFTWARE", "TLS_EXPIRED"} \
        <= set(d["fixed_findings"])
    # boundary-protection and access controls flip fail → pass
    assert {"CC6.1", "CC6.6"} <= set(d["controls_remediated"])


def test_remediation_diff_reports_framework_progress():
    d = remediation_diff()
    # every framework has strictly fewer failing controls after remediation
    for fw in d["framework_progress"]:
        assert fw["after_failing"] < fw["before_failing"]
