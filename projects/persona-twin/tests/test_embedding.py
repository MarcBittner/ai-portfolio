"""Hash embedder: determinism, dimensionality, coarse semantic behavior."""

import math

from persona_twin.embedding import HashEmbedder


def cosine(a: list[float], b: list[float]) -> float:
    num = sum(x * y for x, y in zip(a, b, strict=True))
    den = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return num / den if den else 0.0


async def test_deterministic_across_instances():
    text = "The balcony garden needs compost and bamboo stakes."
    v1 = await HashEmbedder().embed_query(text)
    v2 = await HashEmbedder().embed_query(text)
    assert v1 == v2


async def test_dimensions_and_normalization():
    emb = HashEmbedder(dimensions=128)
    assert emb.dimensions == 128
    vecs = await emb.embed_documents(["hello world", "another text"])
    assert all(len(v) == 128 for v in vecs)
    for v in vecs:
        assert abs(math.sqrt(sum(x * x for x in v)) - 1.0) < 1e-6


async def test_related_text_scores_higher_than_unrelated():
    emb = HashEmbedder()
    garden = await emb.embed_query("planting tomato seedlings in the garden")
    related = await emb.embed_query("the garden tomatoes are sprouting")
    unrelated = await emb.embed_query("quarterly derivatives portfolio rebalancing")
    assert cosine(garden, related) > cosine(garden, unrelated)


async def test_empty_text_is_zero_vector():
    v = await HashEmbedder().embed_query("")
    assert all(x == 0.0 for x in v)


async def test_query_and_document_embeddings_agree():
    emb = HashEmbedder()
    text = "morning run along the river"
    assert await emb.embed_query(text) == (await emb.embed_documents([text]))[0]
