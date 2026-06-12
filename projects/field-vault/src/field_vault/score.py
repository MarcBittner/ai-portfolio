"""De-identified provider outcome score.

Computed ONLY from non-identifying fields (provider, outcome, amount) on the
de-identified surface — no PHI, no re-identification. Demonstrates that the
analytics the business needs (rank providers by outcomes) runs entirely on the
safe data.
"""

from collections import defaultdict


def provider_scores(deid_records: list[dict]) -> list[dict]:
    by: dict[str, list[dict]] = defaultdict(list)
    for r in deid_records:
        by[r["provider_id"]].append(r)
    out = []
    for provider, rows in by.items():
        n = len(rows)
        adverse = sum(int(r["outcome"]) for r in rows)
        adverse_rate = adverse / n
        avg_amount = sum(float(r["allowed_amount"]) for r in rows) / n
        out.append({
            "provider_id": provider,
            "claims": n,
            "adverse_events": adverse,
            "adverse_rate": round(adverse_rate, 3),
            "outcome_score": round(1 - adverse_rate, 3),   # higher is better
            "avg_allowed_amount": round(avg_amount, 2),
        })
    # rank by outcome_score desc, then cheaper avg as tiebreak
    out.sort(key=lambda p: (-p["outcome_score"], p["avg_allowed_amount"]))
    for rank, p in enumerate(out, 1):
        p["rank"] = rank
    return out
