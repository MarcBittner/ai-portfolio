"""Optional LLM realistic-value generation for ``llm``-typed fields.

For a field of type ``llm`` with a ``description`` (e.g. "a short product
review"), this asks the router for ``n`` realistic values in one call and uses
them to replace that column. Falls back to the deterministic placeholder
generator when the provider is the mock / unreachable or the JSON doesn't parse.

Note: LLM-generated values are realistic and therefore NOT covered by the
PII-free guarantee that the deterministic generators provide.
"""

from synth_data import llm

_SYSTEM = (
    "You generate synthetic, fictional sample data. Given a DESCRIPTION and a "
    "COUNT, return ONLY a JSON array of exactly COUNT short string values "
    "matching the description. No real personal data. No prose, no code fences."
)


def fill_column(description: str, n: int, provider: str | None = "auto",
                model: str | None = None) -> tuple[list[str] | None, llm.LLMResult]:
    parsed, result = llm.complete_json(
        f"DESCRIPTION: {description or 'a short realistic value'}\nCOUNT: {n}",
        _SYSTEM, provider, model)
    if isinstance(parsed, list) and len(parsed) >= n:
        return [str(v) for v in parsed[:n]], result
    return None, result
