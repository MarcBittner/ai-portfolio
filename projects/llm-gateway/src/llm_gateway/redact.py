"""PII + secret detection and redaction.

Deterministic regex + checksum detectors for the high-confidence identifiers and
credential shapes that must never reach a provider or land in a log. Redaction
replaces each hit with a ``[TYPE]`` label; the returned findings carry only
``type`` and ``count`` — **a detected value is never echoed back** (the same
no-leak guarantee the audit log relies on). No model, no network.
"""

import re
from dataclasses import dataclass

# (name, category, pattern). category ∈ {"pii","secret"}.
_SPECS: list[tuple[str, str, re.Pattern]] = [
    ("EMAIL", "pii", re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")),
    ("SSN", "pii", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CREDIT_CARD", "pii", re.compile(r"\b(?:\d[ -]?){13,18}\d\b")),
    ("PHONE", "pii", re.compile(
        r"\b(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b")),
    ("IP_ADDRESS", "pii", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("AWS_KEY", "secret", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GITHUB_TOKEN", "secret", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("SLACK_TOKEN", "secret", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("API_KEY", "secret", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b")),
    ("BEARER_TOKEN", "secret", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}\b")),
]

TYPE_NAMES = [name for name, _, _ in _SPECS]
SECRET_TYPES = {name for name, cat, _ in _SPECS if cat == "secret"}


@dataclass
class Finding:
    type: str
    category: str
    start: int
    end: int


def _luhn_ok(digits: str) -> bool:
    d = [int(c) for c in digits if c.isdigit()]
    if len(d) < 13:
        return False
    total, alt = 0, False
    for n in reversed(d):
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def detect(text: str) -> list[Finding]:
    """Find all PII/secret spans (Luhn-validated cards), de-overlapped."""
    found: list[Finding] = []
    for name, cat, pat in _SPECS:
        for m in pat.finditer(text):
            if name == "CREDIT_CARD" and not _luhn_ok(m.group()):
                continue
            found.append(Finding(type=name, category=cat, start=m.start(), end=m.end()))
    # keep earliest, longest; drop spans overlapping an already-kept one
    found.sort(key=lambda f: (f.start, -(f.end - f.start)))
    kept: list[Finding] = []
    last_end = -1
    for f in found:
        if f.start >= last_end:
            kept.append(f)
            last_end = f.end
    return kept


def redact(text: str) -> tuple[str, list[dict]]:
    """Return ``(redacted_text, findings)``. Each value becomes ``[TYPE]``; findings
    expose only type + count + category — never the detected value."""
    spans = detect(text)
    out = text
    for f in sorted(spans, key=lambda f: f.start, reverse=True):
        out = out[:f.start] + f"[{f.type}]" + out[f.end:]
    counts: dict[str, dict] = {}
    for f in spans:
        e = counts.setdefault(
            f.type, {"type": f.type, "category": f.category, "count": 0})
        e["count"] += 1
    return out, list(counts.values())
