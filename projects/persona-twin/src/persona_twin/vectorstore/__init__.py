"""Vector store ports and implementations.

``MemoryVectorStore`` (NumPy cosine similarity) is the offline default.
``AtlasVectorStore`` (MongoDB Atlas ``$vectorSearch``) activates when
``MONGODB_URI`` is configured.
"""

from persona_twin.vectorstore.base import VectorStore, get_vector_store
from persona_twin.vectorstore.memory import MemoryVectorStore

__all__ = ["MemoryVectorStore", "VectorStore", "get_vector_store"]
