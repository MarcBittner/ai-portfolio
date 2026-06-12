"""Human-in-the-loop review queue.

A change order can have dozens of lines; an estimator's time should go to the
ones that move money or can't be auto-verified. This builds that worklist from a
reconciliation result — flagged lines, highest recoverable dollars first.
"""


def build_queue(reconciled: dict) -> dict:
    """Return the prioritized review queue from a ``reconcile_items`` result."""
    flagged = [ln for ln in reconciled["lines"] if ln["needs_review"]]
    flagged.sort(key=lambda ln: ln["recoverable"], reverse=True)
    queue = [
        {
            "csi": ln["csi"],
            "description": ln["description"],
            "verdict": ln["verdict"],
            "unit_cost": ln["unit_cost"],
            "recoverable": ln["recoverable"],
            "confidence": ln["confidence"],
            "reason": _reason(ln),
            "rationale": ln["rationale"],
        }
        for ln in flagged
    ]
    return {
        "queue": queue,
        "count": len(queue),
        "recoverable_total": round(sum(ln["recoverable"] for ln in flagged), 2),
    }


def _reason(ln: dict) -> str:
    if ln["verdict"] == "over":
        return "overcharge vs contract/market"
    if ln["verdict"] == "unknown":
        return "no contract or market reference"
    if ln["recoverable"] >= 1000.0:
        return "material recoverable amount"
    if ln["confidence"] < 0.70:
        return "low extraction confidence"
    return "flagged for review"
