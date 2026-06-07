"""Deterministic hashed n-gram embedder — the offline default.

Projects word unigrams and character trigrams into a fixed-dimension
space via a stable hash (blake2b, not Python's randomized ``hash()``),
then L2-normalizes. No model, no network, stable across runs and
machines — which makes retrieval tests exact instead of probabilistic.

Quality is obviously below a learned embedding model; it is adequate
for the bundled demo corpus and is *measured*, not assumed — see the
eval harness.
"""

import hashlib
import math
import re

_TOKEN = re.compile(r"[a-z0-9]+")


class HashEmbedder:
    name = "hash"

    def __init__(self, dimensions: int = 256) -> None:
        self.dimensions = dimensions

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return self._embed(text)

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dimensions
        for feature, weight in self._features(text):
            digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[index] += sign * weight
        norm = math.sqrt(sum(x * x for x in vec))
        if norm == 0.0:
            return vec
        return [x / norm for x in vec]

    def _features(self, text: str) -> list[tuple[str, float]]:
        tokens = _TOKEN.findall(text.lower())
        feats: list[tuple[str, float]] = [(f"w:{t}", 1.0) for t in tokens]
        for token in tokens:
            padded = f"^{token}$"
            feats.extend(
                (f"c3:{padded[i:i + 3]}", 0.25) for i in range(len(padded) - 2)
            )
        return feats
