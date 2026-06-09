"""Deterministic PII detection — regex plus checksum validation.

No model, no network: every detector is a regular expression, and the
ambiguous numeric types are confirmed by a checksum (Luhn for cards,
ISO-7064 mod-97 for IBANs) or a range check (IPv4 octets) so a string of
digits isn't blindly flagged. Detection is the basis for both redaction
and the UI's live highlighting.

Spans never overlap: patterns are tried in priority order and an earlier
(higher-priority) match claims its characters, so ``[EMAIL]`` wins over a
phone-shaped run inside it.
"""

import re
from dataclasses import dataclass

PIIType = str  # one of TYPES below

# (type, description) — order is detection priority (first claim wins).
TYPES: list[tuple[str, str]] = [
    ("EMAIL", "Email address"),
    ("IBAN", "International Bank Account Number (mod-97 validated)"),
    ("SSN", "US Social Security Number"),
    ("CREDIT_CARD", "Credit-card number (Luhn validated)"),
    ("PHONE", "Phone number"),
    ("IP_ADDRESS", "IPv4 address"),
    ("STREET_ADDRESS", "US street address"),
]
TYPE_NAMES = [t for t, _ in TYPES]

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    (
        "PHONE",
        re.compile(
            r"(?<![\w.-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b"
        ),
    ),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    (
        "STREET_ADDRESS",
        re.compile(
            r"\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}"
            r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|"
            r"Court|Ct|Way|Place|Pl)\.?\b"
        ),
    ),
]


@dataclass(frozen=True)
class Span:
    """A detected PII occurrence: its type and half-open char range [start,end)."""

    type: str
    start: int
    end: int
    value: str


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _iban_ok(value: str) -> bool:
    if not (15 <= len(value) <= 34):
        return False
    rearranged = value[4:] + value[:4]
    digits = "".join(str(int(c, 36)) for c in rearranged)  # A→10 … Z→35
    return int(digits) % 97 == 1


def _ipv4_ok(value: str) -> bool:
    return all(o.isdigit() and int(o) <= 255 for o in value.split("."))


_VALIDATORS = {
    "CREDIT_CARD": lambda v: _luhn_ok(re.sub(r"[ -]", "", v)),
    "IBAN": _iban_ok,
    "IP_ADDRESS": _ipv4_ok,
}


def detect(text: str, types: set[str] | None = None) -> list[Span]:
    """Non-overlapping PII spans in ``text``, sorted by position. ``types``
    limits detection to the named subset (default: all)."""
    wanted = set(TYPE_NAMES) if types is None else (types & set(TYPE_NAMES))
    claimed: list[tuple[int, int]] = []
    spans: list[Span] = []
    for pii_type, pattern in _PATTERNS:
        if pii_type not in wanted:
            continue
        validate = _VALIDATORS.get(pii_type)
        for m in pattern.finditer(text):
            start, end, value = m.start(), m.end(), m.group()
            if validate and not validate(value):
                continue
            if any(start < c_end and end > c_start for c_start, c_end in claimed):
                continue  # a higher-priority pattern already owns these chars
            claimed.append((start, end))
            spans.append(Span(pii_type, start, end, value))
    spans.sort(key=lambda s: s.start)
    return spans


def counts(spans: list[Span]) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in spans:
        out[s.type] = out.get(s.type, 0) + 1
    return out
