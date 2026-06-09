"""OCR → text → PII detection → box-level redaction.

Joins OCR tokens into text in reading order (tracking each token's char span),
detects PII over that text, then maps each PII span back to the **tokens it
overlaps** — those tokens' bounding boxes are the regions to black out on the
image. Also returns redacted text. Findings never echo the PII value (category
+ length only), matching the rest of the portfolio's governance posture.
"""

from dataclasses import dataclass

from multimodal_ocr.detect import detect
from multimodal_ocr.ocr import OcrToken


@dataclass
class Box:
    x: int
    y: int
    w: int
    h: int
    type: str


@dataclass
class Finding:
    type: str
    start: int
    end: int
    snippet: str  # masked: category + length, never the value


@dataclass
class Routing:
    provider: str
    model: str
    fallbacks: list[str]


@dataclass
class Result:
    text: str
    redacted_text: str
    findings: list[Finding]
    boxes: list[Box]
    counts: dict[str, int]
    routing: Routing | None = None


def tokens_to_text(tokens: list[OcrToken]):
    """Join tokens in reading order; return (text, ordered_tokens, spans) where
    spans[i] is the [start, end) char range of ordered_tokens[i] in text."""
    ordered = sorted(tokens, key=lambda t: (t.y, t.x))
    parts: list[str] = []
    spans: list[tuple[int, int]] = []
    cursor = 0
    cur_y: int | None = None
    for t in ordered:
        if cur_y is not None:
            sep = "\n" if t.y != cur_y else " "
            parts.append(sep)
            cursor += 1
        cur_y = t.y
        spans.append((cursor, cursor + len(t.text)))
        parts.append(t.text)
        cursor += len(t.text)
    return "".join(parts), ordered, spans


def process(tokens: list[OcrToken], types: set[str] | None = None,
            use_llm: bool = False, provider: str | None = "auto",
            model: str | None = None) -> Result:
    text, ordered, spans = tokens_to_text(tokens)
    pii = detect(text, types)

    routing = None
    if use_llm:
        from multimodal_ocr.llm_ner import llm_entities, merge
        llm_spans, result = llm_entities(text, provider, model)
        if types is not None:
            llm_spans = [s for s in llm_spans if s.type in types]
        pii = merge(pii, llm_spans)
        routing = Routing(result.provider, result.model, result.fallbacks)

    boxes: list[Box] = []
    counts: dict[str, int] = {}
    for span in pii:
        counts[span.type] = counts.get(span.type, 0) + 1
        for i, (ts, te) in enumerate(spans):
            if ts < span.end and te > span.start:  # token overlaps the PII span
                tok = ordered[i]
                boxes.append(Box(tok.x, tok.y, tok.w, tok.h, span.type))

    findings = [
        Finding(s.type, s.start, s.end, f"[{s.type} · {len(s.value)} chars]")
        for s in pii
    ]
    redacted_text = _redact_text(text, pii)
    return Result(text, redacted_text, findings, boxes, counts, routing)


def _redact_text(text: str, pii) -> str:
    pieces: list[str] = []
    cursor = 0
    for span in pii:
        pieces.append(text[cursor:span.start])
        pieces.append(f"[{span.type}]")
        cursor = span.end
    pieces.append(text[cursor:])
    return "".join(pieces)
