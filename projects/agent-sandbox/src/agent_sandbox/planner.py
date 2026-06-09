"""Deterministic ReAct-style planner.

Maps a query to an ordered list of tool steps (a real LLM planner would slot
in behind the same ``plan(query) -> list[Step]`` contract). It handles four
single-tool intents plus one **chained** case — "N% of the days between A and
B" — that runs ``date_diff`` then feeds the result into ``calculator`` via a
``{0}`` placeholder, demonstrating multi-step tool use with data flow.
"""

import re
from dataclasses import dataclass

_DATE = r"(\d{4}-\d{2}-\d{2})"
_BETWEEN = re.compile(rf"between\s+{_DATE}\s+and\s+{_DATE}")
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*of\b")
_CONVERT = re.compile(
    r"(?:convert\s+)?(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s+(?:to|in)\s+([a-zA-Z]+)"
)
# start on a digit or "(", end on a digit or ")" so balanced parens are kept
_ARITH = re.compile(r"[(\d][\d\s.()+\-*/^%]*[+\-*/^][\d\s.()+\-*/^%]*[\d)]")


@dataclass
class Step:
    thought: str
    tool: str
    args: dict  # str values may contain "{n}" referencing prior observations


def plan(query: str) -> list[Step]:
    q = query.strip()
    low = q.lower()
    pm = _PERCENT.search(low)
    bm = _BETWEEN.search(low)

    if pm and bm:  # chained: days between -> percentage of it
        pct = pm.group(1)
        return [
            Step(f"Find the number of days between {bm.group(1)} and {bm.group(2)}.",
                 "date_diff", {"start": bm.group(1), "end": bm.group(2)}),
            Step(f"Take {pct}% of that day count.",
                 "calculator", {"expression": f"{pct}/100*{{0}}"}),
        ]
    if pm:
        num = re.search(r"\d+(?:\.\d+)?", low[pm.end():])
        if num:
            return [Step(f"Compute {pm.group(1)}% of {num.group(0)}.", "calculator",
                         {"expression": f"{pm.group(1)}/100*{num.group(0)}"})]
    cm = _CONVERT.search(low)
    if cm:
        return [Step(f"Convert {cm.group(1)} {cm.group(2)} to {cm.group(3)}.", "convert",
                     {"value": float(cm.group(1)), "from_unit": cm.group(2),
                      "to_unit": cm.group(3)})]
    if bm:
        return [Step(f"Count the days between {bm.group(1)} and {bm.group(2)}.",
                     "date_diff", {"start": bm.group(1), "end": bm.group(2)})]
    am = _ARITH.search(q)
    if am:
        expr = am.group(0).strip()
        return [Step(f"Evaluate the expression {expr}.", "calculator",
                     {"expression": expr})]
    return [Step("Look this up in the knowledge base.", "search", {"query": q})]
