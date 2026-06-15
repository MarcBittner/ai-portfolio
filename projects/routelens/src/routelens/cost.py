"""Cost computation from registry list prices.

Every dollar figure in routelens traces back to this one function and the
registry's published prices — there is no fudge factor. Provider-side
prompt-cache reads are billed at ``CACHE_READ_FACTOR`` of the input price
(Anthropic charges ~0.1x for cached input), which is what makes the
prompt-caching strategy show up as real savings.
"""

from __future__ import annotations

from .registry import Registry

CACHE_READ_FACTOR = 0.10  # cached input tokens bill at ~10% of the list input price


def cost_usd(reg: Registry, model_id: str, in_tokens: int, out_tokens: int,
             cached_in_tokens: int = 0) -> float:
    """USD for one completion. ``cached_in_tokens`` is a subset of ``in_tokens``
    that was served from the provider's prompt cache (billed cheaper)."""
    m = reg.get(model_id)
    if not m:
        return 0.0
    fresh_in = max(0, in_tokens - cached_in_tokens)
    dollars = (
        fresh_in * m.in_price
        + cached_in_tokens * m.in_price * CACHE_READ_FACTOR
        + out_tokens * m.out_price
    ) / 1_000_000
    return round(dollars, 6)
