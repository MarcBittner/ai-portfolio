"""Deterministic PII redaction — regex + checksum, no LLM.

Runs as a mandatory gate at ingest (before any text is embedded or
stored) and optionally on outbound prompts. Replacements are typed,
numbered tokens (``[EMAIL_1]``) so redacted text stays readable, and
the result carries a per-call ``mapping`` for reversible lookup within
a request. Redaction *counts* are loggable; redacted *values* never are
(see docs/data-governance.md).
"""

import re
from dataclasses import dataclass, field

# Order encodes priority when spans overlap (first wins).
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    # 13-19 digits with optional space/dash separators; Luhn-validated below.
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
            r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)"
            r"\.?\b"
        ),
    ),
]


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


@dataclass
class RedactionResult:
    text: str
    counts: dict[str, int] = field(default_factory=dict)
    mapping: dict[str, str] = field(default_factory=dict)  # token -> original

    @property
    def total(self) -> int:
        return sum(self.counts.values())


class Redactor:
    def redact(self, text: str) -> RedactionResult:
        matches: list[tuple[int, int, str, str]] = []  # (start, end, type, value)
        claimed: list[tuple[int, int]] = []

        for pii_type, pattern in _PATTERNS:
            for m in pattern.finditer(text):
                start, end, value = m.start(), m.end(), m.group()
                if pii_type == "CREDIT_CARD":
                    digits = re.sub(r"[ -]", "", value)
                    if not (13 <= len(digits) <= 19 and _luhn_ok(digits)):
                        continue
                if pii_type == "IP_ADDRESS" and not all(
                    int(octet) <= 255 for octet in value.split(".")
                ):
                    continue
                if any(start < c_end and end > c_start for c_start, c_end in claimed):
                    continue  # earlier (higher-priority) pattern owns this span
                claimed.append((start, end))
                matches.append((start, end, pii_type, value))

        if not matches:
            return RedactionResult(text=text)

        matches.sort(key=lambda m: m[0])
        counts: dict[str, int] = {}
        mapping: dict[str, str] = {}
        value_tokens: dict[tuple[str, str], str] = {}  # same value -> same token
        pieces: list[str] = []
        cursor = 0
        for start, end, pii_type, value in matches:
            token = value_tokens.get((pii_type, value))
            if token is None:
                counts[pii_type] = counts.get(pii_type, 0) + 1
                token = f"[{pii_type}_{counts[pii_type]}]"
                value_tokens[(pii_type, value)] = token
                mapping[token] = value
            pieces.append(text[cursor:start])
            pieces.append(token)
            cursor = end
        pieces.append(text[cursor:])
        return RedactionResult(text="".join(pieces), counts=counts, mapping=mapping)
