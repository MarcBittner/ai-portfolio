"""FEC-style aggregation queries over the contributions store, timed."""

import time

from txn_ledger.db import AGG_SQL, conn, meta
from txn_ledger.generate import COMMITTEES, CYCLES, ITEMIZED_THRESHOLD


def cycles() -> list[int]:
    return CYCLES


def committees() -> list[dict]:
    return [{"committee_id": cid, "name": name} for cid, name in COMMITTEES.items()]


def aggregate(cycle: int, committee: str | None = None) -> dict:
    """Per-committee FEC-style rollup for a cycle (or one committee)."""
    sql, params = AGG_SQL, [cycle]
    if committee:
        sql = sql.replace("WHERE cycle = ?",
                          "WHERE cycle = ? AND committee_id = ?")
        params.append(committee)
    t0 = time.perf_counter()
    rows = conn().execute(sql, params).fetchall()
    elapsed = (time.perf_counter() - t0) * 1000
    out = [{"committee_id": r["committee_id"], "name": COMMITTEES.get(r["committee_id"]),
            "contributions": r["n"], "total_raised": round(r["total"], 2),
            "donors": r["donors"], "itemized": round(r["itemized"], 2),
            "unitemized": round(r["total"] - r["itemized"], 2)} for r in rows]
    return {"cycle": cycle, "committee": committee,
            "itemized_threshold": ITEMIZED_THRESHOLD,
            "rows": out, "elapsed_ms": round(elapsed, 2)}


def plan() -> dict:
    """The aggregation query plan before/after the index — the tuning artifact."""
    m = meta()
    return {"query": AGG_SQL, "plan_before_index": m["plan_before"],
            "plan_after_index": m["plan_after"], "indexes": m["indexes"]}


def summary() -> dict:
    c = conn()
    total = c.execute("SELECT COUNT(*) n, SUM(amount) s, "
                      "COUNT(DISTINCT donor_id) d FROM contributions").fetchone()
    return {"rows": total["n"], "total_raised": round(total["s"], 2),
            "distinct_donors": total["d"], "cycles": CYCLES,
            "committees": len(COMMITTEES), "load_ms": meta()["load_ms"]}
