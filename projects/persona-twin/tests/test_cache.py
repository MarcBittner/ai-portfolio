"""Cache port: LRU/TTL semantics, embedder wrapper, answer cache via API."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.cache import CacheStats, MemoryCache, cache_key
from persona_twin.config import Settings
from persona_twin.embedding import HashEmbedder
from persona_twin.embedding.cached import CachedEmbedder


class TestMemoryCache:
    async def test_get_set_roundtrip(self):
        cache = MemoryCache()
        await cache.set("k", "v")
        assert await cache.get("k") == "v"
        assert await cache.get("missing") is None

    async def test_ttl_expiry(self, monkeypatch):
        import persona_twin.cache as cache_mod

        now = [1000.0]
        monkeypatch.setattr(cache_mod.time, "monotonic", lambda: now[0])
        cache = MemoryCache()
        await cache.set("k", "v", ttl=10)
        now[0] += 5
        assert await cache.get("k") == "v"
        now[0] += 6
        assert await cache.get("k") is None

    async def test_lru_eviction(self):
        cache = MemoryCache(max_entries=2)
        await cache.set("a", "1")
        await cache.set("b", "2")
        await cache.get("a")  # refresh a; b becomes LRU
        await cache.set("c", "3")
        assert await cache.get("a") == "1"
        assert await cache.get("b") is None
        assert await cache.get("c") == "3"

    def test_cache_key_stable_and_distinct(self):
        assert cache_key("ask", "ada", "q") == cache_key("ask", "ada", "q")
        assert cache_key("ask", "ada", "q") != cache_key("ask", "buck", "q")


class TestCachedEmbedder:
    async def test_query_hits_and_misses_counted(self):
        stats = CacheStats()
        embedder = CachedEmbedder(HashEmbedder(), MemoryCache(), stats)
        v1 = await embedder.embed_query("repeated question")
        v2 = await embedder.embed_query("repeated question")
        assert v1 == v2
        assert stats.misses["query_embedding"] == 1
        assert stats.hits["query_embedding"] == 1

    async def test_documents_not_cached(self):
        stats = CacheStats()
        embedder = CachedEmbedder(HashEmbedder(), MemoryCache(), stats)
        await embedder.embed_documents(["a", "b"])
        assert "query_embedding" not in stats.hits
        assert "query_embedding" not in stats.misses


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    async with httpx.ASGITransport(app=app) as transport:
        from persona_twin.chunking import get_chunker
        from persona_twin.pipeline import ingest_corpus

        state = app.state.twin
        await ingest_corpus(
            get_chunker("content_aware"), state.embedder, state.store,
            records=state.records,
        )
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield client


class TestAnswerCache:
    PAYLOAD = {
        "persona_id": "ada-quill",
        "question": "What tomato variety are you growing this year?",
    }

    async def test_repeat_ask_is_served_from_cache(self, client):
        first = (await client.post("/ask", json=self.PAYLOAD)).json()
        second = (await client.post("/ask", json=self.PAYLOAD)).json()
        assert first == second
        health = (await client.get("/health")).json()
        assert health["cache_backend"] == "memory"
        assert health["cache_stats"]["misses"]["answer"] == 1
        assert health["cache_stats"]["hits"]["answer"] == 1

    async def test_debug_requests_bypass_answer_cache(self, client):
        payload = {**self.PAYLOAD, "debug": True}
        r1 = (await client.post("/ask", json=payload)).json()
        assert r1["debug"]["cache"]["backend"] == "memory"
        health = (await client.get("/health")).json()
        assert "answer" not in health["cache_stats"]["hits"]

    async def test_api_prefix_alias_serves_same_routes(self, client):
        bare = (await client.get("/health")).json()
        prefixed = (await client.get("/api/health")).json()
        assert prefixed["status"] == bare["status"] == "ok"
        ask = await client.post("/api/ask", json=self.PAYLOAD)
        assert ask.status_code == 200
        assert ask.json()["answered"] is True
