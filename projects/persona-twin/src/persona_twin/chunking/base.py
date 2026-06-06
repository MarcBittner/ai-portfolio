"""Chunker protocol and shared helpers."""

import re
from typing import Protocol, runtime_checkable

from persona_twin.models import Chunk, ChunkStrategy


@runtime_checkable
class Chunker(Protocol):
    strategy: ChunkStrategy

    def chunk(self, text: str, *, doc_id: str, persona_id: str) -> list[Chunk]: ...


def build_chunks(
    spans: list[tuple[int, int]],
    text: str,
    *,
    strategy: ChunkStrategy,
    doc_id: str,
    persona_id: str,
) -> list[Chunk]:
    """Materialize chunks from character spans, skipping whitespace-only spans."""
    chunks: list[Chunk] = []
    for start, end in spans:
        piece = text[start:end]
        if not piece.strip():
            continue
        chunks.append(
            Chunk(
                chunk_id=f"{doc_id}:{strategy}:{len(chunks):04d}",
                doc_id=doc_id,
                persona_id=persona_id,
                text=piece,
                strategy=strategy,
                char_span=(start, end),
            )
        )
    return chunks


_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])[\"')\]]*\s+")
_PARAGRAPH_BOUNDARY = re.compile(r"\n[ \t]*\n+")


def sentence_spans(text: str, offset: int = 0) -> list[tuple[int, int]]:
    """Spans of sentences in ``text``, shifted by ``offset``.

    A paragraph break always ends a sentence, even without terminal
    punctuation (headings, list items).
    """
    spans: list[tuple[int, int]] = []
    for p_start, p_end in paragraph_spans(text):
        start = p_start
        para = text[p_start:p_end]
        for m in _SENTENCE_BOUNDARY.finditer(para):
            spans.append((p_start + (start - p_start), p_start + m.start()))
            start = p_start + m.end()
        if start < p_end:
            spans.append((start, p_end))
    return [(s + offset, e + offset) for s, e in spans if text[s:e].strip()]


def paragraph_spans(text: str) -> list[tuple[int, int]]:
    """Spans of paragraphs (blocks separated by blank lines)."""
    spans: list[tuple[int, int]] = []
    start = 0
    for m in _PARAGRAPH_BOUNDARY.finditer(text):
        spans.append((start, m.start()))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return [(s, e) for s, e in spans if text[s:e].strip()]


def get_chunker(strategy: ChunkStrategy, **kwargs) -> Chunker:
    from persona_twin.chunking.content_aware import ContentAwareChunker
    from persona_twin.chunking.fixed import FixedChunker
    from persona_twin.chunking.semantic import SemanticChunker

    registry = {
        "fixed": FixedChunker,
        "semantic": SemanticChunker,
        "content_aware": ContentAwareChunker,
    }
    return registry[strategy](**kwargs)
