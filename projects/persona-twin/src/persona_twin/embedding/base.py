"""Embedder port."""

from typing import Protocol, runtime_checkable

from persona_twin.config import Settings


@runtime_checkable
class Embedder(Protocol):
    dimensions: int

    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...


def get_embedder(settings: Settings) -> Embedder:
    backend = settings.embedding_backend
    if backend == "openai":
        from persona_twin.embedding.openai_embed import OpenAIEmbedder

        return OpenAIEmbedder(api_key=settings.openai_api_key)
    if backend == "ollama":
        from persona_twin.embedding.ollama_embed import OllamaEmbedder
        from persona_twin.log import get_logger, kv

        try:
            return OllamaEmbedder(
                settings.ollama_base_url, model=settings.ollama_embed_model
            )
        except Exception as exc:  # noqa: BLE001 — startup probe is best-effort
            get_logger("embedding").warning(
                "ollama embedder unavailable, falling back to hash %s",
                kv(model=settings.ollama_embed_model, error=type(exc).__name__),
            )
    from persona_twin.embedding.hashed import HashEmbedder

    return HashEmbedder()
