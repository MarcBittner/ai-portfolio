"""Query rewriting / multi-query expansion: rewriter, fused retrieval, and
the ask path with the setting on — all offline (mock yields no expansions)."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.llm import MockProvider
from persona_twin.llm.registry import ModelRegistry
from persona_twin.llm.router import LLMRouter
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import ingest_corpus
from persona_twin.retrieval.rewrite import multi_query_candidates, rewrite_query


def _router() -> LLMRouter:
    return LLMRouter(ModelRegistry([]), {"mock": MockProvider()})


async def test_rewrite_query_offline_degrades_to_original():
    qs = await rewrite_query("What tomato variety this year?", _router())
    assert qs == ["What tomato variety this year?"]  # mock yields no expansions


@pytest.fixture
async def state():
    st = build_state(Settings(_env_file=None))
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    return st


async def test_single_query_matches_plain_search(state):
    q = "Black Krim tomato"
    fused = await multi_query_candidates(
        [q], embedder=state.embedder, store=state.store,
        persona_id="ada-quill", bm25=None,
    )
    direct = await state.store.search(
        await state.embedder.embed_query(q), k=25, persona_id="ada-quill"
    )
    assert [c.chunk.chunk_id for c in fused] == [c.chunk.chunk_id for c in direct]


async def test_multi_query_fuses_and_is_persona_scoped(state):
    cands = await multi_query_candidates(
        ["tomato variety", "garden notebook"], embedder=state.embedder,
        store=state.store, persona_id="ada-quill", bm25=state.bm25,
    )
    assert cands
    assert all(c.chunk.persona_id == "ada-quill" for c in cands)


async def test_ask_twin_rewrite_path_grounded_with_timings(state):
    r = await ask_twin(
        state.personas["ada-quill"],
        "What tomato variety are you growing this year?",
        embedder=state.embedder, store=state.store, router=state.router,
        bm25=state.bm25, rewrite=True, debug=True,
    )
    assert r.answered and "Black Krim" in r.answer
    timings = r.debug.stage_timings_ms
    assert "rewrite" in timings and "multi_query_retrieve" in timings
    assert "vector_search" not in timings  # the rewrite branch, not the default


async def test_ask_endpoint_honors_query_rewrite_setting():
    app.state.twin = build_state(Settings(_env_file=None, query_rewrite=True))
    st = app.state.twin
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    async with httpx.ASGITransport(app=app) as transport, httpx.AsyncClient(
        transport=transport, base_url="http://test") as c:
        r = await c.post("/ask", json={
            "persona_id": "ada-quill",
            "question": "What tomato variety are you growing this year?",
            "debug": True,
        })
        body = r.json()
        assert body["answered"] is True
        assert "rewrite" in body["debug"]["stage_timings_ms"]
