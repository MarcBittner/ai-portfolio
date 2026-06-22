"""Deterministic financial computation — the trust boundary.

This is counsel's equivalent of trueline's "code decides, the model narrates"
rule: **every number a user sees is computed here, in plain Python, from the
ground-truth dataset.** The LLM is never asked for a figure; it is handed the
code-computed result and asked to phrase it. The verify panel in the UI shows
the LLM's stated numbers next to these, and flags any drift — proving the model
cannot fabricate a balance.

Each intent below returns a structured ``result`` with:
  • ``answer_number`` — the headline figure (or None for list-style answers)
  • ``facts``         — the labeled numbers the narrator may state
  • ``citation_ids`` — the transaction/account ids that back the figure, so the
                        copilot can validate the model's citations against them

Pure functions over a :class:`~counsel.data.Dataset`; no LLM, no mutation, no IO.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from counsel import data
from counsel.data import Dataset, Transaction


@dataclass
class Computation:
    """The deterministic result of an intent — the authoritative numbers."""

    intent: str
    answer_number: float | None
    unit: str                       # "usd" | "count" | "" (list)
    facts: dict[str, float] = field(default_factory=dict)
    citation_ids: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)   # extra structured payload

    def to_dict(self) -> dict:
        return {
            "intent": self.intent,
            "answer_number": self.answer_number,
            "unit": self.unit,
            "facts": self.facts,
            "citation_ids": self.citation_ids,
            "detail": self.detail,
        }


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)


# --------------------------------------------------------------------------- #
# Intents                                                                      #
# --------------------------------------------------------------------------- #

def net_worth(ds: Dataset) -> Computation:
    """Assets (deposit + brokerage) minus liabilities (credit card balance)."""
    assets = 0.0
    liabilities = 0.0
    cites: list[str] = []
    per_account: dict[str, float] = {}
    for acct in ds.accounts:
        bal = data.account_balance(ds, acct.id)
        per_account[acct.id] = bal
        cites.append(acct.id)
        if acct.type == "credit":
            # card balance is the signed sum (<=0 means owed); add holdings below
            liabilities += -min(bal, 0.0)
        else:
            assets += bal
    # brokerage holdings market value
    holdings_value = 0.0
    for h in ds.holdings:
        holdings_value += h.shares * h.price
        cites.append(h.id)
    assets += holdings_value
    nw = _round2(assets - liabilities)
    return Computation(
        intent="net_worth", answer_number=nw, unit="usd",
        facts={"assets": _round2(assets), "liabilities": _round2(liabilities),
               "holdings_value": _round2(holdings_value), "net_worth": nw},
        citation_ids=cites,
        detail={"per_account": {k: _round2(v) for k, v in per_account.items()}},
    )


def _category_spend(ds: Dataset, category: str, start: date,
                    end: date) -> tuple[float, list[Transaction]]:
    matched = [t for t in ds.transactions
               if t.category == category and t.amount < 0
               and data.in_range(t, start, end)]
    total = _round2(-sum(t.amount for t in matched))
    return total, matched


def category_spend(ds: Dataset, category: str, start: date,
                   end: date) -> Computation:
    total, matched = _category_spend(ds, category, start, end)
    return Computation(
        intent="category_spend", answer_number=total, unit="usd",
        facts={"total": total, "transactions": float(len(matched))},
        citation_ids=[t.id for t in matched],
        detail={"category": category, "start": start.isoformat(),
                "end": end.isoformat(),
                "transaction_count": len(matched)},
    )


def spend_breakdown(ds: Dataset, start: date, end: date) -> Computation:
    """Total outflow by category over a window (for budgets / 'where did it go')."""
    by_cat: dict[str, float] = defaultdict(float)
    cites: list[str] = []
    for t in ds.transactions:
        if t.amount < 0 and data.in_range(t, start, end) and t.category != "transfer":
            by_cat[t.category] += -t.amount
            cites.append(t.id)
    rounded = {k: _round2(v) for k, v in sorted(
        by_cat.items(), key=lambda kv: -kv[1])}
    total = _round2(sum(rounded.values()))
    return Computation(
        intent="spend_breakdown", answer_number=total, unit="usd",
        facts={"total_outflow": total, **rounded},
        citation_ids=cites,
        detail={"by_category": rounded, "start": start.isoformat(),
                "end": end.isoformat()},
    )


def balance(ds: Dataset, account_id: str) -> Computation:
    bal = data.account_balance(ds, account_id)
    return Computation(
        intent="balance", answer_number=bal, unit="usd",
        facts={"balance": bal}, citation_ids=[account_id],
        detail={"account_id": account_id},
    )


def unusual_charges(ds: Dataset, lookback_days: int = 45) -> Computation:
    """Flag duplicates and statistical outliers in recent spending — deterministic.

    Duplicate: same account+merchant+amount on the same day (a classic double
    charge). Outlier: a charge more than ``k`` standard deviations above the mean
    for its category (and at least 2.5x the category mean). Pure code — the LLM
    only narrates which ones were flagged.
    """
    end = data.TODAY
    start = end - timedelta(days=lookback_days)
    recent = [t for t in ds.transactions
              if t.amount < 0 and data.in_range(t, start, end)
              and t.category not in ("transfer",)]

    # duplicates
    seen: dict[tuple, list[Transaction]] = defaultdict(list)
    for t in recent:
        seen[(t.account_id, t.merchant, t.amount, t.date)].append(t)
    duplicates = [grp for grp in seen.values() if len(grp) > 1]

    # outliers per category (use full-year history for the baseline)
    hist_by_cat: dict[str, list[float]] = defaultdict(list)
    for t in ds.transactions:
        if t.amount < 0 and t.category not in ("transfer", "rent"):
            hist_by_cat[t.category].append(-t.amount)
    outliers: list[Transaction] = []
    for t in recent:
        vals = hist_by_cat.get(t.category, [])
        if len(vals) < 8:
            continue
        mean = statistics.mean(vals)
        sd = statistics.pstdev(vals) or 1.0
        amt = -t.amount
        if amt > mean + 3 * sd and amt > 2.5 * mean:
            outliers.append(t)

    flagged_ids: list[str] = []
    flagged: list[dict] = []
    for grp in duplicates:
        ids = [t.id for t in grp]
        flagged_ids.extend(ids)
        flagged.append({
            "type": "duplicate", "ids": ids, "merchant": grp[0].merchant,
            "amount": grp[0].amount, "date": grp[0].date, "count": len(grp),
        })
    for t in outliers:
        if t.id in flagged_ids:
            continue
        flagged_ids.append(t.id)
        flagged.append({
            "type": "outlier", "ids": [t.id], "merchant": t.merchant,
            "amount": t.amount, "date": t.date, "category": t.category,
        })
    return Computation(
        intent="unusual_charges", answer_number=float(len(flagged)), unit="count",
        facts={"flagged": float(len(flagged)),
               "duplicates": float(len(duplicates)),
               "outliers": float(len(outliers))},
        citation_ids=flagged_ids,
        detail={"flagged": flagged, "lookback_days": lookback_days},
    )


def project_balance(ds: Dataset, account_id: str = "acct_checking",
                    days: int = 30) -> Computation:
    """Project an account balance forward by the average daily net flow.

    Deterministic linear projection over the trailing 90 days — not advice, a
    mechanical extrapolation the narrator must frame as such.
    """
    end = data.TODAY
    start = end - timedelta(days=90)
    flows = [t.amount for t in ds.transactions
             if t.account_id == account_id and data.in_range(t, start, end)]
    daily = _round2(sum(flows) / 90.0)
    current = data.account_balance(ds, account_id)
    projected = _round2(current + daily * days)
    return Computation(
        intent="project_balance", answer_number=projected, unit="usd",
        facts={"current_balance": current, "avg_daily_net": daily,
               "projected_balance": projected, "horizon_days": float(days)},
        citation_ids=[account_id],
        detail={"account_id": account_id, "days": days},
    )


def list_transactions(ds: Dataset, start: date, end: date,
                      category: str | None = None,
                      limit: int = 10) -> Computation:
    rows = [t for t in ds.transactions if data.in_range(t, start, end)
            and (category is None or t.category == category)]
    rows.sort(key=lambda t: t.date, reverse=True)
    rows = rows[:limit]
    return Computation(
        intent="list_transactions", answer_number=float(len(rows)), unit="count",
        facts={"count": float(len(rows))},
        citation_ids=[t.id for t in rows],
        detail={"start": start.isoformat(), "end": end.isoformat(),
                "category": category},
    )
