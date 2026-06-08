"""Twin-vs-twin: grounded cited transcript, offline, and the /interview API."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.models import Chunk
from persona_twin.persona.interview import _seed_questions, interview
from persona_twin.pipeline import ingest_corpus


def _chunk(cid: str, text: str) -> Chunk:
    return Chunk(chunk_id=cid, doc_id="d", persona_id="p", text=text,
                 strategy="fixed", char_span=(0, len(text)))


def test_seed_questions_strip_markdown_and_count():
    chunks = [
        _chunk("a:0", "# Devlog: Attic Light taught me a lot about scope."),
        _chunk("a:1", "**Foghouse** at a festival was a postmortem in disguise."),
        _chunk("a:2", "Questions other devs send me about going solo."),
    ]
    qs = _seed_questions(chunks, rounds=2)
    assert len(qs) == 2
    assert all(q.startswith("Tell me about ") for q in qs)
    assert "#" not in qs[0] and "*" not in "".join(qs)  # markdown stripped


@pytest.fixture
async def state():
    st = build_state(Settings(_env_file=None))
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    return st


async def test_interview_subject_answers_grounded_and_scoped(state):
    transcript = await interview(
        state.personas["ada-quill"], state.personas["mei-tanaka"],
        embedder=state.embedder, store=state.store, router=state.router,
        bm25=state.bm25, rounds=3,
    )
    assert transcript.interviewer_id == "ada-quill"
    assert transcript.subject_id == "mei-tanaka"
    assert len(transcript.rounds) == 3
    grounded = [r for r in transcript.rounds if r.answered]
    assert grounded, "the subject should answer at least some seeded questions"
    for r in grounded:
        assert r.citations
        assert all(c.chunk_id.startswith("mei-tanaka/") for c in r.citations)


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    st = app.state.twin
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    async with httpx.ASGITransport(app=app) as transport, httpx.AsyncClient(
        transport=transport, base_url="http://test") as c:
        yield c


async def test_interview_endpoint(client):
    r = await client.post("/interview", json={
        "interviewer_id": "buck-ramirez", "subject_id": "ada-quill", "rounds": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["subject_id"] == "ada-quill"
    assert len(body["rounds"]) == 2
    assert all(
        c["chunk_id"].startswith("ada-quill/")
        for round in body["rounds"] for c in round["citations"]
    )


async def test_interview_same_twin_422(client):
    r = await client.post("/interview", json={
        "interviewer_id": "ada-quill", "subject_id": "ada-quill"})
    assert r.status_code == 422


async def test_interview_unknown_persona_404(client):
    r = await client.post("/interview", json={
        "interviewer_id": "nobody", "subject_id": "ada-quill"})
    assert r.status_code == 404
