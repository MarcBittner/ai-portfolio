"""Corpus loader + offline ingestion pipeline end-to-end."""

import pytest

from persona_twin.chunking import get_chunker
from persona_twin.corpus import load_personas
from persona_twin.embedding import HashEmbedder
from persona_twin.pipeline import ingest_corpus
from persona_twin.vectorstore import MemoryVectorStore

EXPECTED_PERSONAS = {"ada-quill", "buck-ramirez", "gus-okafor", "mei-tanaka"}


def test_loads_all_personas():
    records = load_personas()
    assert {r.persona.persona_id for r in records} == EXPECTED_PERSONAS
    for r in records:
        assert r.persona.doc_count == len(r.documents) >= 6
        assert r.persona.bio.strip()
        assert r.persona.voice_notes
        hex_scores = r.persona.hexaco.model_dump().values()
        assert all(0.0 <= v <= 1.0 for v in hex_scores)


def test_doc_ids_are_namespaced():
    for record in load_personas():
        for doc in record.documents:
            assert doc.doc_id.startswith(f"{record.persona.persona_id}/")
            assert len(doc.text) > 100


@pytest.fixture
async def ingested():
    store = MemoryVectorStore(dimensions=256)
    embedder = HashEmbedder(dimensions=256)
    report = await ingest_corpus(get_chunker("content_aware"), embedder, store)
    return store, embedder, report


async def test_ingest_report(ingested):
    _, _, report = ingested
    assert report.personas == 4
    assert report.documents >= 24
    assert report.chunks > report.documents  # multiple chunks per doc on average
    assert report.strategy == "content_aware"
    # The corpus deliberately contains fake contact info to exercise the gate
    assert report.redactions.get("EMAIL", 0) >= 3
    assert report.redactions.get("PHONE", 0) >= 3


async def test_no_raw_pii_reaches_the_store(ingested):
    store, embedder, _ = ingested
    q = await embedder.embed_query("how do I contact you email phone booking")
    results = await store.search(q, k=20)
    for r in results:
        assert "@example.com" not in r.chunk.text
        assert "(555)" not in r.chunk.text


async def test_persona_scoped_retrieval(ingested):
    store, embedder, _ = ingested
    q = await embedder.embed_query("deadlift training squat gym")
    results = await store.search(q, k=3, persona_id="buck-ramirez")
    assert results
    assert all(r.chunk.persona_id == "buck-ramirez" for r in results)
    top_texts = " ".join(r.chunk.text.lower() for r in results)
    assert "deadlift" in top_texts
