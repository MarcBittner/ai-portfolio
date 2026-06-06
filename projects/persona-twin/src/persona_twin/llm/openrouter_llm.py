"""OpenRouter provider — rented aggregation behind first-party policy.

OpenRouter exposes many upstream models through one OpenAI-compatible
endpoint, so this is the OpenAI SDK pointed at a different base URL.
Routing *policy* (which model, when, with what fallback) stays in
``LLMRouter``; OpenRouter only widens the menu.

Requires the ``openai`` extra and ``OPENROUTER_API_KEY``.
"""

from persona_twin.llm.openai_llm import OpenAIProvider

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


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
