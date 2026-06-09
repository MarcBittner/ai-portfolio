"""Optional LLM named-entity pass over the OCR text.

Regex catches structured PII (emails, SSNs, cards); names/orgs/locations on a
scanned document need a model. This asks the configured LLM (Ollama by default)
for entities in the joined OCR text and returns spans the pipeline maps to token
boxes. Degrades safely: no provider reachable (mock) or unparseable → no spans.
"""

from multimodal_ocr import llm
from multimodal_ocr.detect import Span

LLM_TYPES = ("PERSON", "ORG", "LOCATION")

_SYSTEM = (
    "You extract personal entities from OCR'd document text for redaction. "
    'Return ONLY a JSON array of {"type": "PERSON"|"ORG"|"LOCATION", "text": '
    '"<exact substring>"}. Copy the substring verbatim. No prose, no code fences.'
)


def llm_entities(text: str, provider: str | None = "auto",
                 model: str | None = None) -> tuple[list[Span], llm.LLMResult]:
    parsed, result = llm.complete_json(f"TEXT:\n{text}", _SYSTEM, provider, model)
    spans: list[Span] = []
    if isinstance(parsed, list):
        for ent in parsed:
            if not isinstance(ent, dict):
                continue
            etype = str(ent.get("type", "")).upper()
            value = str(ent.get("text", ""))
            if etype in LLM_TYPES and value:
                idx = text.find(value)
                if idx != -1:
                    spans.append(Span(etype, idx, idx + len(value), value))
    return spans, result


def merge(regex_spans: list[Span], llm_spans: list[Span]) -> list[Span]:
    """Combine, regex wins on overlap (structured PII > model output)."""
    claimed = [(s.start, s.end) for s in regex_spans]
    out = list(regex_spans)
    for s in llm_spans:
        if not any(s.start < ce and s.end > cs for cs, ce in claimed):
            out.append(s)
            claimed.append((s.start, s.end))
    return sorted(out, key=lambda s: s.start)
