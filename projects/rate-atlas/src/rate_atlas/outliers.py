"""Rate-outlier detection across the normalized data.

Within each procedure code, flag negotiated rates that are statistical outliers
(rolling on the whole population for that code via a z-score). Surfaces the
"why is this hospital charging 3x for a head CT?" cases a payer/employer cares
about — computed on the canonical surface, so it works regardless of source shape.
"""

import statistics

from rate_atlas import store


def find_outliers(threshold: float = 2.0) -> dict:
    by_code: dict[str, list[dict]] = {}
    for r in store.all_rows():
        by_code.setdefault(r["code"], []).append(r)

    flagged = []
    for code, rows in by_code.items():
        rates = [r["rate"] for r in rows]
        if len(rates) < 3:
            continue
        mean = statistics.fmean(rates)
        sd = statistics.pstdev(rates)
        if sd == 0:
            continue
        for r in rows:
            z = (r["rate"] - mean) / sd
            if abs(z) >= threshold:
                flagged.append({
                    "code": code, "description": r["description"],
                    "hospital": r["hospital"], "payer": r["payer"],
                    "rate": round(r["rate"], 2), "code_mean": round(mean, 2),
                    "zscore": round(z, 2),
                })
    flagged.sort(key=lambda f: -abs(f["zscore"]))
    return {"threshold": threshold, "outliers": flagged, "count": len(flagged)}
