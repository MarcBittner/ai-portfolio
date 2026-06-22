"""Retrieval + intent routing over the finance dataset (the RAG layer).

A natural-language question is mapped to one deterministic **intent** and a time
window, then the relevant records are retrieved. The retrieved set is the
*only* ground the copilot may answer from (persona-twin's grounding rule), and
the citation ids returned by :mod:`counsel.compute` are validated against it —
any citation the LLM emits that is not in the retrieved set is dropped as a
hallucination.

Intent routing is deterministic keyword + date parsing (stdlib only) so it works
offline and is testable. It is intentionally simple and transparent: the goal is
a trustworthy boundary, not an NLU showcase. Questions it can't ground map to the
``unknown`` intent, which drives the honest "I can't find that in your records"
refusal rather than a guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

from counsel import compute, data
from counsel.compute import Computation
from counsel.data import Dataset

# Map common words to a canonical category.
_CATEGORY_WORDS: dict[str, str] = {
    "dining": "dining", "restaurant": "dining", "restaurants": "dining",
    "eat": "dining", "eating": "dining", "food": "dining", "coffee": "dining",
    "grocery": "groceries", "groceries": "groceries",
    "transport": "transport", "transit": "transport", "gas": "transport",
    "fuel": "transport", "uber": "transport", "ride": "transport",
    "shopping": "shopping", "shop": "shopping",
    "utility": "utilities", "utilities": "utilities", "bills": "utilities",
    "rent": "rent", "entertainment": "entertainment", "streaming": "entertainment",
    "health": "health", "medical": "health", "travel": "travel", "flight": "travel",
    "fee": "fees", "fees": "fees", "income": "income", "salary": "income",
    "paycheck": "income", "pay": "income",
}

_ACCOUNT_WORDS: dict[str, str] = {
    "checking": "acct_checking", "savings": "acct_savings",
    "credit": "acct_credit", "card": "acct_credit", "brokerage": "acct_brokerage",
    "investment": "acct_brokerage", "investments": "acct_brokerage",
}

_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], start=1)}


@dataclass
class Retrieval:
    intent: str
    question: str
    window_label: str               # human label, e.g. "last month"
    start: str
    end: str
    category: str | None
    account_id: str | None
    records: list[dict] = field(default_factory=list)  # retrieved txns/accounts
    grounded: bool = True           # False → drives the refusal

    def to_dict(self) -> dict:
        return {
            "intent": self.intent, "question": self.question,
            "window_label": self.window_label, "start": self.start, "end": self.end,
            "category": self.category, "account_id": self.account_id,
            "record_count": len(self.records), "grounded": self.grounded,
        }


def _detect_category(q: str) -> str | None:
    for word, cat in _CATEGORY_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", q):
            return cat
    return None


def _detect_account(q: str) -> str | None:
    for word, acct in _ACCOUNT_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", q):
            return acct
    return None


def _detect_window(q: str) -> tuple[str, date, date]:
    """Parse a time window from the question; default to last 30 days."""
    today = data.TODAY
    if "last month" in q or "previous month" in q:
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        start, end = data.month_bounds(last_prev.year, last_prev.month)
        return "last month", start, end
    if "this month" in q:
        start, end = data.month_bounds(today.year, today.month)
        return "this month", start, min(end, today)
    if "this year" in q or "ytd" in q or "year to date" in q:
        return "year to date", date(today.year, 1, 1), today
    if "last year" in q or "past year" in q or "last 12 months" in q:
        return "the last 12 months", today - timedelta(days=365), today
    if "last week" in q or "past week" in q:
        return "the last week", today - timedelta(days=7), today
    for name, num in _MONTHS.items():
        if name in q:
            year = today.year if num <= today.month else today.year - 1
            start, end = data.month_bounds(year, num)
            return name.capitalize(), start, min(end, today)
    return "the last 30 days", today - timedelta(days=30), today


def _records_for(ds: Dataset, ids: list[str]) -> list[dict]:
    out: list[dict] = []
    for cid in ids:
        if cid.startswith("txn_"):
            t = ds.txn(cid)
            if t:
                out.append({"id": t.id, "kind": "transaction", "date": t.date,
                            "merchant": t.merchant, "category": t.category,
                            "amount": t.amount, "account_id": t.account_id})
        elif cid.startswith("acct_"):
            a = ds.account(cid)
            if a:
                out.append({"id": a.id, "kind": "account", "name": a.name,
                            "type": a.type, "mask": a.mask,
                            "balance": data.account_balance(ds, a.id)})
        elif cid.startswith("hold_"):
            h = next((h for h in ds.holdings if h.id == cid), None)
            if h:
                out.append({"id": h.id, "kind": "holding", "symbol": h.symbol,
                            "shares": h.shares, "price": h.price,
                            "value": round(h.shares * h.price, 2)})
    return out


def route(ds: Dataset, question: str) -> tuple[Retrieval, Computation | None]:
    """Map a question to (retrieval, computation). computation is None when the
    question can't be grounded (→ honest refusal)."""
    q = question.lower().strip()
    label, start, end = _detect_window(q)
    category = _detect_category(q)
    account_id = _detect_account(q)

    def make(intent: str, comp: Computation | None, grounded: bool = True,
             win: str | None = None) -> tuple[Retrieval, Computation | None]:
        ids = comp.citation_ids if comp else []
        r = Retrieval(intent=intent, question=question,
                      window_label=win or label, start=start.isoformat(),
                      end=end.isoformat(), category=category,
                      account_id=account_id,
                      records=_records_for(ds, ids), grounded=grounded)
        return r, comp

    # net worth
    if re.search(r"\bnet worth\b|\bnetworth\b|\bhow much.*worth\b", q):
        return make("net_worth", compute.net_worth(ds), win="right now")
    # unusual / suspicious / duplicate
    if re.search(r"unusual|suspicious|fraud|duplicate|double charge|weird|"
                 r"strange|wrong charge", q):
        return make("unusual_charges", compute.unusual_charges(ds),
                    win="the last 45 days")
    # projection
    if re.search(r"project|forecast|will i have|end of month|run out|"
                 r"going to have", q):
        return make("project_balance", compute.project_balance(ds),
                    win="the next 30 days")
    # balance of a specific account
    if account_id and re.search(r"balance|how much.*in|in my", q):
        return make("balance", compute.balance(ds, account_id), win="right now")
    # spend on a category
    if category and re.search(r"spend|spent|spending|cost|pay|paid", q):
        return make("category_spend",
                    compute.category_spend(ds, category, start, end))
    # generic spending breakdown / budget
    if re.search(r"breakdown|where.*money|where did|budget|spend|spent|"
                 r"spending|categor", q):
        return make("spend_breakdown", compute.spend_breakdown(ds, start, end))
    # list transactions
    if re.search(r"\b(transactions?|charges?|purchases?|list|show)\b", q):
        return make("list_transactions",
                    compute.list_transactions(ds, start, end, category))

    # ungrounded → refusal
    r = Retrieval(intent="unknown", question=question, window_label=label,
                  start=start.isoformat(), end=end.isoformat(),
                  category=category, account_id=account_id, records=[],
                  grounded=False)
    return r, None


def validate_citations(cited: list[str], retrieved_ids: list[str]) -> dict:
    """Drop any citation not in the retrieved set (hallucinated). Returns the
    validated ids plus the dropped ones, so the UI can show the gate working."""
    allowed = set(retrieved_ids)
    valid = [c for c in cited if c in allowed]
    dropped = [c for c in cited if c not in allowed]
    return {"valid": valid, "dropped": dropped,
            "n_valid": len(valid), "n_dropped": len(dropped)}
