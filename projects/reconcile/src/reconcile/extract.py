"""Line-item extraction from a change-order / invoice document.

Two paths, same output shape:

* **Deterministic table parser** (default, offline, no model) — pulls structured
  rows ``CSI | description | qty unit | $unit_cost | $total`` with a provenance
  span and a consistency-based confidence (does ``qty × unit_cost`` match the
  stated total?). This is what runs on the free hosted demo.
* **LLM structured-output path** (opt-in, when a provider is configured) — asks
  the model for a schema-constrained JSON array of line items, mirroring the
  production approach (Claude structured outputs). Falls back to the deterministic
  parser whenever no model is available or the JSON doesn't parse.

The two are reconciled by ``variance.py`` identically.
"""

import re
from dataclasses import asdict, dataclass

from reconcile import llm

# CSI | description | "<qty> <unit>" | $unit_cost | $total
_ROW = re.compile(
    r"^\s*(\d{2} \d{2} \d{2})\s*\|\s*(.+?)\s*\|\s*"
    r"([\d,]+(?:\.\d+)?)\s+([A-Za-z]+)\s*\|\s*"
    r"\$?\s*([\d,]+(?:\.\d+)?)\s*\|\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$",
    re.MULTILINE,
)


@dataclass
class LineItem:
    csi: str
    description: str
    quantity: float
    unit: str
    unit_cost: float
    total: float
    confidence: float
    method: str  # "table" | "llm"
    start: int | None = None
    end: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _num(s: str) -> float:
    return float(s.replace(",", "").replace("$", "").strip())


def _confidence(quantity: float, unit_cost: float, total: float, base: float) -> float:
    """Down-weight a row whose qty × unit_cost doesn't reconcile to its total —
    an internal inconsistency is exactly what a human should re-check."""
    expected = quantity * unit_cost
    if expected == 0:
        return round(base - 0.2, 2)
    drift = abs(expected - total) / expected
    penalty = 0.0 if drift <= 0.01 else (0.15 if drift <= 0.05 else 0.35)
    return round(max(0.3, base - penalty), 2)


def parse_table(text: str) -> list[LineItem]:
    """Deterministic extraction of well-formed table rows."""
    items: list[LineItem] = []
    for m in _ROW.finditer(text):
        csi, desc, qty, unit, unit_cost, total = m.groups()
        q, uc, tot = _num(qty), _num(unit_cost), _num(total)
        items.append(LineItem(
            csi=csi, description=desc.strip(), quantity=q, unit=unit.upper(),
            unit_cost=uc, total=tot, method="table",
            confidence=_confidence(q, uc, tot, base=0.92),
            start=m.start(), end=m.end(),
        ))
    return items


_LLM_SYSTEM = (
    "You extract construction change-order line items as STRICT JSON. Return only "
    "a JSON array; each element has keys: csi (string 'NN NN NN'), description "
    "(string), quantity (number), unit (string), unit_cost (number), total "
    "(number). No prose, no code fence."
)


def llm_extract(text: str, provider: str | None = "auto",
                model: str | None = None) -> tuple[list[LineItem] | None, llm.LLMResult]:
    """Schema-constrained line-item extraction via the LLM router. Returns
    ``(items_or_None, routing)`` — None when no model is available or parse fails,
    so the caller falls back to the deterministic parser."""
    parsed, result = llm.complete_json(
        f"Document:\n{text}\n\nReturn the line items as JSON.", _LLM_SYSTEM,
        provider=provider, model=model,
    )
    if not isinstance(parsed, list):
        return None, result
    items: list[LineItem] = []
    for row in parsed:
        try:
            q = float(row["quantity"])
            uc = float(row["unit_cost"])
            tot = float(row.get("total", q * uc))
            items.append(LineItem(
                csi=str(row["csi"]).strip(), description=str(row["description"]).strip(),
                quantity=q, unit=str(row["unit"]).upper(), unit_cost=uc, total=tot,
                method="llm", confidence=_confidence(q, uc, tot, base=0.9),
            ))
        except (KeyError, TypeError, ValueError):
            continue
    return (items or None), result


def extract_line_items(text: str, use_llm: bool = True, provider: str | None = "auto",
                       model: str | None = None
                       ) -> tuple[list[LineItem], llm.LLMResult | None, str]:
    """Extract line items, preferring the LLM structured-output path when a model
    is configured and returns usable JSON, else the deterministic parser. Returns
    ``(items, routing_or_None, method)``."""
    if use_llm:
        items, result = llm_extract(text, provider, model)
        if items is not None:
            return items, result, "llm"
        return parse_table(text), result, "table"
    return parse_table(text), None, "table"
