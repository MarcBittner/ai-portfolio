"""End-of-quarter surge simulation.

Fires N aggregation queries (the spiky read pattern of a filing deadline) and
reports throughput + latency percentiles. The point is that the indexed hot-path
query holds its latency under a burst — what an infra engineer checks before a
known traffic spike. (A production deployment fronts Postgres with a connection
pool; here the in-memory store serializes, so this measures query cost under
volume, not concurrency.)
"""

import time

from txn_ledger.generate import CYCLES
from txn_ledger.queries import aggregate


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    return round(sorted_vals[min(len(sorted_vals) - 1, int(q * len(sorted_vals)))], 2)


def surge(n: int = 500) -> dict:
    n = max(1, min(20000, n))
    durations: list[float] = []
    t0 = time.perf_counter()
    for i in range(n):
        cycle = CYCLES[i % len(CYCLES)]
        s = time.perf_counter()
        aggregate(cycle)
        durations.append((time.perf_counter() - s) * 1000)
    wall = time.perf_counter() - t0
    durations.sort()
    return {
        "queries": n,
        "wall_ms": round(wall * 1000, 1),
        "qps": round(n / wall, 1) if wall else 0.0,
        "p50_ms": _pct(durations, 0.50),
        "p95_ms": _pct(durations, 0.95),
        "p99_ms": _pct(durations, 0.99),
        "max_ms": round(durations[-1], 2),
    }
