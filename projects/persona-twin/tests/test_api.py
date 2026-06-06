"""Integration tests: the full offline stack through the FastAPI app."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.config import Settings


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    async with httpx.ASGITransport(app=app) as transport:
        # lifespan isn't run by ASGITransport; ingest explicitly
        from persona_twin.chunking import get_chunker
        from persona_twin.pipeline import ingest_corpus

        state = app.state.twin
        await ingest_corpus(
            get_chunker("content_aware"), state.embedder, state.store,
            records=state.records,
        )
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield client


async def test_health_reports_offline_backends(client):
    body = (await client.get("/health")).json()
    assert body["status"] == "ok"
    assert body["vector_backend"] == "memory"
    assert body["embedding_backend"] == "hash"
    assert body["llm_backends"] == ["mock"]
    assert body["chunks_indexed"] > 0
    assert body["personas"] == 4
    # no secret-bearing fields ever appear in /health
    assert "key" not in str(body).lower()
    assert "uri" not in str(body).lower()


async def test_personas_listing(client):
    personas = (await client.get("/personas")).json()
    ids = {p["persona_id"] for p in personas}
    assert ids == {"ada-quill", "buck-ramirez", "gus-okafor", "mei-tanaka"}

    detail = (await client.get("/personas/ada-quill")).json()
    assert detail["name"] == "Ada Quill"
    assert detail["doc_count"] >= 6

    assert (await client.get("/personas/nobody")).status_code == 404


async def test_ask_returns_grounded_cited_answer(client):
    response = await client.post(
        "/ask",
        json={
            "persona_id": "ada-quill",
            "question": "What tomato variety are you growing this year?",
            "debug": True,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["answered"] is True
    assert "Black Krim" in body["answer"]
    assert body["citations"], "grounded answers must cite"
    assert all(c["chunk_id"].startswith("ada-quill/") for c in body["citations"])
    debug = body["debug"]
    assert debug["routing"]["provider"] == "mock"
    assert set(debug["stage_timings_ms"]) == {
        "embed_query", "vector_search", "rerank", "generate",
    }


async def test_ask_refuses_unanswerable(client):
    response = await client.post(
        "/ask",
        json={
            "persona_id": "gus-okafor",
            "question": "Which cryptocurrency exchange do you recommend?",
        },
    )
    body = response.json()
    assert body["answered"] is False
    assert body["citations"] == []


async def test_ask_unknown_persona_404(client):
    response = await client.post(
        "/ask", json={"persona_id": "nobody", "question": "hello?"}
    )
    assert response.status_code == 404


async def test_ask_retrieval_is_persona_scoped(client):
    response = await client.post(
        "/ask",
        json={
            "persona_id": "mei-tanaka",
            "question": "What engine did you switch to from Unity?",
            "debug": True,
        },
    )
    body = response.json()
    retrieved = body["debug"]["retrieved"]
    assert retrieved
    assert all(r["chunk"]["persona_id"] == "mei-tanaka" for r in retrieved)
    assert body["answered"] is True
    assert "Godot" in body["answer"]


async def test_ingest_endpoint_rebuilds_with_strategy(client):
    response = await client.post("/ingest", json={"strategy": "semantic"})
    assert response.status_code == 200
    report = response.json()
    assert report["strategy"] == "semantic"
    assert report["chunks"] > 0
    health = (await client.get("/health")).json()
    assert health["chunks_indexed"] == report["chunks"]
