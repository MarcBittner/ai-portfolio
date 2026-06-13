"""Canonical rates in SQLite (stdlib) — load the normalized records and answer
the question that matters: what does this procedure cost across payers and
hospitals? Indexed by billing code; an in-memory DB here, swap the connection
string for Postgres in production (the schema + queries are the same).
"""

import sqlite3
import statistics

from rate_atlas.data import SOURCES
from rate_atlas.normalize import normalize_source

_conn: sqlite3.Connection | None = None
_shapes: dict[str, dict] = {}


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(":memory:", check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


def ingest() -> dict:
    """(Re)build the table from the synthetic sources; return per-source counts."""
    db = _db()
    db.execute("DROP TABLE IF EXISTS rates")
    db.execute("""CREATE TABLE rates(
        hospital TEXT, code TEXT, code_type TEXT, description TEXT,
        payer TEXT, plan TEXT, rate REAL)""")
    db.execute("CREATE INDEX idx_code ON rates(code)")
    _shapes.clear()
    for name, raw in SOURCES.items():
        records, shape = normalize_source(name, raw)
        db.executemany(
            "INSERT INTO rates VALUES(:hospital,:code,:code_type,:description,"
            ":payer,:plan,:rate)", records)
        hospital = records[0]["hospital"] if records else name
        _shapes[name] = {"source": name, "hospital": hospital, "shape": shape,
                         "rows": len(records)}
    db.commit()
    return {"sources": list(_shapes.values()), "total_rows": _row_count()}


def ingest_records(source: str, hospital: str, records: list[dict],
                   shape: str = "llm_assisted") -> dict:
    """Append already-canonical records (e.g. from an LLM-assisted mapping of an
    unknown-format file) into the same table, then register the source. The rows
    are identical in shape to the adapter output, so everything downstream
    (compare/outliers) treats them no differently."""
    db = _db()
    if records:
        db.executemany(
            "INSERT INTO rates VALUES(:hospital,:code,:code_type,:description,"
            ":payer,:plan,:rate)", records)
        db.commit()
    _shapes[source] = {"source": source, "hospital": hospital, "shape": shape,
                       "rows": len(records)}
    return {"source": source, "hospital": hospital, "shape": shape,
            "rows": len(records), "total_rows": _row_count()}


def _row_count() -> int:
    return _db().execute("SELECT COUNT(*) FROM rates").fetchone()[0]


def sources() -> list[dict]:
    return list(_shapes.values())


def procedures() -> list[dict]:
    rows = _db().execute(
        "SELECT code, code_type, MAX(description) d, COUNT(*) n "
        "FROM rates GROUP BY code ORDER BY n DESC, code").fetchall()
    return [{"code": r["code"], "code_type": r["code_type"],
             "description": r["d"], "rate_count": r["n"]} for r in rows]


def compare(code: str) -> dict:
    rows = _db().execute(
        "SELECT hospital, payer, plan, rate, description FROM rates "
        "WHERE code = ? ORDER BY rate", (code,)).fetchall()
    quotes = [{"hospital": r["hospital"], "payer": r["payer"], "plan": r["plan"],
               "rate": r["rate"]} for r in rows]
    rates = [r["rate"] for r in rows]
    stats = {}
    if rates:
        lo, hi = min(rates), max(rates)
        stats = {"count": len(rates), "min": round(lo, 2), "max": round(hi, 2),
                 "median": round(statistics.median(rates), 2),
                 "avg": round(statistics.fmean(rates), 2),
                 "spread": round(hi - lo, 2),
                 "spread_pct": round((hi - lo) / lo, 3) if lo else None}
    return {"code": code, "description": rows[0]["description"] if rows else None,
            "quotes": quotes, "stats": stats}


def search(q: str) -> list[dict]:
    like = f"%{q}%"
    rows = _db().execute(
        "SELECT DISTINCT code, code_type, description FROM rates "
        "WHERE code LIKE ? OR description LIKE ? ORDER BY code LIMIT 50",
        (like, like)).fetchall()
    return [dict(r) for r in rows]


def all_rows() -> list[dict]:
    return [dict(r) for r in _db().execute(
        "SELECT hospital, code, description, payer, rate FROM rates").fetchall()]
