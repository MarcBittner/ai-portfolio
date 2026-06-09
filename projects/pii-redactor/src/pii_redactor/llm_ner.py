"""Optional LLM named-entity pass for PII the regexes can't catch.

Regex handles structured PII (emails, SSNs, cards); names, organizations, and
locations need a model. This asks the configured LLM (Ollama by default) for a
JSON list of entities and maps each back to a span in the source. It degrades
safely: if no provider is reachable (mock) or the JSON doesn't parse, it
returns nothing and the regex detections stand alone.
"""

from pii_redactor import llm
from pii_redactor.detect import Span

LLM_TYPES = ("PERSON", "ORG", "LOCATION")

_SYSTEM = (
    "You extract personal entities from text for redaction. Return ONLY a JSON "
    'array of objects {"type": "PERSON"|"ORG"|"LOCATION", "text": "<exact '
    'substring>"}. Copy the substring verbatim. No prose, no code fences.'
)


def llm_entities(text: str, provider: str | None = "auto",
                 model: str | None = None) -> tuple[list[Span], llm.LLMResult]:
    """Return (spans, llm_result). spans is empty when the provider is mock /
    unreachable or the response can't be parsed."""
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
    """Combine, keeping regex spans on overlap (structured PII is higher
    precision than model output)."""
    claimed = [(s.start, s.end) for s in regex_spans]
    merged = list(regex_spans)
    for s in llm_spans:
        if not any(s.start < ce and s.end > cs for cs, ce in claimed):
            merged.append(s)
            claimed.append((s.start, s.end))
    return sorted(merged, key=lambda s: s.start)
