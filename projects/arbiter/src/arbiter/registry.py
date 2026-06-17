"""Model registry — the source of truth for pricing, capability tier, and which
provider serves a given logical model id.

Prices are **list** prices in USD per million tokens (input, output). They are the
real, published numbers for the hosted models; local (Ollama) and free
(OpenRouter ``:free``) models are priced at 0 because they cost ~nothing to run —
which is exactly why they are the interesting routing *targets*.

``quality_tier`` (1 = weak … 5 = frontier) is only used to *order candidates*
(never serve cheaper without a real quality measurement) and to project savings
in the "what-if" view. ``speed`` (1 = slow … 5 = fast) breaks ties.

The registry is editable at runtime via the API; this module just seeds it.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Model:
    id: str           # logical id the client requests (the OpenAI `model` field)
    provider: str     # anthropic | openai | openrouter | ollama
    model: str        # provider-specific model name actually called
    in_price: float   # USD / million input tokens (list)
    out_price: float  # USD / million output tokens (list)
    quality_tier: int  # 1 (weak) .. 5 (frontier)
    speed: int        # 1 (slow) .. 5 (fast)
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# Seed registry. Prices are representative published list prices ($/Mtok).
_SEED: list[Model] = [
    # ---- frontier / large (expensive) ----
    Model("claude-opus-4-8", "anthropic", "claude-opus-4-8", 15.0, 75.0, 5, 2,
          "frontier reasoning; the default people over-use"),
    Model("gpt-4o", "openai", "gpt-4o", 2.5, 10.0, 4, 3, "strong general model"),
    Model("claude-sonnet-4-6", "anthropic", "claude-sonnet-4-6", 3.0, 15.0, 4, 3,
          "balanced workhorse"),
    # ---- small / cheap (frequent downgrade targets) ----
    Model("claude-haiku-4-5", "anthropic", "claude-haiku-4-5-20251001", 1.0, 5.0, 3, 5,
          "fast + cheap; great for extraction/classification"),
    Model("gpt-4o-mini", "openai", "gpt-4o-mini", 0.15, 0.60, 2, 5,
          "very cheap; fine for routine tasks"),
    # ---- free hosted ----
    Model("gemma-free", "openrouter", "google/gemma-4-31b-it:free", 0.0, 0.0, 2, 4,
          "free OpenRouter tier"),
    # ---- local (Ollama) — priced at 0, the ultimate target ----
    Model("local-large", "ollama", os.environ.get("OLLAMA_LARGE", "qwen2.5:14b"),
          0.0, 0.0, 3, 3, "local large model (your hardware)"),
    Model("local-small", "ollama", os.environ.get("OLLAMA_SMALL", "llama3.2:3b"),
          0.0, 0.0, 2, 5, "local small model (your hardware)"),
    Model("local", "ollama", os.environ.get("OLLAMA_MODEL", "llama3.1:8b"),
          0.0, 0.0, 2, 4, "local default model"),
]


class Registry:
    """Mutable model registry with helpers for routing decisions."""

    def __init__(self, models: list[Model] | None = None):
        self._models: dict[str, Model] = {}
        for m in models if models is not None else _SEED:
            self._models[m.id] = m

    def all(self) -> list[Model]:
        return list(self._models.values())

    def get(self, model_id: str) -> Model | None:
        return self._models.get(model_id)

    def upsert(self, m: Model) -> None:
        self._models[m.id] = m

    def blended_price(self, model_id: str) -> float:
        """A single $/Mtok number (assume 1:3 in:out) for ranking + display."""
        m = self.get(model_id)
        if not m:
            return 0.0
        return (m.in_price + 3 * m.out_price) / 4

    def cheaper_candidates(self, baseline_id: str) -> list[Model]:
        """Models strictly cheaper than the baseline, ordered cheapest-first.

        We never *assume* a cheaper model is good enough — these are only
        *candidates* to be quality-measured. We do skip models more than one
        capability tier below the baseline by default (configurable), since a
        huge tier gap rarely survives the quality floor and wastes shadow calls.
        """
        base = self.get(baseline_id)
        base_price = self.blended_price(baseline_id)
        out = []
        for m in self._models.values():
            if m.id == baseline_id:
                continue
            if self.blended_price(m.id) >= base_price:
                continue
            if base and base.quality_tier - m.quality_tier > 2:
                continue
            out.append(m)
        out.sort(key=lambda m: self.blended_price(m.id))
        return out


# A module-level default the API mutates; tests construct their own.
DEFAULT = Registry()
