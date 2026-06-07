"""Ollama embeddings — real semantic retrieval, local and free.

Activates when ``OLLAMA_BASE_URL`` is set (and no OpenAI key takes
precedence). The embedding model (default ``nomic-embed-text``) is
probed at startup: one embed call both verifies the model is pulled
and learns its dimensionality. Probe failure falls back to the hash
embedder with a warning — never a crash.
"""

import httpx

from persona_twin.log import get_logger, kv

logger = get_logger("embedding.ollama")

DEFAULT_EMBED_MODEL = "nomic-embed-text"
PROBE_TIMEOUT_S = 15.0
EMBED_TIMEOUT_S = 120.0


def _embed_url(base_url: str) -> str:
    base = base_url.rstrip("/").removesuffix("/v1")
    return f"{base}/api/embed"


class OllamaEmbedder:
    name = "ollama"

    def __init__(self, base_url: str, model: str = DEFAULT_EMBED_MODEL) -> None:
        self._url = _embed_url(base_url)
        self.model = model
        self.dimensions = self._probe_dimensions()

    def _probe_dimensions(self) -> int:
        """One synchronous startup probe: model exists + dimensionality."""
        response = httpx.post(
            self._url,
            json={"model": self.model, "input": ["dimension probe"]},
            timeout=PROBE_TIMEOUT_S,
        )
        response.raise_for_status()
        dims = len(response.json()["embeddings"][0])
        logger.info("ollama embedder ready %s", kv(model=self.model, dims=dims))
        return dims

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                self._url,
                json={"model": self.model, "input": texts},
                timeout=EMBED_TIMEOUT_S,
            )
            response.raise_for_status()
            return response.json()["embeddings"]

    async def embed_query(self, text: str) -> list[float]:
        return (await self.embed_documents([text]))[0]
