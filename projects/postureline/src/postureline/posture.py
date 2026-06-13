"""Severity-weighted posture scoring, letter grade, and the remediation diff.

One posture number for either surface. Each finding contributes a severity-weighted
penalty; the penalty is mapped to a 0-100 score through a **saturating** curve
(``score = 100 / (1 + penalty / K)``) rather than a raw subtraction. The curve is
deliberate (perimeter's approach, now shared): a real estate — warehouse OR
internet-facing — routinely carries enough open exposure to drive a linear
``100 − Σpenalty`` straight to zero, which loses all signal. The saturating form
keeps the score monotonic and sensitive across the whole range, so fixing the top
risks always moves the grade measurably.

``diff`` compares two scan states (current vs. ``--remediated``) so a reviewer sees
the lift remediation buys — the "if we do X, our grade goes D → C" view — for either
surface, including which controls and frameworks flip fail → pass.
"""

from __future__ import annotations

SEVERITY_WEIGHT = {"critical": 10, "high": 6, "medium": 3, "low": 1}
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}

# Saturation constant: the penalty at which the score is halved (50/100). Tuned so a
# handful of criticals lands in D/F and clearing them lifts the grade visibly.
_SATURATION_K = 30


def grade(score: int) -> str:
    return ("A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60
            else "D" if score >= 40 else "F")


def severity_counts(findings: list[dict]) -> dict[str, int]:
    return {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITY_WEIGHT}


def score_for(penalty: int) -> int:
    """Map a severity-weighted penalty to a 0-100 score via the saturating curve."""
    return round(100 / (1 + penalty / _SATURATION_K)) if penalty else 100


def posture(findings: list[dict], control_rows: list[dict],
            framework_rows: list[dict]) -> dict:
    """The headline posture: severity-weighted score, grade, and framework totals."""
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    score = score_for(penalty)
    failing = sum(1 for c in control_rows if c["status"] == "fail")
    fw_failing = sum(1 for r in framework_rows if r["status"] == "fail")
    return {
        "score": score,
        "grade": grade(score),
        "risk_penalty": penalty,
        "findings_count": len(findings),
        "controls_failing": failing,
        "controls_total": len(control_rows),
        "frameworks_failing": fw_failing,
        "frameworks_total": len(framework_rows),
    }


def diff(before: dict, after: dict) -> dict:
    """Posture-over-time delta between two scan states (current → remediated).

    Reports the score/grade lift, which findings were fixed, and which controls and
    frameworks flip fail → pass — the prioritized, defensible remediation view.
    Works for either surface (both produce the same ``{findings, controls,
    framework_rollup, posture, severity_counts}`` shape).
    """
    b_p, a_p = before["posture"], after["posture"]
    fixed = sorted({f["id"] for f in before["findings"]}
                   - {f["id"] for f in after["findings"]})
    b_fail = {c["id"] for c in before["controls"] if c["status"] == "fail"}
    a_fail = {c["id"] for c in after["controls"] if c["status"] == "fail"}
    b_fw = {r["framework"] for r in before["framework_rollup"] if r["status"] == "fail"}
    a_fw = {r["framework"] for r in after["framework_rollup"] if r["status"] == "fail"}
    a_fw_fail = {r["framework"]: r["controls_failing"]
                 for r in after["framework_rollup"]}
    framework_progress = [
        {"framework": r["framework"],
         "before_failing": r["controls_failing"],
         "after_failing": a_fw_fail.get(r["framework"], 0)}
        for r in before["framework_rollup"]
    ]
    return {
        "before": {"posture": b_p, "severity_counts": before["severity_counts"]},
        "after": {"posture": a_p, "severity_counts": after["severity_counts"]},
        "score_delta": a_p["score"] - b_p["score"],
        "fixed_findings": fixed,
        "controls_remediated": sorted(b_fail - a_fail),
        "frameworks_cleared": sorted(b_fw - a_fw),
        "framework_progress": framework_progress,
    }
