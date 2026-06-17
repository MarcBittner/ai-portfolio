"""Deterministic task classification from request features.

Routing quality is *per task class*: a small model may retain 99% on extraction
but 70% on hard reasoning, so we never reason about "the traffic" in aggregate —
we bucket each request first. Classification is cheap, deterministic, and
inspectable on purpose (no model call on the hot path); the feature vector it
emits is also what the analytics and rule-matching use.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

TASK_CLASSES = (
    "extraction", "classification", "summarization", "codegen",
    "reasoning", "translation", "chat", "other",
)


@dataclass
class Features:
    task_class: str
    approx_in_tokens: int
    n_messages: int
    max_tokens: int
    wants_json: bool
    has_code: bool
    system_tokens: int
    multiturn: bool


def _approx_tokens(text: str) -> int:
    # cheap, stable heuristic (~4 chars/token) — good enough for bucketing/cost UI
    return max(1, len(text) // 4)


_CODE = re.compile(r"```|\bdef \b|\bfunction\b|\bclass \b|import |#include|SELECT ",
                   re.IGNORECASE)
_EXTRACT = re.compile(r"\bextract\b|\bschema\b|\bfields?\b|\bparse\b|\bJSON\b",
                      re.IGNORECASE)
_CLASSIFY = re.compile(r"\bclassif|\bcategor|\blabel\b|\bsentiment\b|\bintent\b|"
                       r"\btriage\b|\byes or no\b", re.IGNORECASE)
_SUMMARY = re.compile(r"\bsummar|\btl;dr\b|\bcondense\b|\bkey points\b", re.IGNORECASE)
_TRANSLATE = re.compile(r"\btranslate\b|\bin (spanish|french|german|japanese|chinese)\b",
                        re.IGNORECASE)
_REASON = re.compile(r"\bstep[- ]by[- ]step\b|\breason\b|\bprove\b|\bderive\b|"
                     r"\bsolve\b|\banalyze\b|\bwhy\b|\bplan\b", re.IGNORECASE)


def classify(messages: list[dict], *, max_tokens: int = 1024,
             wants_json: bool = False) -> Features:
    system = " ".join(m.get("content") or "" for m in messages
                      if m.get("role") == "system")
    user = " ".join(m.get("content") or "" for m in messages
                    if m.get("role") != "system")
    blob = f"{system}\n{user}"
    all_text = " ".join(m.get("content") or "" for m in messages)
    has_code = bool(_CODE.search(blob))
    n_user = sum(1 for m in messages if m.get("role") == "user")

    if wants_json or _EXTRACT.search(blob):
        tc = "extraction"
    elif _CLASSIFY.search(blob):
        tc = "classification"
    elif _SUMMARY.search(blob):
        tc = "summarization"
    elif _TRANSLATE.search(blob):
        tc = "translation"
    elif has_code:
        tc = "codegen"
    elif _REASON.search(blob) or _approx_tokens(blob) > 1500:
        tc = "reasoning"
    elif n_user <= 1 and _approx_tokens(user) < 200:
        tc = "chat"
    else:
        tc = "other"

    return Features(
        task_class=tc,
        approx_in_tokens=_approx_tokens(all_text),
        n_messages=len(messages),
        max_tokens=max_tokens,
        wants_json=wants_json,
        has_code=has_code,
        system_tokens=_approx_tokens(system),
        multiturn=n_user > 1,
    )


def to_dict(f: Features) -> dict:
    return asdict(f)
