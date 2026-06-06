"""Chunking strategies: fixed, semantic, and content-aware.

Every chunk is an exact substring of the source document
(``chunk.text == text[span[0]:span[1]]``), so provenance is verifiable
and citations can highlight original text.
"""

from persona_twin.chunking.base import Chunker, get_chunker
from persona_twin.chunking.content_aware import ContentAwareChunker
from persona_twin.chunking.fixed import FixedChunker
from persona_twin.chunking.semantic import SemanticChunker

__all__ = [
    "Chunker",
    "ContentAwareChunker",
    "FixedChunker",
    "SemanticChunker",
    "get_chunker",
]
