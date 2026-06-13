"""Controls: SOC 2 / HIPAA mapping, posture rollup, and the invariant that every
sensitive column maps to >= 1 control."""

from maskline import classify, controls, policy, risk, warehouse


def setup_function():
    warehouse.reset()


def _posture():
    c = classify.classify_all()
    cov = policy.coverage(c)
    return c, controls.evaluate(c, cov, risk.k_anonymity())


def test_frameworks_present():
    _, p = _posture()
    assert set(p["frameworks"]) == {"SOC 2", "HIPAA"}
    ids = {c["id"] for c in p["controls"]}
    assert {"SOC2-CC6.1", "SOC2-CC6.6", "HIPAA-164.312(a)", "HIPAA-164.514"} == ids


def test_coverage_gap_fails_access_controls():
    _, p = _posture()
    by_id = {c["id"]: c for c in p["controls"]}
    # the uncovered free-text column fails the logical-access controls
    assert by_id["SOC2-CC6.1"]["status"] == "fail"
    assert by_id["HIPAA-164.312(a)"]["status"] == "fail"


def test_kanon_below_threshold_fails_deident_control():
    _, p = _posture()
    by_id = {c["id"]: c for c in p["controls"]}
    assert by_id["HIPAA-164.514"]["status"] == "fail"  # k_min=1 < threshold


def test_posture_score_and_grade():
    _, p = _posture()
    assert 0 <= p["posture_score"] <= 100
    assert p["grade"] in ("A", "B", "C", "D", "F")
    assert p["passed"] + p["failed"] == len(p["controls"])


def test_every_sensitive_column_maps_to_a_control():
    c, _ = _posture()
    for col in c:
        if col["sensitive"]:
            assert controls.mapped_controls_for(col["class"]), (
                f"{col['table']}.{col['column']} ({col['class']}) maps to no control")
