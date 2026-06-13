"""Orchestrate a governed posture run for EITHER surface.

``run(surface, remediated=False)`` is the one pipeline both demos share:

    pick scanner (registry) → findings → unified multi-framework controls
      → severity-weighted posture → (optional) LLM narrative

The scanner is the only surface-specific step; everything after it is identical for
warehouse and exposure, which is the whole point of the merge. ``diff(surface)``
runs the current and ``--remediated`` states through the same pipeline so the
posture lift is comparable across surfaces. ``gate()`` is the warehouse CI hook
(unmasked sensitive column ⇒ fail); ``exposure_gate()`` is perimeter's posture
threshold gate.
"""

from __future__ import annotations

from postureline import controls, narrative, posture, scanners
from postureline.scanners.warehouse import gate as warehouse_gate


def run(surface: str, remediated: bool = False, *,
        mode: str | None = None, include_narrative: bool = False) -> dict:
    """Full governed report for ``surface`` (the shared core pipeline)."""
    scanner = scanners.get(surface)
    result = scanner(remediated=remediated, mode=mode)
    findings = result.dicts()
    findings.sort(key=lambda f: (posture.SEVERITY_ORDER.get(f["severity"], 9),
                                 f["resource"]))

    control_rows = controls.evaluate(findings)
    framework_rows = controls.framework_rollup(control_rows)
    sev = posture.severity_counts(findings)
    report = {
        "surface": surface,
        "remediated": remediated,
        "findings": findings,
        "severity_counts": sev,
        "controls": control_rows,
        "framework_rollup": framework_rows,
        "posture": posture.posture(findings, control_rows, framework_rows),
        "extras": result.extras,
    }
    if include_narrative:
        report["narrative"] = narrative.generate(report, mode=mode)
    return report


def diff(surface: str) -> dict:
    """Before/after the remediation wave for ``surface``: posture lift + flips."""
    d = posture.diff(run(surface, remediated=False), run(surface, remediated=True))
    d["surface"] = surface
    return d


def gate(*, mode: str | None = None) -> dict:
    """Warehouse CI gate: any unmasked sensitive column ⇒ fail (exit 1)."""
    return warehouse_gate(mode=mode)


def exposure_gate(min_score: int = 60,
                  fail_on: tuple[str, ...] = ("critical",)) -> dict:
    """Exposure CI gate: pass only if posture clears ``min_score`` and no exposure
    of a disallowed severity is open."""
    report = run("exposure")
    p = report["posture"]
    blocking = [f for f in report["findings"] if f["severity"] in fail_on]
    reasons: list[str] = []
    if p["score"] < min_score:
        reasons.append(f"posture {p['score']} < min_score {min_score}")
    if blocking:
        rules = sorted({f["id"] for f in blocking})
        reasons.append(f"{len(blocking)} {'/'.join(fail_on)} exposure(s) open: "
                       f"{', '.join(rules)}")
    return {
        "passed": not reasons,
        "score": p["score"],
        "grade": p["grade"],
        "min_score": min_score,
        "fail_on": list(fail_on),
        "blocking_exposures": len(blocking),
        "reasons": reasons,
    }
