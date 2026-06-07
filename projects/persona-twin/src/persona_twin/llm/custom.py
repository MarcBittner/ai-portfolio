"""Custom OpenAI-compatible providers from configuration.

Most free-tier inference services (Groq, Google AI Studio, Cerebras,
Mistral, GitHub Models, …) speak the OpenAI API. Rather than one
provider class per service, ``PERSONA_TWIN_EXTRA_PROVIDERS`` declares
them as data — see docs/free-models.md for ready-made entries:

    PERSONA_TWIN_EXTRA_PROVIDERS='[{
        "name": "groq",
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        "models": [{"id": "llama-3.3-70b-versatile", "quality": 7, "speed": 10}]
    }]'

Keys stay in their own env vars; the JSON carries no secrets.
"""

import json
import os

from pydantic import BaseModel, Field, field_validator

from persona_twin.llm.base import ModelSpec
from persona_twin.llm.openai_llm import OpenAIProvider

RESERVED_NAMES = {"anthropic", "openai", "openrouter", "ollama", "mock", "baseline"}


class ExtraModel(BaseModel):
    id: str
    input_per_mtok: float = 0.0  # free tiers default to 0
    output_per_mtok: float = 0.0
    quality: int = Field(default=5, ge=1, le=10)
    speed: int = Field(default=5, ge=1, le=10)


class ExtraProvider(BaseModel):
    name: str
    base_url: str
    api_key_env: str | None = None  # env var HOLDING the key, never the key
    models: list[ExtraModel]

    @field_validator("name")
    @classmethod
    def not_reserved(cls, v: str) -> str:
        if v in RESERVED_NAMES:
            raise ValueError(f"provider name {v!r} is reserved")
        return v


def parse_extra_providers(raw: str | None) -> list[ExtraProvider]:
    if not raw:
        return []
    return [ExtraProvider(**entry) for entry in json.loads(raw)]


class CustomOpenAIProvider(OpenAIProvider):
    def __init__(self, config: ExtraProvider) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "Custom providers require the 'openai' extra: "
                'pip install "persona-twin[openai]"'
            ) from exc
        self.name = config.name
        api_key = os.environ.get(config.api_key_env) if config.api_key_env else None
        self._client = AsyncOpenAI(api_key=api_key or "unused", base_url=config.base_url)


def extra_specs(config: ExtraProvider) -> list[ModelSpec]:
    return [
        ModelSpec(provider=config.name, **model.model_dump()) for model in config.models
    ]
