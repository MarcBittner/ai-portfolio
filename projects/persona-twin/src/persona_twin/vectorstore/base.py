"""VectorStore port."""

from typing import Protocol, runtime_checkable

from persona_twin.config import Settings
from persona_twin.models import Chunk, ScoredChunk


@runtime_checkable
class VectorStore(Protocol):
    async def upsert(self, chunks: list[Chunk], vectors: list[list[float]]) -> None: ...

    async def search(
        self, query_vector: list[float], k: int = 5, persona_id: str | None = None
    ) -> list[ScoredChunk]: ...

    async def count(self) -> int: ...

    async def drop(self) -> None: ...


def get_vector_store(settings: Settings, *, dimensions: int) -> VectorStore:
    if settings.vector_backend == "atlas":
        from persona_twin.vectorstore.atlas import AtlasVectorStore

        return AtlasVectorStore(
            uri=settings.mongodb_uri,
            database=settings.mongodb_db,
            index_name=settings.mongodb_vector_index,
            dimensions=dimensions,
        )
    from persona_twin.vectorstore.memory import MemoryVectorStore

    return MemoryVectorStore(dimensions=dimensions)
