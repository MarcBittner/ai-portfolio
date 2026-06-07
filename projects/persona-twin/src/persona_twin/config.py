"""Environment-driven configuration.

Backend selection is purely environmental: with no configuration at all,
every backend resolves to its offline default (in-memory vector store,
deterministic mock LLM, hash embedder, in-process cache). Setting the
relevant environment variable switches a backend on — no code changes.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

RouteObjective = Literal["cost", "latency", "quality"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", populate_by_name=True
    )

    # LLM providers
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openrouter_api_key: str | None = None

    # Ollama (local models; e.g. http://localhost:11434)
    ollama_base_url: str | None = None
    ollama_embed_model: str = "nomic-embed-text"

    # Custom OpenAI-compatible providers (JSON; see docs/free-models.md)
    extra_providers: str | None = Field(
        default=None, validation_alias="PERSONA_TWIN_EXTRA_PROVIDERS"
    )
    # Discover OpenRouter's $0 models at startup (needs OPENROUTER_API_KEY)
    openrouter_free_discovery: bool = Field(
        default=True, validation_alias="PERSONA_TWIN_OPENROUTER_FREE"
    )

    # MongoDB Atlas (vector store)
    mongodb_uri: str | None = None
    mongodb_db: str = "persona_twin"
    mongodb_vector_index: str = "persona_chunks_index"

    # Redis cache
    redis_url: str | None = None

    # Behavior overrides
    mock_mode: bool = Field(default=False, validation_alias="PERSONA_TWIN_MOCK")
    route_objective: RouteObjective = Field(
        default="cost", validation_alias="PERSONA_TWIN_ROUTE_OBJECTIVE"
    )

    @property
    def llm_backends(self) -> list[str]:
        """Configured LLM providers, in registry order. Always ends with mock."""
        if self.mock_mode:
            return ["mock"]
        backends = []
        if self.anthropic_api_key:
            backends.append("anthropic")
        if self.openai_api_key:
            backends.append("openai")
        if self.openrouter_api_key:
            backends.append("openrouter")
        if self.ollama_base_url:
            backends.append("ollama")
        from persona_twin.llm.custom import parse_extra_providers

        backends.extend(p.name for p in parse_extra_providers(self.extra_providers))
        backends.append("mock")
        return backends

    @property
    def vector_backend(self) -> Literal["atlas", "memory"]:
        return "atlas" if self.mongodb_uri else "memory"

    @property
    def embedding_backend(self) -> Literal["openai", "ollama", "hash"]:
        if self.mock_mode:
            return "hash"
        if self.openai_api_key:
            return "openai"
        if self.ollama_base_url:
            return "ollama"
        return "hash"

    @property
    def cache_backend(self) -> Literal["redis", "memory"]:
        return "redis" if self.redis_url else "memory"


@lru_cache
def get_settings() -> Settings:
    return Settings()
