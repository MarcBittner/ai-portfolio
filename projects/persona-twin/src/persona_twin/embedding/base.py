"""Embedder port."""

from typing import Protocol, runtime_checkable

from persona_twin.config import Settings


@runtime_checkable
class Embedder(Protocol):
    dimensions: int

    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...


def get_embedder(settings: Settings) -> Embedder:
    if settings.embedding_backend == "openai":
        from persona_twin.embedding.openai_embed import OpenAIEmbedder

        return OpenAIEmbedder(api_key=settings.openai_api_key)
    from persona_twin.embedding.hashed import HashEmbedder

    return HashEmbedder()
