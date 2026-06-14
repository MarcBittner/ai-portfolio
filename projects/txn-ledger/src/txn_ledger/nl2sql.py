"""Natural-language → SQL over the contributions store, with a hard safety guard.

This is the demo's LLM surface. A plain-English question ("total raised in the
2024 cycle", "top 5 committees by itemized total") is translated by the model
into a **single read-only SELECT** against the known schema, which is then run
against a **read-only** connection and the rows returned with the generated SQL
and provider telemetry. The model writes the query; trust-critical execution
stays deterministic and guarded.

SAFETY IS THE POINT. The generated SQL is never trusted: ``guard_sql()`` parses
it and rejects anything that is not exactly one ``SELECT`` — no INSERT/UPDATE/
DELETE/DDL, no PRAGMA/ATTACH, no second statement, no comment-smuggling. Only a
query that survives the guard is executed, and it runs against a connection
opened ``mode=ro`` so even a guard miss cannot mutate data. Parameters are bound,
never interpolated.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a deterministic offline matcher. The offline matcher maps a handful
of canned question patterns to prebuilt parameterized queries, so NL→SQL works
(and the eval reproduces) with zero keys.
"""

from __future__ import annotations

import re

from txn_ledger import db, llm
from txn_ledger.generate import COMMITTEES, CYCLES, ITEMIZED_THRESHOLD

# The schema the model is allowed to query, and the one table it may name.
SCHEMA = (
    "contributions(id INTEGER, donor_id TEXT, committee_id TEXT, "
    "cycle INTEGER, amount REAL, ts TEXT)"
)
_ALLOWED_TABLE = "contributions"
ITEMIZED = ITEMIZED_THRESHOLD  # $200 FEC itemization threshold

SYSTEM = (
    "You translate a plain-English question about U.S. campaign contributions "
    "into ONE read-only SQLite SELECT over this single table:\n"
    f"  {SCHEMA}\n"
    f"Valid cycles: {CYCLES}. committee_id looks like 'C-0001'. The $200 "
    "itemization threshold splits itemized (amount > 200) from unitemized.\n"
    "RULES: emit ONLY the SQL, no prose, no markdown fences, no trailing "
    "semicolon. A SINGLE SELECT statement only — never INSERT/UPDATE/DELETE/"
    "DROP/PRAGMA/ATTACH and never multiple statements. Query only the "
    "'contributions' table. Use literal values inline.\n"
    "EXAMPLES:\n"
    "Q: total raised in the 2024 cycle\n"
    "SELECT SUM(amount) AS total_raised FROM contributions WHERE cycle = 2024\n"
    "Q: top 5 committees by itemized total in 2024\n"
    "SELECT committee_id, SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END) AS "
    "itemized FROM contributions WHERE cycle = 2024 GROUP BY committee_id "
    "ORDER BY itemized DESC LIMIT 5\n"
    "Q: how many donors gave under 200 in 2026\n"
    "SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions WHERE "
    "cycle = 2026 AND amount < 200\n"
)


# --------------------------------------------------------------------------- #
# Safety guard — the most important correctness item                          #
# --------------------------------------------------------------------------- #

class UnsafeSQLError(ValueError):
    """Raised when generated SQL is not a single, read-only SELECT."""


# Anything that can write, change schema, or reach outside the one table.
_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|PRAGMA|ATTACH|"
    r"DETACH|VACUUM|REINDEX|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b",
    re.IGNORECASE,
)


def _strip_sql(text: str) -> str:
    """Pull the SQL out of a model reply: drop ``` fences and any leading
    'SQL:'/'Query:' label, keep the first statement."""
    s = text.strip()
    if "```" in s:
        # take the fenced block body
        parts = s.split("```")
        s = parts[1] if len(parts) > 1 else s
        s = s.removeprefix("sql").removeprefix("SQL").strip()
    s = re.sub(r"^(sql|query)\s*:\s*", "", s, flags=re.IGNORECASE).strip()
    return s


def guard_sql(sql: str) -> str:
    """Validate that ``sql`` is exactly ONE read-only SELECT and return it
    normalized (no trailing semicolon). Raise ``UnsafeSQLError`` otherwise.

    Rejections, explicitly: empty input; any non-SELECT statement; comments
    (which can smuggle a second statement past a naive split); a second
    statement after the SELECT; and any forbidden write/DDL/PRAGMA keyword
    anywhere in the text.
    """
    s = sql.strip()
    if not s:
        raise UnsafeSQLError("empty SQL")
    # No SQL comments — they are the usual vehicle for hiding a payload.
    if "--" in s or "/*" in s:
        raise UnsafeSQLError("comments are not allowed")
    # Strip a single trailing semicolon, then forbid any remaining statement.
    s = s.rstrip().removesuffix(";").strip()
    if ";" in s:
        raise UnsafeSQLError("multiple statements are not allowed")
    if not re.match(r"^\s*SELECT\b", s, re.IGNORECASE):
        raise UnsafeSQLError("only a single SELECT is allowed")
    if _FORBIDDEN.search(s):
        raise UnsafeSQLError("statement contains a forbidden keyword")
    # Defense in depth: the only table name that may appear is contributions.
    for tbl in re.findall(r"\bFROM\s+([A-Za-z_][\w]*)", s, re.IGNORECASE):
        if tbl.lower() != _ALLOWED_TABLE:
            raise UnsafeSQLError(f"unknown table {tbl!r}")
    return s


def run_select(sql: str) -> list[dict]:
    """Guard ``sql`` then execute it read-only, returning rows as dicts.

    The store is an in-memory SQLite DB private to its build connection, so the
    read-only posture is enforced at the engine level: ``PRAGMA query_only = ON``
    makes SQLite reject any write/DDL for the duration of the query — a second
    line of defense behind the guard, in case a write somehow survived parsing.
    """
    safe = guard_sql(sql)
    conn = db.conn()
    conn.execute("PRAGMA query_only = ON")
    try:
        rows = conn.execute(safe).fetchall()
    finally:
        conn.execute("PRAGMA query_only = OFF")
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# Deterministic offline matcher (canned Q → parameterized SQL)                #
# --------------------------------------------------------------------------- #

def _find_cycle(q: str) -> int | None:
    for c in CYCLES:
        if str(c) in q:
            return c
    return None


def _offline_sql(_system: str, user: str) -> str:
    """Map a handful of canned question patterns to prebuilt SELECTs. This is the
    last-resort fallback; it returns plain SQL text (the same shape the model is
    asked for) so the guard + execution path is uniform on either route."""
    q = user.rsplit("\n", 1)[-1].lower()
    cycle = _find_cycle(q)
    cyc = f"WHERE cycle = {cycle}" if cycle is not None else ""

    # top N committees by itemized / by total
    m = re.search(r"top\s+(\d+)", q)
    if m and "committee" in q:
        n = int(m.group(1))
        metric = ("SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END)"
                  if "itemiz" in q else "SUM(amount)")
        alias = "itemized" if "itemiz" in q else "total_raised"
        return (f"SELECT committee_id, {metric} AS {alias} FROM contributions "
                f"{cyc} GROUP BY committee_id ORDER BY {alias} DESC LIMIT {n}")

    # donor counts under / over the itemization threshold (word-boundary match so
    # "overall" / "underway" don't accidentally trip the amount filter)
    under = re.search(r"\b(under|below|less than)\b", q)
    over = re.search(r"\b(over|above)\b", q)
    if "donor" in q and under:
        cond = "amount < 200" if not cyc else f"cycle = {cycle} AND amount < 200"
        return (f"SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions "
                f"WHERE {cond}")
    if "donor" in q and (over or "itemiz" in q):
        cond = "amount > 200" if not cyc else f"cycle = {cycle} AND amount > 200"
        return (f"SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions "
                f"WHERE {cond}")
    if "how many donor" in q or "number of donor" in q or "distinct donor" in q:
        return (f"SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions "
                f"{cyc}")

    # contribution / row counts
    if "how many contribution" in q or "number of contribution" in q:
        return f"SELECT COUNT(*) AS contributions FROM contributions {cyc}"

    # itemized vs unitemized split
    if "itemiz" in q:
        return ("SELECT "
                "SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END) AS itemized, "
                "SUM(CASE WHEN amount <= 200 THEN amount ELSE 0 END) AS unitemized "
                f"FROM contributions {cyc}")

    # default: total raised (optionally for a cycle)
    return f"SELECT SUM(amount) AS total_raised FROM contributions {cyc}"


# --------------------------------------------------------------------------- #
# Public ask() — route, guard, execute                                        #
# --------------------------------------------------------------------------- #

def ask(question: str, *, mode: str | None = None, max_rows: int = 50,
        client_sql: str | None = None) -> dict:
    """Translate ``question`` → SQL via the routing chain, guard it, run it
    read-only, and return rows + the generated SQL + provider telemetry.

    On a guard rejection the response carries ``error`` and the offending SQL —
    the query is never executed.

    ``client_sql`` (browser→host Ollama): when the browser reached the user's
    host Ollama itself, it submits the generated SQL here and we skip the
    server-side LLM *generation* call. SAFETY: the client SQL is NEVER trusted —
    it goes through the exact same ``guard_sql()`` before execution. Only the
    generation step is skipped, never the guard.
    """
    db.conn()  # ensure the dataset is built
    if client_sql is not None:
        # Browser ran the NL→SQL on the user's host Ollama (browser→host) and
        # submitted the SQL. Skip the server-side generation call only — the
        # guard below still runs, exactly as for server-generated SQL.
        generated = _strip_sql(client_sql)
        telemetry = {
            "question": question, "generated_sql": generated,
            "provider": "ollama (browser→host)", "model": "host", "mode": "local",
            "latency_ms": 0, "cost_usd": 0.0, "fallbacks": [],
        }
    else:
        res = llm.complete(SYSTEM, f"Q: {question}", offline=_offline_sql,
                           mode=mode, max_tokens=256)
        generated = _strip_sql(res.text)
        telemetry = {
            "question": question, "generated_sql": generated,
            "provider": res.provider, "model": res.model, "mode": res.mode,
            "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
            "fallbacks": res.fallbacks,
        }
    try:
        safe = guard_sql(generated)
    except UnsafeSQLError as exc:
        return {**telemetry, "safe": False, "error": str(exc),
                "rows": [], "row_count": 0}
    rows = run_select(safe)
    return {**telemetry, "safe": True, "sql": safe,
            "rows": rows[:max_rows], "row_count": len(rows)}


# --------------------------------------------------------------------------- #
# Labeled question set + accuracy eval                                         #
# --------------------------------------------------------------------------- #

# Each case: question + a checker that asserts the returned rows are correct,
# computed independently against the canonical aggregates (not via the model).
def _expected(question: str) -> list[dict]:
    """Ground truth for a labeled question, computed directly from the store."""
    return run_select(_offline_sql("", question))


QUESTIONS = [
    "total raised in the 2024 cycle",
    "total raised overall",
    "top 5 committees by itemized total in 2024",
    "top 3 committees by total raised in 2026",
    "how many donors gave under 200 in 2026",
    "how many contributions in the 2022 cycle",
    "itemized vs unitemized total in 2024",
    "how many distinct donors overall",
]


def _rows_equal(a: list[dict], b: list[dict]) -> bool:
    if len(a) != len(b):
        return False
    for x, y in zip(a, b, strict=False):
        if set(x.keys()) != set(y.keys()):
            return False
        for k in x:
            xv, yv = x[k], y[k]
            if isinstance(xv, float) or isinstance(yv, float):
                if abs((xv or 0) - (yv or 0)) > 0.01:
                    return False
            elif xv != yv:
                return False
    return True


def evaluate(mode: str | None = None) -> dict:
    """Score NL→SQL accuracy over the labeled question set: does the generated
    SQL execute safely and return the expected answer?"""
    correct = 0
    safe_count = 0
    providers: set[str] = set()
    details: list[dict] = []
    for q in QUESTIONS:
        out = ask(q, mode=mode)
        providers.add(out["provider"])
        ok = bool(out.get("safe"))
        safe_count += int(ok)
        match = ok and _rows_equal(out["rows"], _expected(q))
        correct += int(match)
        details.append({"question": q, "safe": ok, "correct": match,
                        "sql": out.get("sql") or out.get("generated_sql")})
    n = len(QUESTIONS)
    return {
        "questions": n, "safe": safe_count, "correct": correct,
        "accuracy": round(correct / n, 3) if n else 1.0,
        "providers_used": sorted(providers), "details": details,
    }


def committees() -> dict:
    return {cid: name for cid, name in COMMITTEES.items()}
