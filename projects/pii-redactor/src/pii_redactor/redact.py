"""Apply a redaction style to detected PII spans.

Styles trade off readability vs. disclosure:

- ``token``   — typed, numbered placeholders: ``[EMAIL_1]`` (same value → same
  token, so structure/coreference survives)
- ``label``   — bare type label: ``<EMAIL>``
- ``mask``    — characters blanked to ``•`` (separators kept for shape)
- ``partial`` — type-aware reveal of a safe remainder (card/SSN/phone last 4,
  email/IP first component); useful for support workflows
- ``hash``    — deterministic pseudonym ``EMAIL_a1b2c3`` (consistent per value,
  re-identifiable only with the source text)

Redaction consumes the spans from :mod:`detect`, so what gets removed is
exactly what was detected and checksum-validated.
"""

import hashlib
import re

from pii_redactor.detect import Span, detect

STYLES = ("token", "label", "mask", "partial", "hash")


def _mask(value: str) -> str:
    return re.sub(r"[A-Za-z0-9]", "•", value)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:6]


def _partial(pii_type: str, value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if pii_type in {"CREDIT_CARD", "SSN", "PHONE"} and len(digits) >= 4:
        return "•••• " + digits[-4:]
    if pii_type == "EMAIL" and "@" in value:
        local, domain = value.split("@", 1)
        return f"{local[:1]}•••@{domain[:1]}•••"
    if pii_type == "IP_ADDRESS":
        return value.split(".")[0] + ".•.•.•"
    if pii_type == "IBAN":
        return value[:2] + "•••• " + value[-4:]
    return value[:1] + "•••" + value[-1:] if len(value) > 2 else "•••"


def _replacement(span: Span, style: str, ordinal: int) -> str:
    if style == "label":
        return f"<{span.type}>"
    if style == "mask":
        return _mask(span.value)
    if style == "partial":
        return _partial(span.type, span.value)
    if style == "hash":
        return f"{span.type}_{_hash(span.value)}"
    return f"[{span.type}_{ordinal}]"  # token (default)


def redact(text: str, style: str = "token", types: set[str] | None = None):
    """Return ``(redacted_text, counts)``. ``style`` ∈ :data:`STYLES`.

    For ``token``/``hash`` a given value maps to a stable replacement across
    the whole text, so repeated PII reads consistently."""
    return redact_spans(text, detect(text, types), style)


def redact_spans(text: str, spans: list[Span], style: str = "token"):
    """Apply a redaction ``style`` to pre-computed (possibly merged) spans —
    used when LLM-found entities are merged with the regex detections."""
    if style not in STYLES:
        raise ValueError(f"unknown style {style!r}; valid: {STYLES}")
    spans = sorted(spans, key=lambda s: s.start)
    counts: dict[str, int] = {}
    value_repl: dict[tuple[str, str], str] = {}  # (type,value) → replacement
    pieces: list[str] = []
    cursor = 0
    for span in spans:
        key = (span.type, span.value)
        repl = value_repl.get(key)
        if repl is None:
            counts[span.type] = counts.get(span.type, 0) + 1
            repl = _replacement(span, style, counts[span.type])
            value_repl[key] = repl
        pieces.append(text[cursor : span.start])
        pieces.append(repl)
        cursor = span.end
    pieces.append(text[cursor:])
    return "".join(pieces), counts
