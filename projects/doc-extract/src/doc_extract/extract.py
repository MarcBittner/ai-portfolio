"""Deterministic, schema-driven field extraction.

Two strategies per field, in order: **label-anchored** (find a label alias,
capture the typed value next to it — high confidence) and, failing that, a
**global pattern** match for typed fields (lower confidence). Each value is
type-validated/normalized (date→ISO, money→number, email/phone/url regex), and
every result carries a confidence and a provenance span so the UI can highlight
exactly where it came from. No model, no network.
"""

import re
from dataclasses import dataclass
from datetime import datetime

from doc_extract.schemas import SCHEMAS, Field, Schema

_MONTHS = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)

# Value pattern per type (string is handled specially: rest of line).
TYPE_PATTERNS: dict[str, str] = {
    "email": r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
    "phone": r"(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}",
    "url": r"(?:https?://|www\.)[^\s,;]+|(?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s,;]+",
    "money": r"[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d{1,3}(?:,\d{3})*\.\d{2}",
    "date": (
        r"\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}|"
        rf"{_MONTHS}\.?\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}\s+{_MONTHS}\.?\s+\d{{4}}"
    ),
    "number": r"\d+(?:\.\d+)?",
}

_DATE_FORMATS = (
    "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y",
    "%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y",
)


@dataclass
class Extracted:
    name: str
    type: str
    found: bool
    value: str | None = None
    normalized: str | None = None
    valid: bool = False
    confidence: float = 0.0
    start: int | None = None
    end: int | None = None
    method: str | None = None  # "label" | "pattern"


def _validate(field_type: str, value: str) -> tuple[bool, str | None]:
    """Return (valid, normalized). Normalization: date→ISO, money→plain number."""
    if field_type == "date":
        for fmt in _DATE_FORMATS:
            try:
                return True, datetime.strptime(value.strip().rstrip("."), fmt).strftime(
                    "%Y-%m-%d"
                )
            except ValueError:
                continue
        return False, None
    if field_type == "money":
        digits = re.sub(r"[^\d.]", "", value)
        try:
            return True, f"{float(digits):.2f}"
        except ValueError:
            return False, None
    if field_type == "number":
        try:
            return True, str(float(value))
        except ValueError:
            return False, None
    if field_type in {"email", "phone", "url"}:
        return bool(re.fullmatch(TYPE_PATTERNS[field_type], value.strip())), None
    return True, None  # string: always "valid"


def _anchored(text: str, fld: Field) -> tuple[str, int, int] | None:
    value_pat = r"([^\n]+)" if fld.type == "string" else f"({TYPE_PATTERNS[fld.type]})"
    # longest labels first so "invoice number" beats "invoice"
    aliases = sorted(fld.labels, key=len, reverse=True)
    alt = "|".join(re.escape(a) for a in aliases)
    if not alt:
        return None
    pattern = re.compile(rf"(?i)(?:{alt})\s*[:#\-]?\s*{value_pat}")
    m = pattern.search(text)
    if not m:
        return None
    raw = m.group(1).strip().rstrip(".,;")
    start = m.start(1)
    return raw, start, start + len(raw)


def _global(text: str, fld: Field) -> tuple[str, int, int] | None:
    if fld.type == "string":
        return None
    m = re.search(TYPE_PATTERNS[fld.type], text)
    if not m:
        return None
    return m.group(0), m.start(), m.end()


def _extract_field(text: str, fld: Field) -> Extracted:
    hit = _anchored(text, fld)
    method = "label"
    if hit is None:
        hit = _global(text, fld)
        method = "pattern"
    if hit is None:
        return Extracted(name=fld.name, type=fld.type, found=False)

    value, start, end = hit
    valid, normalized = _validate(fld.type, value)
    typed = fld.type != "string"
    base = (0.85 if typed else 0.8) if method == "label" else 0.55
    bonus = 0.1 if (valid and typed) else 0.0
    confidence = round(min(0.98, base + bonus), 2)
    return Extracted(
        name=fld.name, type=fld.type, found=True, value=value, normalized=normalized,
        valid=valid, confidence=confidence, start=start, end=end, method=method,
    )


def extract(text: str, schema_name: str) -> tuple[Schema, list[Extracted]]:
    """Extract every field of ``schema_name`` from ``text`` (found or not)."""
    if schema_name not in SCHEMAS:
        raise ValueError(f"unknown schema {schema_name!r}; valid: {list(SCHEMAS)}")
    schema = SCHEMAS[schema_name]
    return schema, [_extract_field(text, fld) for fld in schema.fields]
