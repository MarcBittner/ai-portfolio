"""Map governance findings to SOC 2 + HIPAA controls and roll up a posture score.

This is the security-as-enabler layer: it turns the technical findings (coverage
gaps, re-identification risk) into the control language an auditor and a customer's
security review actually speak —

- **SOC 2** CC6.1 (logical access controls) and CC6.6 (boundary protection).
- **HIPAA** 164.312(a)(1) (access control / technical safeguards) and 164.514
  (de-identification — Safe Harbor / Expert Determination).

Each control gets a deterministic pass/fail from the scan findings, and a
severity-weighted posture **score (0–100) + letter grade**. Every sensitive
column is required to map to at least one control (an invariant the eval checks).
"""

from __future__ import annotations

# Control catalog. Each control declares which finding it is evaluated against and
# the severity weight it carries in the posture rollup.
CONTROLS = [
    {
        "id": "SOC2-CC6.1",
        "framework": "SOC 2",
        "title": "Logical access — sensitive columns restricted by role",
        "classes": ["direct", "quasi"],
        "weight": 3,
        "check": "masking_coverage",
    },
    {
        "id": "SOC2-CC6.6",
        "framework": "SOC 2",
        "title": "Boundary protection — row-access scoping by role",
        "classes": ["clinical", "financial"],
        "weight": 2,
        "check": "row_access_present",
    },
    {
        "id": "HIPAA-164.312(a)",
        "framework": "HIPAA",
        "title": "Access control — technical safeguards on PHI columns",
        "classes": ["direct", "quasi"],
        "weight": 3,
        "check": "masking_coverage",
    },
    {
        "id": "HIPAA-164.514",
        "framework": "HIPAA",
        "title": "De-identification — re-identification risk within tolerance",
        "classes": ["quasi"],
        "weight": 3,
        "check": "kanon_threshold",
    },
]

# Minimum acceptable k for the de-identification control to pass.
K_THRESHOLD = 2


def _grade(score: float) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"


def evaluate(classified: list[dict], coverage: dict, kanon: dict,
             row_access_present: bool = True) -> dict:
    """Evaluate every control against the findings → pass/fail + posture score."""
    sensitive = [c for c in classified if c["sensitive"]]
    results = []
    earned = total = 0
    for ctrl in CONTROLS:
        in_scope = [c for c in sensitive if c["class"] in ctrl["classes"]]
        check = ctrl["check"]
        if check == "masking_coverage":
            uncovered = [u for u in coverage["uncovered_columns"]
                         if u["class"] in ctrl["classes"]]
            passed = not uncovered
            detail = (f"{len(uncovered)} sensitive column(s) without a masking "
                      f"policy" if uncovered
                      else f"all {len(in_scope)} in-scope column(s) masked")
        elif check == "row_access_present":
            passed = row_access_present
            detail = ("row-access policy applied" if passed
                      else "no row-access policy on the fact table")
        elif check == "kanon_threshold":
            passed = kanon["k_min"] >= K_THRESHOLD
            detail = (f"k_min={kanon['k_min']} "
                      f"(threshold k>={K_THRESHOLD}); "
                      f"{kanon['singleton_count']}/{kanon['records']} singletons")
        else:  # pragma: no cover - defensive
            passed, detail = False, "unknown check"
        w = ctrl["weight"]
        total += w
        if passed:
            earned += w
        results.append({
            "id": ctrl["id"], "framework": ctrl["framework"],
            "title": ctrl["title"], "status": "pass" if passed else "fail",
            "weight": w, "in_scope_columns": len(in_scope), "detail": detail,
        })
    score = round(100 * earned / total, 1) if total else 100.0
    passed_n = sum(1 for r in results if r["status"] == "pass")
    return {
        "controls": results,
        "passed": passed_n,
        "failed": len(results) - passed_n,
        "posture_score": score,
        "grade": _grade(score),
        "frameworks": sorted({c["framework"] for c in CONTROLS}),
    }


def mapped_controls_for(column_class: str) -> list[str]:
    """Which control ids a given column class maps to (invariant check support)."""
    return [c["id"] for c in CONTROLS if column_class in c["classes"]]
