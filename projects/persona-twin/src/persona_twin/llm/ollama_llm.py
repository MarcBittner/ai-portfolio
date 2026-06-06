"""Ollama provider — local models as routing choices.

Ollama serves an OpenAI-compatible API, so the provider is the OpenAI
SDK pointed at ``OLLAMA_BASE_URL``. Loaded models are **discovered at
startup** (``/api/tags``) and merged into the registry with zero cost —
so under the ``cost`` objective, local models route first and the cloud
chain stays behind them as fallback.

Requires the ``openai`` extra. Structured outputs use the same
``response_format`` JSON-schema path (supported by Ollama ≥ 0.5);
models that mangle a schema fall through the router's validation-retry
and fallback chain like any other provider failure.
"""

import httpx

from persona_twin.llm.base import ModelSpec
from persona_twin.llm.openai_llm import OpenAIProvider
from persona_twin.log import get_logger, kv

logger = get_logger("llm.ollama")

DISCOVERY_TIMEOUT_S = 3.0


class OllamaProvider(OpenAIProvider):
    # complete() inherited; provider attribution follows self.name
    name = "ollama"

    def __init__(self, base_url: str) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "Ollama provider requires the 'openai' extra: "
                'pip install "persona-twin[openai]"'
            ) from exc
        # Ollama ignores the key but the SDK requires one
        self._client = AsyncOpenAI(api_key="ollama", base_url=_v1(base_url))


def _v1(base_url: str) -> str:
    base = base_url.rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def discover_ollama_models(base_url: str) -> list[ModelSpec]:
    """Loaded models from ``/api/tags`` as registry specs.

    Local inference is free (cost 0) and private; quality/speed ranks
    are deliberately conservative editorial defaults — measure with
    `make eval` before trusting a local model with a task. Failure to
    reach Ollama logs a warning and returns [] (the rest of the
    registry is unaffected).
    """
    tags_url = _v1(base_url).removesuffix("/v1") + "/api/tags"
    try:
        response = httpx.get(tags_url, timeout=DISCOVERY_TIMEOUT_S)
        response.raise_for_status()
        names = [m["name"] for m in response.json().get("models", [])]
    except Exception as exc:  # noqa: BLE001 — discovery is best-effort
        logger.warning(
            "ollama discovery failed %s", kv(url=tags_url, error=type(exc).__name__)
        )
        return []
    specs = [
        ModelSpec(
            provider="ollama",
            id=name,
            input_per_mtok=0.0,
            output_per_mtok=0.0,
            quality=4,
            speed=6,
        )
        for name in sorted(names)
    ]
    logger.info("ollama models discovered %s", kv(count=len(specs)))
    return specs
