"""Conversational twins: streamed prose grounded in retrieval, with a
validated citation tail and per-session memory.

The chat path reuses the stateless ``/ask`` retrieval pipeline (vector +
hybrid + rerank) but **streams** the answer token-by-token, then runs one
small structured pass to attach citations validated against what was
actually retrieved — so, exactly as in ``/ask``, a cited id that wasn't in
the context is dropped and can never reach the client.

Conversation memory is in-process (``ChatSessionStore``): fine for the
single-replica demo, lost on restart, not shared across replicas.
Retrieval uses the latest user message only — no history-aware query
rewriting yet (a roadmap item).
"""

from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from persona_twin.embedding.base import Embedder
from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter
from persona_twin.log import get_logger, kv
from persona_twin.models import Citation, Persona, RoutingDecision, ScoredChunk
from persona_twin.persona.prompting import (
    build_chat_system_prompt,
    build_chat_user_prompt,
    build_user_prompt,
)
from persona_twin.persona.twin import N_CANDIDATES, _to_citation
from persona_twin.reranking.lexical import LexicalReranker
from persona_twin.retrieval.bm25 import BM25Index
from persona_twin.retrieval.fusion import reciprocal_rank_fusion
from persona_twin.retrieval.rewrite import condense_query
from persona_twin.vectorstore.base import VectorStore

logger = get_logger("persona.chat")

MAX_TURNS = 20  # per session; older turns are dropped
MAX_SESSIONS = 500  # LRU cap across sessions
HISTORY_TURNS = 6  # prior turns fed back into the prompt


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class _ChatCitations(BaseModel):
    """Structured citation tail: which retrieved chunks support the answer."""

    answered: bool
    citations: list[str]


@dataclass
class TokenEvent:
    """A prose delta as the answer streams."""

    text: str


@dataclass
class CitationsEvent:
    """Validated citation tail, emitted once the prose is complete."""

    answered: bool
    citations: list[Citation]


@dataclass
class DoneEvent:
    """Terminal event carrying the routing decision for the prose generation."""

    routing: RoutingDecision


ChatEvent = TokenEvent | CitationsEvent | DoneEvent

# Provider attribution for the browser→host bridge: the local model ran in the
# user's browser against their own Ollama, not server-side. We still record a
# routing decision so the console reads honestly.
BROWSER_HOST_PROVIDER = "ollama (browser→host)"


@dataclass
class ChatPrepared:
    """Everything the browser needs to run the local tier itself.

    The cloud server can't reach a user's ``localhost:11434`` — only the
    browser can. So for the local tier the browser asks the server to
    *prepare*: the server runs retrieval and builds the exact SYSTEM + user
    prompt ``chat_twin`` would send the model (NO provider call), and the
    browser runs that on the host's Ollama, then POSTs the completion back to
    ``/chat`` as ``client_completion``. The reranked chunks ride along so the
    server-side citation tail still validates against the real retrieved set."""

    system: str
    user: str
    reranked: list[ScoredChunk]

    def to_payload(self) -> dict:
        # The chunk ids are what the citation tail validates against; the
        # browser doesn't need them, but echoing the retrieved set keeps the
        # prepare response self-describing (and useful in the console).
        return {
            "system": self.system,
            "user": self.user,
            "chunk_ids": [sc.chunk.chunk_id for sc in self.reranked],
        }


class ChatSessionStore:
    """In-process conversation memory: ``session_id`` → turns, LRU-capped.

    Per-session history is trimmed to the last ``max_turns``; the least
    recently used sessions are evicted past ``max_sessions``."""

    def __init__(
        self, max_sessions: int = MAX_SESSIONS, max_turns: int = MAX_TURNS
    ) -> None:
        self._sessions: OrderedDict[str, list[ChatTurn]] = OrderedDict()
        self.max_sessions = max_sessions
        self.max_turns = max_turns

    def history(self, session_id: str) -> list[ChatTurn]:
        return list(self._sessions.get(session_id, []))

    def append(self, session_id: str, turn: ChatTurn) -> None:
        turns = self._sessions.setdefault(session_id, [])
        turns.append(turn)
        if len(turns) > self.max_turns:
            del turns[: len(turns) - self.max_turns]
        self._sessions.move_to_end(session_id)
        while len(self._sessions) > self.max_sessions:
            self._sessions.popitem(last=False)


def _history_pairs(persona: Persona, turns: list[ChatTurn]) -> list[tuple[str, str]]:
    """Recent turns as ``(speaker, text)`` pairs for the prompt."""
    speaker = {"user": "User", "assistant": persona.name}
    return [(speaker[t.role], t.content) for t in turns[-HISTORY_TURNS:]]


async def _retrieve_and_build(
    persona: Persona,
    message: str,
    history: list[ChatTurn],
    *,
    embedder: Embedder,
    store: VectorStore,
    router: LLMRouter,
    reranker: LexicalReranker,
    bm25: BM25Index | None,
    k: int,
    condense: bool,
) -> tuple[list[ScoredChunk], LLMRequest]:
    """Retrieve (vector + hybrid + rerank) and build the prose ``LLMRequest``.

    Shared by the streamed server-side path and the browser→host ``prepare``
    step so both run the *identical* retrieval and prompt — only who calls the
    model differs."""
    pairs = _history_pairs(persona, history)

    retrieval_query = message
    if condense and history:
        retrieval_query = await condense_query(pairs, message, router)

    query_vector = await embedder.embed_query(retrieval_query)
    candidates = await store.search(
        query_vector, k=N_CANDIDATES, persona_id=persona.persona_id
    )
    if bm25 is not None and len(bm25):
        keyword = bm25.search(
            retrieval_query, k=N_CANDIDATES, persona_id=persona.persona_id
        )
        candidates = reciprocal_rank_fusion([candidates, keyword], k=N_CANDIDATES)
    reranked = reranker.rerank(retrieval_query, candidates)[:k]

    request = LLMRequest(
        system=build_chat_system_prompt(persona),
        user=build_chat_user_prompt(pairs, message, reranked),
        max_tokens=1024,
    )
    return reranked, request


async def prepare_chat(
    persona: Persona,
    message: str,
    history: list[ChatTurn],
    *,
    embedder: Embedder,
    store: VectorStore,
    router: LLMRouter,
    reranker: LexicalReranker | None = None,
    bm25: BM25Index | None = None,
    k: int = 5,
    condense: bool = False,
) -> ChatPrepared:
    """Browser→host step 1: run retrieval + build the prompt, NO model call.

    Returns the exact SYSTEM + user prompt ``chat_twin`` would send, plus the
    reranked chunks (so the later citation tail validates against the same
    retrieved set). The browser runs this prompt on the host's Ollama and posts
    the completion back to ``/chat`` as ``client_completion``."""
    reranker = reranker or LexicalReranker()
    reranked, request = await _retrieve_and_build(
        persona, message, history,
        embedder=embedder, store=store, router=router, reranker=reranker,
        bm25=bm25, k=k, condense=condense,
    )
    return ChatPrepared(system=request.system, user=request.user, reranked=reranked)


def _browser_host_decision(model: str | None) -> RoutingDecision:
    """A routing record for an answer that ran in the browser against the
    user's host Ollama. Honest attribution — no server-side provider touched
    this completion, and there's no measured cost/latency to report."""
    return RoutingDecision(
        provider=BROWSER_HOST_PROVIDER,
        model=model or "ollama",
        objective="local",
        task="twin_chat",
    )


async def chat_twin(
    persona: Persona,
    message: str,
    history: list[ChatTurn],
    *,
    embedder: Embedder,
    store: VectorStore,
    router: LLMRouter,
    reranker: LexicalReranker | None = None,
    bm25: BM25Index | None = None,
    k: int = 5,
    condense: bool = False,
    client_completion: str | None = None,
    client_model: str | None = None,
) -> AsyncIterator[ChatEvent]:
    """Stream a grounded conversational answer, then a validated citation tail.

    Yields ``TokenEvent`` deltas while generating, then one ``CitationsEvent``
    and one ``DoneEvent``. Retrieval mirrors ``ask_twin``; the citation tail
    is a separate structured call so the visible prose stays clean.

    With ``condense`` and prior turns, the follow-up message is first folded
    into a standalone retrieval query (resolving "them"/"it") so retrieval is
    history-aware, not just the latest message. Generation always sees the
    full history regardless.

    Browser→host bridge: when ``client_completion`` is supplied, the prose was
    already generated by the user's own Ollama in the browser (against the
    prompt from ``prepare_chat``), so the server skips its provider call and
    uses that text as the answer — emitting it as one ``TokenEvent`` — while
    still running the citation tail server-side. Routing is recorded as the
    browser→host provider."""
    reranker = reranker or LexicalReranker()
    reranked, prose_request = await _retrieve_and_build(
        persona, message, history,
        embedder=embedder, store=store, router=router, reranker=reranker,
        bm25=bm25, k=k, condense=condense,
    )

    decision: RoutingDecision | None = None
    if client_completion is not None:
        # Browser→host: the host Ollama already produced the prose. Surface it
        # whole (one delta) instead of streaming from a server-side provider.
        answer = client_completion
        decision = _browser_host_decision(client_model)
        if answer:
            yield TokenEvent(text=answer)
    else:
        parts: list[str] = []
        async for event in router.stream_complete(prose_request, task="twin_chat"):
            if event.done:
                decision = event.decision
            elif event.delta:
                parts.append(event.delta)
                yield TokenEvent(text=event.delta)
        answer = "".join(parts)

    answered, citations = await _citation_tail(router, message, answer, reranked)
    yield CitationsEvent(answered=answered, citations=citations)
    if decision is not None:
        yield DoneEvent(routing=decision)

    logger.info(
        "chat %s",
        kv(
            persona=persona.persona_id,
            answered=answered,
            citations=len(citations),
            provider=decision.provider if decision else "none",
            bridge="browser-host" if client_completion is not None else "server",
        ),
    )


async def _citation_tail(router, message, answer, reranked):
    """Structured pass: which retrieved chunks support the streamed answer.
    Cited ids are validated against the retrieved set (hallucinated ids are
    dropped). A provider failure degrades to an uncited answer."""
    retrieved_by_id = {sc.chunk.chunk_id: sc for sc in reranked}
    cite_request = LLMRequest(
        system="You identify which retrieved sources support an answer.",
        user=build_user_prompt(message, reranked)
        + f"\n\nAnswer given: {answer}\n\nReturn answered=true with the chunk "
        "ids that support this answer, or answered=false with an empty list if "
        "the context does not support it.",
        max_tokens=256,
    )
    try:
        parsed, _resp, _dec = await router.complete_structured(
            cite_request, _ChatCitations, task="twin_chat"
        )
    except AllProvidersFailedError:
        return False, []
    if not parsed.answered:
        return False, []
    valid = [cid for cid in parsed.citations if cid in retrieved_by_id]
    return True, [_to_citation(retrieved_by_id[cid]) for cid in valid]
