"""Trust-gated agency: the copilot PROPOSES, a human APPROVES, code APPLIES.

This is counsel's "earn trust before agency" boundary made mechanical. The
copilot can *propose* three kinds of action — flag a suspicious charge, set a
budget, recommend a rebalance — but **proposing is the only thing it can do on
its own.** A proposal lands in an approval queue with status ``pending`` and a
plain-English description of exactly what would happen. Nothing changes.

Only when a human explicitly approves a proposal does deterministic code
*apply* it — and even then the effect is **simulated**: it mutates an in-memory
copy of the world (a dict of effects), never the ground-truth dataset in
:mod:`counsel.data`. Declining is equally explicit and terminal. The queue is
the audit log an interviewer can point at to see the gate holding: no proposal
can reach ``applied`` without passing through ``approve()``.

Pure stdlib, in-process, no LLM. The LLM may *suggest* which proposals to make
(it narrates), but the proposals themselves are built here from code-computed
facts, and only these typed action kinds exist — an arbitrary action a model
might dream up has nowhere to go.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from counsel import compute
from counsel.data import Dataset

# The ONLY action kinds the agent may propose. Anything else is rejected at the
# door — the model cannot invent a new capability.
ACTION_KINDS = ("flag_charge", "set_budget", "recommend_rebalance")

_VALID_STATUS = ("pending", "approved", "applied", "declined")


@dataclass
class Proposal:
    id: str
    kind: str                       # one of ACTION_KINDS
    title: str                      # short human label
    rationale: str                  # why, in plain English (code-derived)
    params: dict                    # typed, code-built parameters
    citation_ids: list[str]         # records backing the proposal
    status: str = "pending"
    created_at: str = ""
    decided_at: str | None = None
    effect: dict | None = None      # the SIMULATED result, set only on apply

    def to_dict(self) -> dict:
        return asdict(self)


class ApprovalQueue:
    """In-memory, thread-safe queue. Reset per-process; never touches ground truth."""

    def __init__(self) -> None:
        self._items: dict[str, Proposal] = {}
        self._lock = threading.Lock()

    # -- proposing -----------------------------------------------------------
    def propose(self, kind: str, title: str, rationale: str, params: dict,
                citation_ids: list[str]) -> Proposal:
        if kind not in ACTION_KINDS:
            raise ValueError(f"unknown action kind: {kind!r}")
        pid = f"prop_{uuid.uuid4().hex[:10]}"
        p = Proposal(
            id=pid, kind=kind, title=title, rationale=rationale,
            params=dict(params), citation_ids=list(citation_ids),
            status="pending", created_at=_now(),
        )
        with self._lock:
            self._items[pid] = p
        return p

    # -- reading -------------------------------------------------------------
    def list(self, status: str | None = None) -> list[Proposal]:
        with self._lock:
            items = list(self._items.values())
        if status:
            items = [p for p in items if p.status == status]
        return sorted(items, key=lambda p: p.created_at, reverse=True)

    def get(self, pid: str) -> Proposal | None:
        with self._lock:
            return self._items.get(pid)

    # -- deciding ------------------------------------------------------------
    def decide(self, pid: str, approve: bool, ds: Dataset) -> Proposal:
        """Approve+apply, or decline. The ONLY path to a non-pending status.

        Raises ``KeyError`` for an unknown id and ``ValueError`` if the proposal
        is already decided (idempotency guard — no double-apply).
        """
        with self._lock:
            p = self._items.get(pid)
            if p is None:
                raise KeyError(pid)
            if p.status != "pending":
                raise ValueError(f"proposal {pid} already {p.status}")
            if not approve:
                p.status = "declined"
                p.decided_at = _now()
                return p
            # approved → deterministic, SIMULATED apply against a copy.
            p.effect = _apply_simulated(p, ds)
            p.status = "applied"
            p.decided_at = _now()
            return p

    def reset(self) -> None:
        with self._lock:
            self._items.clear()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Deterministic, SIMULATED application of an approved proposal.                #
# Returns a dict of effects; ground-truth data is never mutated.              #
# --------------------------------------------------------------------------- #

def _apply_simulated(p: Proposal, ds: Dataset) -> dict:
    if p.kind == "flag_charge":
        # "Flagging" is recording a dispute intent on a copy — no real money moves.
        ids = p.params.get("citation_ids", p.citation_ids)
        recovered = round(sum(abs(t.amount) for t in ds.transactions
                              if t.id in set(ids) and t.amount < 0), 2)
        return {"action": "flagged_for_dispute", "txn_ids": list(ids),
                "would_dispute_usd": recovered, "real_money_moved": False,
                "note": "Simulated: marked for dispute review on a copy of the ledger."}
    if p.kind == "set_budget":
        cat = p.params.get("category", "")
        limit = float(p.params.get("monthly_limit", 0.0))
        return {"action": "budget_set", "category": cat, "monthly_limit": limit,
                "real_money_moved": False,
                "note": f"Simulated: a ${limit:,.0f}/mo {cat} budget would be created."}
    if p.kind == "recommend_rebalance":
        moves = p.params.get("moves", [])
        return {"action": "rebalance_simulated", "moves": moves,
                "real_money_moved": False,
                "note": ("Simulated: target allocation modeled on a copy; "
                         "no trades placed.")}
    return {"action": "noop", "real_money_moved": False}


# --------------------------------------------------------------------------- #
# Proposal *builders*: code-derived from the dataset, never model-authored.    #
# Each returns a (kind, title, rationale, params, citation_ids) tuple the      #
# queue/API turns into a Proposal. The LLM may say "you should flag these";    #
# the actual proposal content is computed here so the numbers are trustworthy. #
# --------------------------------------------------------------------------- #

def build_flag_charge(ds: Dataset) -> tuple | None:
    """Propose flagging the deterministically-detected unusual charges."""
    comp = compute.unusual_charges(ds)
    if not comp.citation_ids:
        return None
    flagged = comp.detail["flagged"]
    total = round(sum(abs(f["amount"]) * f.get("count", 1) for f in flagged), 2)
    kinds = ", ".join(sorted({f["type"] for f in flagged}))
    title = f"Flag {len(flagged)} suspicious charge(s) for review"
    rationale = (
        f"Code flagged {len(flagged)} charge(s) ({kinds}) totaling ${total:,.2f} "
        "as duplicates or category outliers. Flagging records a dispute intent — "
        "it does not move money or contact anyone until you approve.")
    return ("flag_charge", title, rationale,
            {"citation_ids": comp.citation_ids, "total_usd": total},
            comp.citation_ids)


def build_set_budget(ds: Dataset, category: str | None = None) -> tuple | None:
    """Propose a budget for the top discretionary category over the last 90 days."""
    from datetime import timedelta

    from counsel import data
    end = data.TODAY
    start = end - timedelta(days=90)
    comp = compute.spend_breakdown(ds, start, end)
    by_cat = comp.detail["by_category"]
    if not by_cat:
        return None
    if category and category in by_cat:
        cat = category
    else:
        # top non-essential category (skip rent/utilities — not discretionary)
        cat = next((c for c in by_cat if c not in ("rent", "utilities")),
                   next(iter(by_cat)))
    monthly = round(by_cat[cat] / 3.0, 2)            # 90 days ≈ 3 months
    suggested = round(monthly * 0.9, 0)              # a 10% trim, rounded
    title = f"Set a ${suggested:,.0f}/mo budget for {cat}"
    rationale = (
        f"Over the last 90 days you spent ${by_cat[cat]:,.2f} on {cat} "
        f"(~${monthly:,.2f}/mo). A ${suggested:,.0f}/mo budget is a ~10% trim. "
        "Approving only creates the budget in a simulation — nothing is enforced.")
    cites = [t.id for t in ds.transactions if t.category == cat
             and data.in_range(t, start, end) and t.amount < 0]
    return ("set_budget", title, rationale,
            {"category": cat, "monthly_limit": suggested,
             "observed_monthly": monthly}, cites)


def build_recommend_rebalance(ds: Dataset, target_bond_pct: float = 30.0
                              ) -> tuple | None:
    """Propose a rebalance toward a target bond allocation (mechanical, not advice).

    This is a *mechanical* drift calculation, framed as a simulation — not an
    investment recommendation (the guardrail blocks "should I buy X"). It only
    proposes; trades are never placed.
    """
    holdings = [h for h in ds.holdings if h.symbol != "CASH"]
    if not holdings:
        return None
    total = sum(h.shares * h.price for h in ds.holdings)
    bond_value = sum(h.shares * h.price for h in ds.holdings if h.symbol == "BND")
    bond_pct = round(100.0 * bond_value / total, 1) if total else 0.0
    drift = round(target_bond_pct - bond_pct, 1)
    if abs(drift) < 1.0:
        return None
    move_usd = round(total * drift / 100.0, 2)
    direction = "into" if drift > 0 else "out of"
    moves = [{"symbol": "BND", "delta_usd": move_usd}]
    title = f"Rebalance {abs(drift):.1f}% {direction} bonds (BND)"
    rationale = (
        f"Your portfolio is {bond_pct:.1f}% bonds vs a {target_bond_pct:.0f}% "
        f"target — a {abs(drift):.1f}% drift (${abs(move_usd):,.2f}). This is a "
        "mechanical drift calc, not investment advice; approving only simulates "
        "the target allocation — no trades are placed.")
    cites = [h.id for h in ds.holdings]
    return ("recommend_rebalance", title, rationale,
            {"moves": moves, "current_bond_pct": bond_pct,
             "target_bond_pct": target_bond_pct, "drift_pct": drift}, cites)


_BUILDERS = {
    "flag_charge": build_flag_charge,
    "set_budget": build_set_budget,
    "recommend_rebalance": build_recommend_rebalance,
}


def build(kind: str, ds: Dataset) -> tuple | None:
    fn = _BUILDERS.get(kind)
    if fn is None:
        return None
    return fn(ds)


# A single process-wide queue the API uses.
QUEUE = ApprovalQueue()
