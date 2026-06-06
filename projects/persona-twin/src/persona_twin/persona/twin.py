"""Grounded twin answering: retrieve → rerank → generate with citations.

Citations returned by the model are validated against what was actually
retrieved — a cited id that wasn't in the context is dropped (and the
drop is visible in the debug payload), so hallucinated citations cannot
reach the client.
"""

import time

from pydantic import BaseModel

from persona_twin.embedding.base import Embedder
from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import LLMRouter
from persona_twin.log import get_logger, kv
from persona_twin.models import (
    AskResponse,
    Citation,
    DebugInfo,
    Persona,
    ScoredChunk,
)
from persona_twin.persona.prompting import build_system_prompt, build_user_prompt
from persona_twin.reranking.lexical import LexicalReranker
from persona_twin.vectorstore.base import VectorStore

logger = get_logger("persona.twin")

N_CANDIDATES = 25
EXCERPT_CHARS = 160


class TwinAnswer(BaseModel):
    """Structured output contract for twin generation."""

    answer: str
    answered: bool
    citations: list[str]  # chunk ids used


async def ask_twin(
    persona: Persona,
    question: str,
    *,
    embedder: Embedder,
    store: VectorStore,
    router: LLMRouter,
    reranker: LexicalReranker | None = None,
    k: int = 5,
    debug: bool = False,
) -> AskResponse:
    reranker = reranker or LexicalReranker()
    timings: dict[str, float] = {}

    t0 = time.perf_counter()
    query_vector = await embedder.embed_query(question)
    timings["embed_query"] = _ms_since(t0)

    t0 = time.perf_counter()
    candidates = await store.search(
        query_vector, k=N_CANDIDATES, persona_id=persona.persona_id
    )
    timings["vector_search"] = _ms_since(t0)

    t0 = time.perf_counter()
    reranked = reranker.rerank(question, candidates)[:k]
    timings["rerank"] = _ms_since(t0)

    request = LLMRequest(
        system=build_system_prompt(persona),
        user=build_user_prompt(question, reranked),
        max_tokens=1024,
    )
    t0 = time.perf_counter()
    parsed, _response, decision = await router.complete_structured(request, TwinAnswer)
    timings["generate"] = _ms_since(t0)

    retrieved_by_id = {sc.chunk.chunk_id: sc for sc in reranked}
    valid_ids = [cid for cid in parsed.citations if cid in retrieved_by_id]
    dropped = len(parsed.citations) - len(valid_ids)
    if dropped:
        logger.warning(
            "dropped citations not in retrieved context %s",
            kv(persona=persona.persona_id, dropped=dropped),
        )
    citations = [_to_citation(retrieved_by_id[cid]) for cid in valid_ids]
    if not parsed.answered:
        citations = []

    logger.info(
        "ask %s",
        kv(
            persona=persona.persona_id,
            answered=parsed.answered,
            citations=len(citations),
            provider=decision.provider,
            model=decision.model,
        ),
    )
    return AskResponse(
        persona_id=persona.persona_id,
        question=question,
        answer=parsed.answer,
        answered=parsed.answered,
        citations=citations,
        debug=DebugInfo(routing=decision, retrieved=reranked, stage_timings_ms=timings)
        if debug
        else None,
    )


def _to_citation(sc: ScoredChunk) -> Citation:
    text = " ".join(sc.chunk.text.split())
    excerpt = text[:EXCERPT_CHARS] + ("…" if len(text) > EXCERPT_CHARS else "")
    return Citation(
        doc_id=sc.chunk.doc_id,
        chunk_id=sc.chunk.chunk_id,
        score=sc.rerank_score if sc.rerank_score is not None else sc.score,
        excerpt=excerpt,
    )


def _ms_since(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 2)
