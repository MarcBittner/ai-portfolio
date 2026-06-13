"""Reproducible eval: query-plan regression + natural-language→SQL accuracy.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m txn_ledger.evaluate``). Deterministic offline,
so the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider
keys to score a live model on the same labeled question set.
"""

from __future__ import annotations

import os
from pathlib import Path

from txn_ledger import db, nl2sql, queries

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def run() -> dict:
    db.build()
    return {
        "plan": queries.plan_regression(),
        "nl2sql": nl2sql.evaluate(),
        "mode": os.environ.get("LLM_MODE", "auto"),
    }


def _render(r: dict) -> str:
    p, n = r["plan"], r["nl2sql"]
    lines = [
        "# txn-ledger — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (deterministic plan capture + "
        "a canned NL→SQL matcher) by default, so these numbers reproduce exactly "
        "with zero keys; set provider keys or `LLM_MODE` to score a live model.",
        "",
        "## Query-plan regression (the hot path)",
        "",
        "The cardinal infra invariant: the per-committee rollup must still resolve "
        "through the covering index after tuning — a query that quietly reverts to "
        "a full table **SCAN** is the classic cause of a latency blow-up under a "
        "filing-deadline read surge, so this is pass/fail, not a soft metric.",
        "",
        "| check | result |",
        "| --- | --- |",
        f"| full SCAN before the index | {p['scan_before_index']} |",
        f"| SEARCH via INDEX after the index | {p['uses_index']} |",
        f"| covering (no heap lookups) | {p['covering']} |",
        f"| no SCAN after the index | {p['no_scan_after']} |",
        f"| **regression passed** | **{p['passed']}** |",
        "",
        "```",
        "-- BEFORE (no index)",
        *p["plan_before_index"],
        "",
        "-- AFTER (idx_cycle_committee)",
        *p["plan_after_index"],
        "```",
        "",
        "## Natural-language → SQL accuracy",
        "",
        f"Scored over **{n['questions']}** labeled plain-English questions. Each is "
        "translated to SQL through the routing chain, the generated SQL is guarded "
        "to a single read-only SELECT, executed, and the rows compared to the "
        "expected answer computed directly from the store. **Safety is the gate** — "
        "an unsafe (non-SELECT / multi-statement / DDL) translation is never run.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| questions | {n['questions']} |",
        f"| passed the SQL safety guard | {n['safe']} |",
        f"| correct answer | {n['correct']} |",
        f"| accuracy | {n['accuracy']} |",
        f"| providers used | {', '.join(n['providers_used'])} |",
        "",
        "| question | safe | correct | generated SQL |",
        "| --- | --- | --- | --- |",
    ]
    for d in n["details"]:
        sql = (d["sql"] or "").replace("|", "\\|")
        lines.append(f"| {d['question']} | {d['safe']} | {d['correct']} | "
                     f"`{sql}` |")
    lines += [
        "",
        "> The offline matcher maps a handful of question patterns to prebuilt "
        "parameterized queries, so it is exact on the labeled set and the eval "
        "reproduces with zero keys. The LLM path is what generalizes to phrasings "
        "the matcher never saw — and the **safety guard is identical on either "
        "route**: model output is parsed and rejected unless it is one read-only "
        "SELECT, then run against a `query_only` connection.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    p, n = r["plan"], r["nl2sql"]
    print(f"plan-regression: passed={p['passed']} uses_index={p['uses_index']} "
          f"covering={p['covering']}")
    print(f"NL→SQL: accuracy={n['accuracy']} safe={n['safe']}/{n['questions']} "
          f"correct={n['correct']}/{n['questions']} "
          f"(providers: {', '.join(n['providers_used'])})")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
