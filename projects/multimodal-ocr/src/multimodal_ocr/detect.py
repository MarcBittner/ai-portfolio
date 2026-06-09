"""Compact, self-contained PII detection over text (regex + Luhn).

Returns typed spans into the text; the pipeline maps those spans back to OCR
token boxes for visual redaction.
"""

import re
from dataclasses import dataclass

_PATTERNS = [
    ("EMAIL", re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    ("PHONE", re.compile(
        r"(?<![\w.-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b")),
]
TYPE_NAMES = [t for t, _ in _PATTERNS]


@dataclass(frozen=True)
class Span:
    type: str
    start: int
    end: int
    value: str


def _luhn_ok(value: str) -> bool:
    digits = re.sub(r"[ -]", "", value)
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return total % 10 == 0


def detect(text: str, types: set[str] | None = None) -> list[Span]:
    wanted = set(TYPE_NAMES) if types is None else (types & set(TYPE_NAMES))
    claimed: list[tuple[int, int]] = []
    spans: list[Span] = []
    for pii_type, pattern in _PATTERNS:
        if pii_type not in wanted:
            continue
        for m in pattern.finditer(text):
            if pii_type == "CREDIT_CARD" and not _luhn_ok(m.group()):
                continue
            s, e = m.start(), m.end()
            if any(s < ce and e > cs for cs, ce in claimed):
                continue
            claimed.append((s, e))
            spans.append(Span(pii_type, s, e, m.group()))
    spans.sort(key=lambda s: s.start)
    return spans
