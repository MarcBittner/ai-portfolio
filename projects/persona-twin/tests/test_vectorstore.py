"""Port-level contract tests for vector stores.

The same suite runs against the in-memory store (always) and Atlas
(only when MONGODB_URI is set in the environment — skipped otherwise,
so a reviewer's offline run never fails for lack of a cluster).
"""

import os

import pytest

from persona_twin.embedding import HashEmbedder
from persona_twin.models import Chunk
from persona_twin.vectorstore import MemoryVectorStore

EMBEDDER = HashEmbedder(dimensions=64)


def make_chunk(i: int, persona_id: str, text: str) -> Chunk:
    return Chunk(
        chunk_id=f"doc{i}:fixed:{i:04d}",
        doc_id=f"doc{i}",
        persona_id=persona_id,
        text=text,
        strategy="fixed",
        char_span=(0, len(text)),
    )


CORPUS = [
    make_chunk(0, "ada", "I spent the weekend repotting tomato seedlings on the balcony."),
    make_chunk(1, "ada", "My favorite coffee shop finally restocked the Ethiopian beans."),
    make_chunk(2, "ada", "The garden compost bin attracted three very bold squirrels."),
    make_chunk(3, "buck", "Leg day at the gym destroyed me, but the deadlift PR was worth it."),
    make_chunk(4, "buck", "Tried a new protein pancake recipe; the batter was basically glue."),
]


def stores():
    yield pytest.param("memory", id="memory")
    if os.environ.get("MONGODB_URI"):
        yield pytest.param("atlas", id="atlas")
    else:
        yield pytest.param(
            "atlas", id="atlas", marks=pytest.mark.skip(reason="MONGODB_URI not set")
        )


@pytest.fixture(params=list(stores()))
async def store(request):
    if request.param == "memory":
        s = MemoryVectorStore(dimensions=EMBEDDER.dimensions)
    else:
        from persona_twin.vectorstore.atlas import AtlasVectorStore

        s = AtlasVectorStore(
            uri=os.environ["MONGODB_URI"],
            database="persona_twin_test",
            dimensions=EMBEDDER.dimensions,
        )
    await s.drop()
    vectors = await EMBEDDER.embed_documents([c.text for c in CORPUS])
    await s.upsert(CORPUS, vectors)
    yield s
    await s.drop()


async def test_count(store):
    assert await store.count() == len(CORPUS)


async def test_search_returns_most_relevant_first(store):
    q = await EMBEDDER.embed_query("tomato seedlings in the garden")
    results = await store.search(q, k=3)
    assert results
    assert results[0].chunk.doc_id == "doc0"
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)


async def test_persona_filter(store):
    q = await EMBEDDER.embed_query("gym workout deadlift")
    results = await store.search(q, k=5, persona_id="ada")
    assert results
    assert all(r.chunk.persona_id == "ada" for r in results)


async def test_k_limits_results(store):
    q = await EMBEDDER.embed_query("weekend")
    assert len(await store.search(q, k=2)) <= 2


async def test_upsert_is_idempotent(store):
    updated = CORPUS[0].model_copy(update={"text": "Updated text about tomato seedlings."})
    vec = await EMBEDDER.embed_query(updated.text)
    await store.upsert([updated], [vec])
    assert await store.count() == len(CORPUS)


async def test_dimension_mismatch_fails_loudly(store):
    with pytest.raises(ValueError, match="dims"):
        await store.upsert([CORPUS[0]], [[0.1, 0.2]])


async def test_empty_store_search(store):
    await store.drop()
    q = await EMBEDDER.embed_query("anything")
    assert await store.search(q, k=3) == []
