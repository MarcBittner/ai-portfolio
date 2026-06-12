"""The contributions store (SQLite stdlib; stands in for Postgres).

Builds the table, loads the seeded rows, and captures the aggregation query's plan
**before and after** the index is created — the query plan treated as a
first-class, version-controlled artifact. In production this is Postgres with the
table declaratively partitioned by ``cycle``; here the composite index gives the
same access pattern (cycle+committee lookups become an index search, not a scan).
"""

import os
import sqlite3
import time

from txn_ledger.generate import generate

ROWS = int(os.environ.get("TXN_LEDGER_ROWS", "60000"))

# the hot path: an FEC-style per-committee rollup for one cycle.
AGG_SQL = (
    "SELECT committee_id, COUNT(*) n, SUM(amount) total, "
    "COUNT(DISTINCT donor_id) donors, "
    "SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END) itemized "
    "FROM contributions WHERE cycle = ? GROUP BY committee_id ORDER BY total DESC"
)

_conn: sqlite3.Connection | None = None
_meta: dict = {}


def conn() -> sqlite3.Connection:
    if _conn is None:
        build(ROWS)
    assert _conn is not None
    return _conn


def _plan(c: sqlite3.Connection) -> list[str]:
    return [r["detail"] for r in
            c.execute("EXPLAIN QUERY PLAN " + AGG_SQL, (2026,)).fetchall()]


def build(n: int = ROWS, seed: int = 42) -> dict:
    """(Re)build the dataset; capture load time + plan before/after indexing."""
    global _conn, _meta
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE contributions("
              "id INTEGER PRIMARY KEY, donor_id TEXT, committee_id TEXT, "
              "cycle INTEGER, amount REAL, ts TEXT)")
    t0 = time.perf_counter()
    c.executemany("INSERT INTO contributions VALUES(?,?,?,?,?,?)", generate(n, seed))
    c.commit()
    load_ms = (time.perf_counter() - t0) * 1000

    plan_before = _plan(c)   # full scan — no index yet
    # composite, covering index: cycle+committee lookups become index searches
    c.execute("CREATE INDEX idx_cycle_committee "
              "ON contributions(cycle, committee_id, donor_id, amount)")
    c.execute("ANALYZE")
    plan_after = _plan(c)

    _conn = c
    _meta = {"rows": n, "seed": seed, "load_ms": round(load_ms, 1),
             "plan_before": plan_before, "plan_after": plan_after,
             "indexes": ["idx_cycle_committee(cycle, committee_id, donor_id, amount)"]}
    return _meta


def meta() -> dict:
    if not _meta:
        build(ROWS)
    return _meta
