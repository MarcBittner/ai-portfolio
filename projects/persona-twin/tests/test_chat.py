"""Conversational twins: provider/router streaming, chat_twin grounding,
session memory, and the /chat SSE endpoint — all offline."""

import json

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.llm import LLMRequest, MockProvider, ModelSpec, get_router
from persona_twin.persona.chat import (
    ChatSessionStore,
    ChatTurn,
    CitationsEvent,
    DoneEvent,
    TokenEvent,
    chat_twin,
)
from persona_twin.pipeline import ingest_corpus

SPEC = ModelSpec(provider="mock", id="mock-1", input_per_mtok=0, output_per_mtok=0,
                 quality=1, speed=1)


def _req(user: str) -> LLMRequest:
    return LLMRequest(system="s", user=user)


# ---- provider + router streaming ----

async def test_mock_stream_accumulates_to_plain_answer():
    provider = MockProvider()
    user = "Context:\n[c1] Black Krim tomatoes grow well here.\n\nQuestion: tomatoes?"
    deltas = [d async for d in provider.stream(_req(user), SPEC)]
    streamed = "".join(deltas)
    full = (await provider.complete(_req(user), SPEC)).text  # no schema -> prose
    assert len(deltas) > 1  # genuinely chunked, not one blob
    assert streamed == full


async def test_router_stream_complete_emits_terminal_decision():
    router = get_router(Settings(_env_file=None))
    user = "Context:\n[c1] Black Krim tomatoes grow well here.\n\nQuestion: tomatoes?"
    events = [e async for e in router.stream_complete(_req(user), task="twin_chat")]
    assert any(e.delta for e in events)
    terminal = events[-1]
    assert terminal.done
    assert terminal.decision.provider == "mock"
    assert terminal.decision.task == "twin_chat"
    assert terminal.response.text == "".join(e.delta for e in events if not e.done)


async def test_router_stream_falls_back_for_nonstreaming_provider():
    """A provider without stream() degrades to a single complete() delta."""

    class NoStream:
        name = "mock"

        async def complete(self, request, spec):
            from persona_twin.llm import LLMResponse, LLMUsage

            return LLMResponse(text="hello world", provider="mock", model=spec.id,
                               usage=LLMUsage(input_tokens=1, output_tokens=2),
                               latency_ms=1.0, cost_usd=0.0)

    from persona_twin.llm import LLMRouter, ModelRegistry

    router = LLMRouter(ModelRegistry([SPEC]), {"mock": NoStream()})
    events = [e async for e in router.stream_complete(_req("x"), task="twin_chat")]
    deltas = [e.delta for e in events if not e.done]
    assert deltas == ["hello world"]
    assert events[-1].response.text == "hello world"


# ---- session store ----

def test_session_store_trims_and_evicts():
    store = ChatSessionStore(max_sessions=2, max_turns=3)
    for i in range(5):
        store.append("a", ChatTurn(role="user", content=str(i)))
    assert [t.content for t in store.history("a")] == ["2", "3", "4"]  # last 3 kept

    store.append("b", ChatTurn(role="user", content="b"))
    store.append("c", ChatTurn(role="user", content="c"))  # evicts LRU "a"
    assert store.history("a") == []
    assert store.history("c")


# ---- chat_twin grounding (offline) ----

@pytest.fixture
async def state():
    st = build_state(Settings(_env_file=None))
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    return st


async def _collect(gen):
    tokens, cites, done = [], None, None
    async for ev in gen:
        if isinstance(ev, TokenEvent):
            tokens.append(ev.text)
        elif isinstance(ev, CitationsEvent):
            cites = ev
        elif isinstance(ev, DoneEvent):
            done = ev
    return "".join(tokens), cites, done


async def test_chat_twin_streams_grounded_cited_answer(state):
    persona = state.personas["ada-quill"]
    answer, cites, done = await _collect(chat_twin(
        persona, "What tomato variety are you growing this year?", [],
        embedder=state.embedder, store=state.store, router=state.router,
        bm25=state.bm25))
    assert "Black Krim" in answer
    assert cites.answered is True
    assert cites.citations and all(
        c.chunk_id.startswith("ada-quill/") for c in cites.citations)
    assert done.routing.provider == "mock"
    assert done.routing.task == "twin_chat"


async def test_chat_twin_refuses_unanswerable(state):
    persona = state.personas["gus-okafor"]
    answer, cites, _ = await _collect(chat_twin(
        persona, "Which cryptocurrency exchange do you recommend?", [],
        embedder=state.embedder, store=state.store, router=state.router,
        bm25=state.bm25))
    assert cites.answered is False
    assert cites.citations == []


# ---- /chat SSE endpoint ----

def _parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        if not block.strip():
            continue
        name = data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if name:
            events.append((name, data))
    return events


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


async def test_chat_endpoint_streams_events_and_remembers(client):
    r = await client.post("/chat", json={
        "persona_id": "ada-quill",
        "question": "ignored",  # extra fields ignored by pydantic
        "message": "What tomato variety are you growing this year?",
    })
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(r.text)
    names = [n for n, _ in events]
    assert names[0] == "meta"
    assert "token" in names and "citations" in names and names[-1] == "done"

    session_id = events[0][1]["session_id"]
    answer = "".join(d["text"] for n, d in events if n == "token")
    assert "Black Krim" in answer
    citations = next(d for n, d in events if n == "citations")
    assert citations["answered"] is True and citations["citations"]

    # second turn reuses the session — memory persists both turns
    r2 = await client.post("/chat", json={
        "persona_id": "ada-quill", "session_id": session_id,
        "message": "And what do you write with?"})
    assert r2.status_code == 200
    history = app.state.twin.sessions.history(session_id)
    assert [t.role for t in history] == ["user", "assistant", "user", "assistant"]


async def test_chat_endpoint_unknown_persona_404(client):
    r = await client.post("/chat", json={"persona_id": "nobody", "message": "hi"})
    assert r.status_code == 404
