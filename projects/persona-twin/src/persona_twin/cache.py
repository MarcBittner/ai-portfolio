"""Caching port: in-process LRU by default, Redis when REDIS_URL is set.

Used for query embeddings and full answers. Hit/miss counters surface
in ``/health`` and the ``/ask`` debug payload — a cache you can't
observe is a cache you can't trust.
"""

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from persona_twin.config import Settings

DEFAULT_TTL_SECONDS = 3600


@runtime_checkable
class Cache(Protocol):
    name: str

    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl: int = DEFAULT_TTL_SECONDS) -> None: ...


class MemoryCache:
    """In-process LRU with TTL — the offline default."""

    name = "memory"

    def __init__(self, max_entries: int = 1024) -> None:
        self.max_entries = max_entries
        self._data: OrderedDict[str, tuple[float, str]] = OrderedDict()

    async def get(self, key: str) -> str | None:
        entry = self._data.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if time.monotonic() > expires_at:
            del self._data[key]
            return None
        self._data.move_to_end(key)
        return value

    async def set(self, key: str, value: str, ttl: int = DEFAULT_TTL_SECONDS) -> None:
        self._data[key] = (time.monotonic() + ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)


class RedisCache:
    """Redis-backed cache (activates when REDIS_URL is set).

    Requires the ``redis`` extra: ``pip install "persona-twin[redis]"``.
    """

    name = "redis"

    def __init__(self, url: str) -> None:
        try:
            import redis.asyncio as redis
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "Redis cache requires the 'redis' extra: "
                'pip install "persona-twin[redis]"'
            ) from exc
        self._client = redis.from_url(url, decode_responses=True)

    async def get(self, key: str) -> str | None:
        return await self._client.get(key)

    async def set(self, key: str, value: str, ttl: int = DEFAULT_TTL_SECONDS) -> None:
        await self._client.set(key, value, ex=ttl)


@dataclass
class CacheStats:
    hits: dict[str, int] = field(default_factory=dict)
    misses: dict[str, int] = field(default_factory=dict)

    def hit(self, kind: str) -> None:
        self.hits[kind] = self.hits.get(kind, 0) + 1

    def miss(self, kind: str) -> None:
        self.misses[kind] = self.misses.get(kind, 0) + 1

    def as_dict(self) -> dict[str, dict[str, int]]:
        return {"hits": dict(self.hits), "misses": dict(self.misses)}


def cache_key(*parts: str) -> str:
    digest = hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:32]
    return f"pt:{digest}"


def get_cache(settings: Settings) -> Cache:
    if settings.cache_backend == "redis":
        return RedisCache(settings.redis_url)
    return MemoryCache()
