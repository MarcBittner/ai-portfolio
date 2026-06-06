"""Query-embedding cache wrapper.

Only ``embed_query`` is cached — document embedding happens once per
ingest in batches, while the same question (and near-duplicate ones)
recur across requests.
"""

import json

from persona_twin.cache import DEFAULT_TTL_SECONDS, Cache, CacheStats, cache_key
from persona_twin.embedding.base import Embedder


class CachedEmbedder:
    def __init__(self, inner: Embedder, cache: Cache, stats: CacheStats) -> None:
        self._inner = inner
        self._cache = cache
        self._stats = stats
        self.dimensions = inner.dimensions

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self._inner.embed_documents(texts)

    async def embed_query(self, text: str) -> list[float]:
        key = cache_key("embed", type(self._inner).__name__, str(self.dimensions), text)
        cached = await self._cache.get(key)
        if cached is not None:
            self._stats.hit("query_embedding")
            return json.loads(cached)
        self._stats.miss("query_embedding")
        vector = await self._inner.embed_query(text)
        await self._cache.set(key, json.dumps(vector), ttl=DEFAULT_TTL_SECONDS)
        return vector
