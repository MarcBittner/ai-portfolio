"""Fixed-size chunking with overlap — the baseline strategy.

Fast and simple, but blind to structure: it splits mid-sentence and
mid-thought, which hurts retrieval precision (see
docs/chunking-tradeoffs.md).
"""

from persona_twin.chunking.base import build_chunks
from persona_twin.models import Chunk


class FixedChunker:
    strategy = "fixed"

    def __init__(self, size: int = 800, overlap: int = 100) -> None:
        if overlap >= size:
            raise ValueError("overlap must be smaller than size")
        self.size = size
        self.overlap = overlap

    def chunk(self, text: str, *, doc_id: str, persona_id: str) -> list[Chunk]:
        spans: list[tuple[int, int]] = []
        step = self.size - self.overlap
        for start in range(0, len(text), step):
            end = min(start + self.size, len(text))
            spans.append((start, end))
            if end == len(text):
                break
        return build_chunks(
            spans, text, strategy=self.strategy, doc_id=doc_id, persona_id=persona_id
        )
