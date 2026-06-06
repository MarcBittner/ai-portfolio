"""Semantic chunking: pack whole sentences up to a size target.

Never splits mid-sentence (unless a single sentence exceeds
``max_size``, in which case it falls back to hard windows for that
sentence alone). Paragraph breaks count as sentence boundaries, so
headings and list items stay intact.
"""

from persona_twin.chunking.base import build_chunks, sentence_spans
from persona_twin.models import Chunk


class SemanticChunker:
    strategy = "semantic"

    def __init__(self, target_size: int = 800, max_size: int = 1600) -> None:
        if target_size > max_size:
            raise ValueError("target_size must be <= max_size")
        self.target_size = target_size
        self.max_size = max_size

    def chunk(self, text: str, *, doc_id: str, persona_id: str) -> list[Chunk]:
        spans = self._pack(sentence_spans(text))
        return build_chunks(
            spans, text, strategy=self.strategy, doc_id=doc_id, persona_id=persona_id
        )

    def _pack(self, sentences: list[tuple[int, int]]) -> list[tuple[int, int]]:
        packed: list[tuple[int, int]] = []
        current: tuple[int, int] | None = None
        for s_start, s_end in sentences:
            if s_end - s_start > self.max_size:
                # Oversized sentence: flush, then hard-split it.
                if current is not None:
                    packed.append(current)
                    current = None
                packed.extend(self._hard_split(s_start, s_end))
                continue
            if current is None:
                current = (s_start, s_end)
            elif s_end - current[0] <= self.target_size:
                current = (current[0], s_end)
            else:
                packed.append(current)
                current = (s_start, s_end)
        if current is not None:
            packed.append(current)
        return packed

    def _hard_split(self, start: int, end: int) -> list[tuple[int, int]]:
        return [(s, min(s + self.max_size, end)) for s in range(start, end, self.max_size)]
