"""Anthropic provider (Messages API).

Structured outputs use ``output_config.format`` with a JSON schema —
the canonical API-level parameter — and adaptive thinking is enabled
on models whose registry entry supports it.

Requires the ``anthropic`` extra: ``pip install "persona-twin[anthropic]"``.
"""

import time

from persona_twin.llm.base import LLMRequest, LLMResponse, LLMUsage, ModelSpec


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str | None = None) -> None:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "Anthropic provider requires the 'anthropic' extra: "
                'pip install "persona-twin[anthropic]"'
            ) from exc
        self._client = AsyncAnthropic(api_key=api_key)

    async def complete(self, request: LLMRequest, spec: ModelSpec) -> LLMResponse:
        kwargs: dict = {
            "model": spec.id,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}],
        }
        if spec.adaptive_thinking:
            kwargs["thinking"] = {"type": "adaptive"}
        if request.json_schema is not None:
            kwargs["output_config"] = {
                "format": {"type": "json_schema", "schema": request.json_schema}
            }

        started = time.perf_counter()
        response = await self._client.messages.create(**kwargs)
        latency_ms = (time.perf_counter() - started) * 1000

        text = next((b.text for b in response.content if b.type == "text"), "")
        usage = LLMUsage(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )
        return LLMResponse(
            text=text,
            provider=self.name,
            model=spec.id,
            usage=usage,
            latency_ms=round(latency_ms, 1),
            cost_usd=spec.cost_usd(usage.input_tokens, usage.output_tokens),
        )
