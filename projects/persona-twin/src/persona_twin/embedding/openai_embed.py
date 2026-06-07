"""OpenAI embeddings (activates when OPENAI_API_KEY is configured).

Requires the ``openai`` extra: ``pip install "persona-twin[openai]"``.
"""

DEFAULT_MODEL = "text-embedding-3-small"
DEFAULT_DIMENSIONS = 1536


class OpenAIEmbedder:
    name = "openai"

    def __init__(
        self,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        dimensions: int = DEFAULT_DIMENSIONS,
    ) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ImportError(
                "OpenAI embeddings require the 'openai' extra: "
                'pip install "persona-twin[openai]"'
            ) from exc
        self._client = AsyncOpenAI(api_key=api_key)
        self.model = model
        self.dimensions = dimensions

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        response = await self._client.embeddings.create(
            model=self.model, input=texts, dimensions=self.dimensions
        )
        # API preserves input order; sort defensively by index anyway.
        return [item.embedding for item in sorted(response.data, key=lambda d: d.index)]

    async def embed_query(self, text: str) -> list[float]:
        return (await self.embed_documents([text]))[0]
