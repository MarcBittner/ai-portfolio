"""Pure-Python BM25 (Okapi) over chunks — no dependencies.

Embeddings catch paraphrase; BM25 catches the exact term ("Black
Krim", "465"). Hybrid retrieval fuses both (see fusion.py). The index
is rebuilt at ingest — for corpora of this scale that's microseconds;
at production scale this port would sit in front of Atlas Search /
OpenSearch instead.
"""

import math
import re
from collections import Counter

from persona_twin.models import Chunk, ScoredChunk

_TOKEN = re.compile(r"[a-z0-9]+")

K1 = 1.5
B = 0.75


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


class BM25Index:
    def __init__(self) -> None:
        self._chunks: list[Chunk] = []
        self._doc_tokens: list[Counter[str]] = []
        self._doc_lens: list[int] = []
        self._df: Counter[str] = Counter()
        self._avg_len: float = 0.0

    def build(self, chunks: list[Chunk]) -> None:
        self._chunks = list(chunks)
        self._doc_tokens = []
        self._doc_lens = []
        self._df = Counter()
        for chunk in self._chunks:
            tokens = _tokens(chunk.text)
            counts = Counter(tokens)
            self._doc_tokens.append(counts)
            self._doc_lens.append(len(tokens))
            self._df.update(counts.keys())
        self._avg_len = (
            sum(self._doc_lens) / len(self._doc_lens) if self._doc_lens else 0.0
        )

    def __len__(self) -> int:
        return len(self._chunks)

    def search(
        self, query: str, k: int = 25, persona_id: str | None = None
    ) -> list[ScoredChunk]:
        if not self._chunks:
            return []
        n = len(self._chunks)
        query_tokens = _tokens(query)
        scored: list[tuple[float, int]] = []
        for i, chunk in enumerate(self._chunks):
            if persona_id is not None and chunk.persona_id != persona_id:
                continue
            counts = self._doc_tokens[i]
            length_norm = K1 * (1 - B + B * self._doc_lens[i] / (self._avg_len or 1))
            score = 0.0
            for token in query_tokens:
                tf = counts.get(token)
                if not tf:
                    continue
                idf = math.log(1 + (n - self._df[token] + 0.5) / (self._df[token] + 0.5))
                score += idf * tf * (K1 + 1) / (tf + length_norm)
            if score > 0:
                scored.append((score, i))
        scored.sort(key=lambda t: -t[0])
        return [
            ScoredChunk(chunk=self._chunks[i], score=round(score, 6))
            for score, i in scored[:k]
        ]
