"""Deterministic rule planner — the offline fallback.

Maps a task to an ordered list of tool calls using cheap heuristics, emitting
only steps whose tool is in the agent's allowlist. It is intentionally simple:
it keeps the agent useful with no model at all, and the LLM planner takes over
when a provider is configured.
"""

import re
from dataclasses import dataclass, field

_MATH = re.compile(r"\d[\d.\s]*(?:[-+*/^]\s*\(?\s*\d[\d.\s)]*)+")
_CONV = re.compile(
    r"(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s*(?:to|in|into)\s+([a-zA-Z°]+)", re.I)
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_WORDS_IN = re.compile(r"(?:how many words|word count|count the words).*?[:\-]\s*(.+)$",
                       re.I | re.S)
_DOC_IDS = ("onboarding", "pricing", "limits")


@dataclass
class Step:
    thought: str
    tool: str
    args: dict = field(default_factory=dict)


def plan(task: str, allowed: list[str]) -> list[Step]:
    """Build a deterministic plan from ``task`` using only ``allowed`` tools."""
    allow = set(allowed)
    steps: list[Step] = []
    low = task.lower()

    if "convert" in allow:
        m = _CONV.search(task)
        if m:
            steps.append(Step(
                f"Convert {m.group(1)} {m.group(2)} to {m.group(3)}.",
                "convert",
                {"value": m.group(1), "from_unit": m.group(2), "to_unit": m.group(3)}))

    if "date_diff" in allow:
        dates = _DATE.findall(task)
        if len(dates) >= 2:
            steps.append(Step(
                f"Count the days between {dates[0]} and {dates[1]}.",
                "date_diff", {"start": dates[0], "end": dates[1]}))

    if "calculator" in allow and not steps:
        m = _MATH.search(task)
        if m:
            expr = m.group(0).strip()
            steps.append(Step(f"Evaluate the expression {expr}.",
                              "calculator", {"expression": expr}))

    if "text_stats" in allow:
        m = _WORDS_IN.search(task)
        if m:
            steps.append(Step("Measure the supplied text.",
                              "text_stats", {"text": m.group(1).strip()}))

    if "doc_fetch" in allow:
        for doc in _DOC_IDS:
            if doc in low:
                steps.append(Step(f"Fetch the {doc} document.",
                                  "doc_fetch", {"doc_id": doc}))
                break

    if not steps and "kb_search" in allow:
        steps.append(Step("Search the knowledge base for the answer.",
                          "kb_search", {"query": task}))

    return steps
