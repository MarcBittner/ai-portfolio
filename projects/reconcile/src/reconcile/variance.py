"""Reconciliation engine: diff extracted line items against the baseline contract
and the market-rate table, classify each line, and estimate recoverable dollars.

Verdicts:
  ok         — within the market band (and within tolerance of the contract rate)
  over       — unit cost exceeds the market high and/or the contract rate + tol
  under      — unit cost below the market low (possible error or a genuine credit)
  new_scope  — CSI not in the baseline but priced within market (added work)
  unknown    — CSI in neither baseline nor market; cannot be verified → review

Money-path discipline: any ``over`` / ``unknown`` line, any line with material
recoverable dollars, or any low-confidence line is flagged ``needs_review`` so a
human estimator stays on the decisions that move money.
"""

from dataclasses import asdict, dataclass

from reconcile.data import BASELINE, MARKET
from reconcile.extract import LineItem

BASELINE_TOL = 0.10          # contract-rate tolerance before "over"
REVIEW_MONEY = 1000.0        # recoverable $ at/above which a human must review
REVIEW_CONFIDENCE = 0.70     # extraction confidence below which a human must review


@dataclass
class ReconciledLine:
    csi: str
    description: str
    quantity: float
    unit: str
    unit_cost: float
    total: float
    verdict: str
    benchmark_unit_cost: float | None
    baseline_unit_cost: float | None
    market_low: float | None
    market_high: float | None
    delta_unit: float | None
    delta_pct: float | None
    recoverable: float
    confidence: float
    needs_review: bool
    rationale: str
    start: int | None = None
    end: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _classify(item: LineItem) -> ReconciledLine:
    base = BASELINE.get(item.csi)
    band = MARKET.get(item.csi)
    base_uc = base.unit_cost if base else None
    benchmark = base_uc if base_uc is not None else (band.typical if band else None)

    over_market = band is not None and item.unit_cost > band.high
    over_baseline = base_uc is not None and item.unit_cost > base_uc * (1 + BASELINE_TOL)
    # lump-sum lines aren't unit-rate comparable, so "below market" is meaningless
    under_market = (
        band is not None and item.unit_cost < band.low and item.unit != "LS"
    )

    if base is None and band is None:
        verdict = "unknown"
    elif over_market or over_baseline:
        verdict = "over"
    elif base is None:
        verdict = "new_scope"
    elif under_market:
        verdict = "under"
    else:
        verdict = "ok"

    # fair ceiling = the most generous defensible unit cost; overage above it is
    # the recoverable estimate.
    ceilings = [c for c in (base_uc, (band.high if band else None)) if c is not None]
    fair_ceiling = max(ceilings) if ceilings else None
    recoverable = 0.0
    if fair_ceiling is not None and item.unit_cost > fair_ceiling:
        recoverable = round((item.unit_cost - fair_ceiling) * item.quantity, 2)

    delta_unit = round(item.unit_cost - benchmark, 2) if benchmark else None
    delta_pct = (round((item.unit_cost - benchmark) / benchmark, 4)
                 if benchmark else None)

    needs_review = (
        verdict in ("over", "unknown")
        or recoverable >= REVIEW_MONEY
        or item.confidence < REVIEW_CONFIDENCE
    )
    rationale = _rationale(verdict, item, base_uc, band, recoverable)

    return ReconciledLine(
        csi=item.csi, description=item.description, quantity=item.quantity,
        unit=item.unit, unit_cost=item.unit_cost, total=item.total, verdict=verdict,
        benchmark_unit_cost=benchmark, baseline_unit_cost=base_uc,
        market_low=(band.low if band else None),
        market_high=(band.high if band else None),
        delta_unit=delta_unit, delta_pct=delta_pct, recoverable=recoverable,
        confidence=item.confidence, needs_review=needs_review, rationale=rationale,
        start=item.start, end=item.end,
    )


def _rationale(verdict, item, base_uc, band, recoverable) -> str:
    parts: list[str] = []
    if base_uc is not None:
        parts.append(f"contract rate ${base_uc:,.2f}/{item.unit}")
    if band is not None:
        parts.append(f"market ${band.low:,.2f}–${band.high:,.2f}")
    ctx = "; ".join(parts) if parts else "no baseline or market reference"
    rate = f"${item.unit_cost:,.2f}/{item.unit}"
    if verdict == "over":
        return f"{rate} exceeds {ctx}; ~${recoverable:,.2f} recoverable."
    if verdict == "unknown":
        return f"CSI {item.csi} not in contract/market data ({ctx}) — verify scope."
    if verdict == "new_scope":
        return f"Added scope, not in contract; priced within {ctx}."
    if verdict == "under":
        return f"{rate} is below {ctx} — confirm it isn't an error."
    return f"{rate} is within {ctx}."


def reconcile_items(items: list[LineItem]) -> dict:
    """Reconcile extracted line items; return lines + a summary."""
    lines = [_classify(it) for it in items]
    n_over = sum(1 for ln in lines if ln.verdict == "over")
    return {
        "lines": [ln.as_dict() for ln in lines],
        "summary": {
            "line_count": len(lines),
            "flagged_over": n_over,
            "needs_review": sum(1 for ln in lines if ln.needs_review),
            "document_total": round(sum(ln.total for ln in lines), 2),
            "recoverable_total": round(sum(ln.recoverable for ln in lines), 2),
        },
    }
