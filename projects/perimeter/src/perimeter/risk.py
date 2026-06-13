"""Severity-weighted posture scoring, letter grade, and posture-over-time diff.

The posture is one governance number. Each open exposure contributes a
severity-weighted penalty; the penalty is mapped to a 0-100 score through a
**saturating** curve (``score = 100 / (1 + penalty / K)``) rather than a raw
subtraction. The curve is deliberate: a real internet-facing estate routinely has
enough open exposure to drive a linear ``100 − Σpenalty`` straight to zero, which
loses all signal — every bad estate looks identically "0". The saturating form
keeps the score *monotonic and sensitive* across the whole range, so fixing the top
risks always moves the grade measurably (the board's "if we do X, our grade goes
D → C" view) instead of staying pinned at F.

It stays severity-weighted on purpose — two critical exposures outweigh a pile of
low-severity hardening items, so the headline tracks *risk*, not finding count.
``diff`` compares two estate states (current vs. remediated) so the board sees the
lift remediation buys, not just a static number.
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
        "exposures": len(findings),
        "controls_failing": failing,
        "controls_total": len(control_rows),
        "frameworks_failing": fw_failing,
        "frameworks_total": len(framework_rows),
    }


def diff(before: dict, after: dict) -> dict:
    """Posture-over-time delta between two scan states (current → remediated).

    Reports the score/grade lift, which findings were fixed, and which controls and
    frameworks flip fail → pass — the "if we do X, our grade goes D → B" view that
    turns exposure data into a prioritized, board-defensible remediation plan.
    """
    b_p, a_p = before["posture"], after["posture"]
    fixed = sorted({f["rule_id"] for f in before["findings"]}
                   - {f["rule_id"] for f in after["findings"]})
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
