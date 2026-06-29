"""Transparent caching + the signatures the caching analytics run on.

Two cost levers live here, both with **zero quality impact** (same model, same or
identical output):

1. **Response cache** — an exact repeat of a deterministic request (temperature 0)
   is served from a short-TTL cache for $0. Off for non-deterministic requests
   unless explicitly forced, so it can never change a sampled/creative output.

2. **Prompt-prefix caching** — long stable prefixes (a big system prompt, shared
   few-shot block, retrieved context) reused across many requests are detected by
   signature; the proxy can inject Anthropic ``cache_control`` so the provider
   bills those input tokens at ~0.1x, and the analytics recommend it with the
   measured reuse rate.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass

# Anthropic requires a minimum prefix size to cache; below this the overhead
# isn't worth it. Tunable.
MIN_CACHEABLE_PREFIX_TOKENS = 1024


def _canon(messages: list[dict]) -> list[dict]:
    return [{"role": m.get("role"), "content": (m.get("content") or "")}
            for m in messages]


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def request_key(model_id: str, messages: list[dict], max_tokens: int,
                temperature: float) -> str:
    payload = json.dumps(
        {"m": model_id, "msgs": _canon(messages), "mt": max_tokens,
         "t": round(temperature, 3)},
        sort_keys=True,
    )
    return _sha(payload)


def prefix_signature(messages: list[dict]) -> tuple[str, int]:
    """Hash + approx token count of the *cacheable prefix*: the system prompt plus
    every message except the final user turn (the stable, reusable part)."""
    if not messages:
        return _sha(""), 0
    prefix = messages[:-1] if len(messages) > 1 else [
        m for m in messages if m.get("role") == "system"
    ]
    text = "\n".join(m.get("content") or "" for m in prefix)
    return _sha(text), max(0, len(text) // 4)


def should_cache_prefix(prefix_tokens: int) -> bool:
    return prefix_tokens >= MIN_CACHEABLE_PREFIX_TOKENS


@dataclass
class _Entry:
    text: str
    in_tokens: int
    out_tokens: int
    model_id: str
    expires: float


class ResponseCache:
    """In-process exact-match response cache with TTL and a size cap.

    When ``maxsize`` is reached, all expired entries are removed first; if
    the dict is still at capacity, the oldest half is evicted (approximated
    by insertion order, which ``dict`` preserves in Python 3.7+).

    (Prod would back this with Redis; the interface is the same.)
    """

    def __init__(self, ttl_s: float = 900.0, maxsize: int = 10_000,
                 now=time.monotonic):
        self.ttl = ttl_s
        self.maxsize = maxsize
        self._now = now
        self._d: dict[str, _Entry] = {}
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> _Entry | None:
        e = self._d.get(key)
        if e and e.expires > self._now():
            self.hits += 1
            return e
        if e:
            del self._d[key]
        self.misses += 1
        return None

    def put(self, key: str, text: str, in_tokens: int, out_tokens: int,
            model_id: str) -> None:
        if len(self._d) >= self.maxsize:
            now = self._now()
            expired = [k for k, v in self._d.items() if v.expires <= now]
            for k in expired:
                del self._d[k]
            # If still at capacity after removing expired entries, drop the
            # oldest half by insertion order.
            if len(self._d) >= self.maxsize:
                evict = list(self._d)[: self.maxsize // 2]
                for k in evict:
                    del self._d[k]
        self._d[key] = _Entry(text, in_tokens, out_tokens, model_id,
                              self._now() + self.ttl)

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {"hits": self.hits, "misses": self.misses,
                "hit_rate": round(self.hits / total, 4) if total else 0.0,
                "size": len(self._d)}
