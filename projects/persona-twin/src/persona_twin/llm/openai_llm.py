"""OpenAI provider (Chat Completions API).

Structured outputs use ``response_format`` with a strict JSON schema.

Requires the ``openai`` extra: ``pip install "persona-twin[openai]"``.
"""

import time
from collections.abc import AsyncIterator

from persona_twin.llm.base import LLMRequest, LLMResponse, LLMUsage, ModelSpec


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str | None = None) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "OpenAI provider requires the 'openai' extra: "
                'pip install "persona-twin[openai]"'
            ) from exc
        self._client = AsyncOpenAI(api_key=api_key)

    async def complete(self, request: LLMRequest, spec: ModelSpec) -> LLMResponse:
        kwargs: dict = {
            "model": spec.id,
            "max_completion_tokens": request.max_tokens,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
        }
        if request.json_schema is not None:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.schema_name,
                    "schema": request.json_schema,
                    "strict": True,
                },
            }

        started = time.perf_counter()
        response = await self._client.chat.completions.create(**kwargs)
        latency_ms = (time.perf_counter() - started) * 1000

        usage = LLMUsage(
            input_tokens=response.usage.prompt_tokens,
            output_tokens=response.usage.completion_tokens,
        )
        return LLMResponse(
            text=response.choices[0].message.content or "",
            provider=self.name,
            model=spec.id,
            usage=usage,
            latency_ms=round(latency_ms, 1),
            cost_usd=spec.cost_usd(usage.input_tokens, usage.output_tokens),
        )

    async def stream(
        self, request: LLMRequest, spec: ModelSpec
    ) -> AsyncIterator[str]:
        """Yield prose text deltas (Chat Completions ``stream=True``).

        Streaming is the chat path — prose only, no structured schema; the
        validated citation tail is a separate structured call. Inherited by
        the Ollama / OpenRouter / custom providers (all OpenAI-compatible)."""
        stream = await self._client.chat.completions.create(
            model=spec.id,
            max_completion_tokens=request.max_tokens,
            messages=[
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
