"""OpenRouter provider — rented aggregation behind first-party policy.

OpenRouter exposes many upstream models through one OpenAI-compatible
endpoint, so this is the OpenAI SDK pointed at a different base URL.
Routing *policy* (which model, when, with what fallback) stays in
``LLMRouter``; OpenRouter only widens the menu.

Requires the ``openai`` extra and ``OPENROUTER_API_KEY``.
"""

import httpx

from persona_twin.llm.base import ModelSpec
from persona_twin.llm.openai_llm import OpenAIProvider
from persona_twin.log import get_logger, kv

logger = get_logger("llm.openrouter")

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DISCOVERY_TIMEOUT_S = 5.0
FREE_MODEL_CAP = 8


class OpenRouterProvider(OpenAIProvider):
    # complete() is inherited; provider attribution follows self.name
    name = "openrouter"

    def __init__(self, api_key: str | None = None) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "OpenRouter provider requires the 'openai' extra: "
                'pip install "persona-twin[openai]"'
            ) from exc
        self._client = AsyncOpenAI(api_key=api_key, base_url=OPENROUTER_BASE_URL)


def discover_free_models(cap: int = FREE_MODEL_CAP) -> list[ModelSpec]:
    """OpenRouter models priced at $0/$0, as registry specs.

    The free lineup churns weekly, so it's discovered at startup rather
    than committed to models.yaml. Capped (largest context first) to
    keep the registry readable; failure logs and returns [] — the rest
    of the registry is unaffected. Free models are rate-limited and
    quality ranks are conservative defaults: benchmark before trusting.
    """
    try:
        response = httpx.get(f"{OPENROUTER_BASE_URL}/models", timeout=DISCOVERY_TIMEOUT_S)
        response.raise_for_status()
        models = response.json().get("data", [])
    except Exception as exc:  # noqa: BLE001 — discovery is best-effort
        logger.warning("openrouter discovery failed %s", kv(error=type(exc).__name__))
        return []
    free = [
        m
        for m in models
        if float(m.get("pricing", {}).get("prompt", 1)) == 0.0
        and float(m.get("pricing", {}).get("completion", 1)) == 0.0
    ]
    free.sort(key=lambda m: -(m.get("context_length") or 0))
    specs = [
        ModelSpec(
            provider="openrouter",
            id=m["id"],
            input_per_mtok=0.0,
            output_per_mtok=0.0,
            quality=5,
            speed=5,
        )
        for m in free[:cap]
    ]
    logger.info(
        "openrouter free models discovered %s", kv(total=len(free), kept=len(specs))
    )
    return specs
