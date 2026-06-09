"""Optional LLM extraction pass for fields the deterministic extractor misses.

Label-anchored regex handles well-structured documents; messy or unlabeled ones
need a model. After the deterministic pass, the still-missing fields are sent to
the configured LLM (Ollama by default) which returns a JSON object of values;
each is validated/normalized and located in the text for a provenance span.
Degrades safely: with no provider reachable (mock) nothing is filled and the
deterministic results stand.
"""

from doc_extract import llm
from doc_extract.extract import Extracted, _validate
from doc_extract.schemas import SCHEMAS

_SYSTEM = (
    "You extract structured fields from a document. Return ONLY a JSON object "
    "mapping each requested field name to its value as a string, or null if the "
    "document does not contain it. No prose, no code fences."
)


def llm_fill(text: str, schema_name: str, missing: set[str],
             provider: str | None = "auto", model: str | None = None):
    """Return (list[Extracted] for filled fields, LLMResult|None)."""
    schema = SCHEMAS[schema_name]
    fields = [f for f in schema.fields if f.name in missing]
    if not fields:
        return [], None
    spec = "\n".join(f"- {f.name} ({f.type}): {f.description}" for f in fields)
    parsed, result = llm.complete_json(
        f"FIELDS:\n{spec}\n\nDOCUMENT:\n{text}", _SYSTEM, provider, model)
    filled: list[Extracted] = []
    if isinstance(parsed, dict):
        for f in fields:
            raw = parsed.get(f.name)
            if not isinstance(raw, (str, int, float)) or not str(raw).strip():
                continue
            value = str(raw).strip()
            valid, normalized = _validate(f.type, value)
            idx = text.find(value)
            filled.append(Extracted(
                name=f.name, type=f.type, found=True, value=value,
                normalized=normalized, valid=valid, confidence=0.7,
                start=idx if idx != -1 else None,
                end=(idx + len(value)) if idx != -1 else None, method="llm",
            ))
    return filled, result
