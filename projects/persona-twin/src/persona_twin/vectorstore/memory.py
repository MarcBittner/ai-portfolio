"""In-memory vector store — the offline default.

Exact cosine similarity over a NumPy matrix. Behaviorally equivalent to
the Atlas store for the demo corpus (same port, same contract tests).
"""

import numpy as np

from persona_twin.models import Chunk, ScoredChunk


class MemoryVectorStore:
    def __init__(self, dimensions: int) -> None:
        self.dimensions = dimensions
        self._chunks: dict[str, Chunk] = {}
        self._vectors: dict[str, np.ndarray] = {}

    async def upsert(self, chunks: list[Chunk], vectors: list[list[float]]) -> None:
        if len(chunks) != len(vectors):
            raise ValueError("chunks and vectors length mismatch")
        for chunk, vec in zip(chunks, vectors, strict=True):
            arr = np.asarray(vec, dtype=np.float32)
            if arr.shape != (self.dimensions,):
                raise ValueError(
                    f"vector for {chunk.chunk_id} has dims {arr.shape[0]}, "
                    f"store expects {self.dimensions}"
                )
            self._chunks[chunk.chunk_id] = chunk
            self._vectors[chunk.chunk_id] = arr

    async def search(
        self, query_vector: list[float], k: int = 5, persona_id: str | None = None
    ) -> list[ScoredChunk]:
        ids = [
            cid
            for cid, chunk in self._chunks.items()
            if persona_id is None or chunk.persona_id == persona_id
        ]
        if not ids:
            return []
        matrix = np.stack([self._vectors[cid] for cid in ids])
        query = np.asarray(query_vector, dtype=np.float32)
        # Cosine similarity (vectors may not be pre-normalized)
        norms = np.linalg.norm(matrix, axis=1) * (np.linalg.norm(query) or 1.0)
        norms[norms == 0.0] = 1.0
        scores = (matrix @ query) / norms
        order = np.argsort(scores)[::-1][:k]
        return [
            ScoredChunk(chunk=self._chunks[ids[i]], score=float(scores[i])) for i in order
        ]

    async def count(self) -> int:
        return len(self._chunks)

    async def drop(self) -> None:
        self._chunks.clear()
        self._vectors.clear()
