"""MongoDB Atlas Vector Search store (activates when MONGODB_URI is set).

Uses the ``$vectorSearch`` aggregation stage against an Atlas Search
index — MongoDB does double duty as the document store *and* the vector
store. The index definition lives at ``deploy/atlas-vector-index.json``;
setup steps in ``docs/atlas-setup.md``.

Requires the ``mongo`` extra: ``pip install "persona-twin[mongo]"``.
"""

from persona_twin.log import get_logger
from persona_twin.models import Chunk, ScoredChunk

logger = get_logger("vectorstore.atlas")

COLLECTION = "chunks"


class AtlasVectorStore:
    def __init__(
        self,
        uri: str,
        database: str = "persona_twin",
        index_name: str = "persona_chunks_index",
        dimensions: int = 1536,
    ) -> None:
        try:
            from pymongo import AsyncMongoClient
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "Atlas vector store requires the 'mongo' extra: "
                'pip install "persona-twin[mongo]"'
            ) from exc
        self._client = AsyncMongoClient(uri)
        self._col = self._client[database][COLLECTION]
        self.index_name = index_name
        self.dimensions = dimensions

    async def upsert(self, chunks: list[Chunk], vectors: list[list[float]]) -> None:
        if len(chunks) != len(vectors):
            raise ValueError("chunks and vectors length mismatch")
        if not chunks:
            return
        for vec, chunk in zip(vectors, chunks, strict=True):
            if len(vec) != self.dimensions:
                raise ValueError(
                    f"vector for {chunk.chunk_id} has dims {len(vec)}, "
                    f"index expects {self.dimensions} — re-check the Atlas "
                    "index numDimensions vs the active embedder"
                )
        from pymongo import ReplaceOne

        ops = [
            ReplaceOne(
                {"_id": chunk.chunk_id},
                {
                    "_id": chunk.chunk_id,
                    "doc_id": chunk.doc_id,
                    "persona_id": chunk.persona_id,
                    "text": chunk.text,
                    "strategy": chunk.strategy,
                    "char_span": list(chunk.char_span),
                    "embedding": vec,
                },
                upsert=True,
            )
            for chunk, vec in zip(chunks, vectors, strict=True)
        ]
        await self._col.bulk_write(ops)

    async def search(
        self, query_vector: list[float], k: int = 5, persona_id: str | None = None
    ) -> list[ScoredChunk]:
        vector_search: dict = {
            "index": self.index_name,
            "path": "embedding",
            "queryVector": query_vector,
            "numCandidates": max(100, k * 20),
            "limit": k,
        }
        if persona_id is not None:
            vector_search["filter"] = {"persona_id": persona_id}
        pipeline = [
            {"$vectorSearch": vector_search},
            {
                "$project": {
                    "doc_id": 1,
                    "persona_id": 1,
                    "text": 1,
                    "strategy": 1,
                    "char_span": 1,
                    "score": {"$meta": "vectorSearchScore"},
                }
            },
        ]
        results: list[ScoredChunk] = []
        async for doc in await self._col.aggregate(pipeline):
            results.append(
                ScoredChunk(
                    chunk=Chunk(
                        chunk_id=doc["_id"],
                        doc_id=doc["doc_id"],
                        persona_id=doc["persona_id"],
                        text=doc["text"],
                        strategy=doc["strategy"],
                        char_span=tuple(doc["char_span"]),
                    ),
                    score=float(doc["score"]),
                )
            )
        return results

    async def count(self) -> int:
        return await self._col.count_documents({})

    async def all_chunks(self) -> list[Chunk]:
        chunks: list[Chunk] = []
        async for doc in self._col.find({}, {"embedding": 0}):
            chunks.append(
                Chunk(
                    chunk_id=doc["_id"],
                    doc_id=doc["doc_id"],
                    persona_id=doc["persona_id"],
                    text=doc["text"],
                    strategy=doc["strategy"],
                    char_span=tuple(doc["char_span"]),
                )
            )
        return chunks

    async def drop(self) -> None:
        await self._col.delete_many({})
