"""Embedding ports and implementations.

``HashEmbedder`` is the zero-dependency offline default: a deterministic
hashed n-gram projection. The OpenAI embedder activates when
``OPENAI_API_KEY`` is configured.
"""

from persona_twin.embedding.base import Embedder, get_embedder
from persona_twin.embedding.hashed import HashEmbedder

__all__ = ["Embedder", "HashEmbedder", "get_embedder"]
