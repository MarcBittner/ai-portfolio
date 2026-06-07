"""BM25, RRF fusion, and hybrid retrieval through the ask path."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.config import Settings
from persona_twin.models import Chunk, ScoredChunk
from persona_twin.retrieval import BM25Index, reciprocal_rank_fusion


def chunk(i: int, persona: str, text: str) -> Chunk:
    return Chunk(
        chunk_id=f"d{i}:fixed:{i:04d}",
        doc_id=f"d{i}",
        persona_id=persona,
        text=text,
        strategy="fixed",
        char_span=(0, len(text)),
    )


CHUNKS = [
    chunk(0, "ada", "The tomato variety this year is Black Krim, from seedlings."),
    chunk(1, "ada", "I write longhand every morning in spiral notebooks."),
    chunk(2, "ada", "The garden was lovely, full of flowers and busy bees."),
    chunk(3, "buck", "Deadlift moved to 465 lbs for a single, belt on."),
]


class TestBM25:
    def setup_method(self):
        self.index = BM25Index()
        self.index.build(CHUNKS)

    def test_exact_term_ranks_first(self):
        results = self.index.search("Black Krim tomato", k=3)
        assert results[0].chunk.chunk_id == "d0:fixed:0000"

    def test_rare_number_found(self):
        results = self.index.search("465 lbs deadlift", k=2)
        assert results[0].chunk.persona_id == "buck"

    def test_persona_filter(self):
        results = self.index.search("465 deadlift garden", k=5, persona_id="ada")
        assert all(r.chunk.persona_id == "ada" for r in results)

    def test_no_match_returns_empty(self):
        assert self.index.search("zygomorphic quasar", k=3) == []

    def test_empty_index(self):
        assert BM25Index().search("anything") == []


class TestRRF:
    def test_agreement_wins(self):
        a = [ScoredChunk(chunk=CHUNKS[0], score=0.9), ScoredChunk(chunk=CHUNKS[1], score=0.5)]
        b = [ScoredChunk(chunk=CHUNKS[0], score=12.0), ScoredChunk(chunk=CHUNKS[2], score=3.0)]
        fused = reciprocal_rank_fusion([a, b], k=3)
        assert fused[0].chunk.chunk_id == CHUNKS[0].chunk_id  # ranked #1 in both
        assert len(fused) == 3  # union, deduped

    def test_single_list_passthrough_order(self):
        a = [ScoredChunk(chunk=CHUNKS[i], score=1.0 - i / 10) for i in range(3)]
        fused = reciprocal_rank_fusion([a], k=3)
        assert [f.chunk.chunk_id for f in fused] == [c.chunk.chunk_id for c in a[:3]]

    def test_empty(self):
        assert reciprocal_rank_fusion([[], []]) == []


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    from persona_twin.chunking import get_chunker
    from persona_twin.pipeline import ingest_corpus

    state = app.state.twin
    await ingest_corpus(
        get_chunker("content_aware"), state.embedder, state.store, records=state.records
    )
    state.bm25.build(await state.store.all_chunks())
    async with (
        httpx.ASGITransport(app=app) as transport,
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


class TestHybridAskPath:
    async def test_hybrid_timing_present_and_grounded(self, client):
        response = await client.post(
            "/ask",
            json={
                "persona_id": "buck-ramirez",
                "question": "What is your current deadlift number?",
                "debug": True,
            },
        )
        body = response.json()
        assert "bm25_fuse" in body["debug"]["stage_timings_ms"]
        assert body["answered"] is True
        assert "465" in body["answer"]

    async def test_exact_number_survives_fusion(self, client):
        """The BM25 leg guarantees rare exact terms reach the candidates."""
        response = await client.post(
            "/ask",
            json={
                "persona_id": "buck-ramirez",
                "question": "How much did the drywall incident cost in dollars?",
                "debug": True,
            },
        )
        body = response.json()
        texts = " ".join(
            sc["chunk"]["text"] for sc in body["debug"]["retrieved"]
        )
        assert "340" in texts
