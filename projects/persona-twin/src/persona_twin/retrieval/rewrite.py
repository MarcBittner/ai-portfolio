"""Query rewriting / multi-query expansion as a routed task.

Before retrieval, an LLM expands the question into a few alternative
phrasings and sub-queries (``task=query_rewrite``); each is retrieved
independently and the candidate lists are fused with reciprocal-rank
fusion, widening recall before reranking. The original question is always
included, so the path degrades gracefully to single-query retrieval when
no real provider is configured (the mock returns no expansions) or the
rewrite call fails.

It is opt-in (``PERSONA_TWIN_QUERY_REWRITE``) so the stateless ``/ask``
baseline stays stable; the benchmark measures it against that baseline.
"""

from pydantic import BaseModel, Field

from persona_twin.embedding.base import Embedder
from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter
from persona_twin.models import ScoredChunk
from persona_twin.retrieval.bm25 import BM25Index
from persona_twin.retrieval.fusion import reciprocal_rank_fusion

MAX_QUERIES = 4

REWRITE_SYSTEM = """You expand a search query to improve document retrieval.
Given a QUESTION, produce a few short alternative phrasings and sub-queries —
synonyms, key entities, decompositions — that would surface relevant passages.
Do not answer the question; only rephrase and decompose it."""


class QueryRewrite(BaseModel):
    queries: list[str] = Field(default_factory=list)


async def rewrite_query(
    question: str, router: LLMRouter, n: int = MAX_QUERIES
) -> list[str]:
    """The original question plus up to ``n-1`` deduped LLM expansions.
    Degrades to ``[question]`` offline or on provider failure."""
    out = [question]
    seen = {question.lower()}
    try:
        request = LLMRequest(
            system=REWRITE_SYSTEM, user=f"QUESTION: {question}", max_tokens=256
        )
        parsed, _, _ = await router.complete_structured(
            request, QueryRewrite, task="query_rewrite"
        )
    except AllProvidersFailedError:
        return out
    for q in parsed.queries:
        q = q.strip()
        if q and q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)
    return out[:n]


CONDENSE_SYSTEM = """Rewrite the user's latest message into a standalone search
query, resolving pronouns and references ("them", "that", "it") using the prior
conversation. Output only the query text — no answer, no explanation."""


class CondensedQuery(BaseModel):
    query: str = ""


async def condense_query(
    history: list[tuple[str, str]], message: str, router: LLMRouter
) -> str:
    """Fold a follow-up message + prior turns into a standalone retrieval
    query (resolving "them"/"it"/"that"). Degrades to the raw message when
    there is no history, offline (mock returns nothing), or on failure."""
    if not history:
        return message
    convo = "\n".join(f"{speaker}: {text}" for speaker, text in history)
    try:
        request = LLMRequest(
            system=CONDENSE_SYSTEM,
            user=f"Conversation:\n{convo}\n\nLatest message: {message}",
            max_tokens=128,
        )
        parsed, _, _ = await router.complete_structured(
            request, CondensedQuery, task="query_rewrite"
        )
    except AllProvidersFailedError:
        return message
    return parsed.query.strip() or message


async def multi_query_candidates(
    queries: list[str],
    *,
    embedder: Embedder,
    store,
    persona_id: str,
    bm25: BM25Index | None = None,
    k: int = 25,
) -> list[ScoredChunk]:
    """Retrieve each query (vector, and BM25 when enabled) and fuse all
    candidate lists with reciprocal-rank fusion. A single query with no
    BM25 returns its list unchanged (no fusion)."""
    lists: list[list[ScoredChunk]] = []
    for q in queries:
        vector = await embedder.embed_query(q)
        lists.append(await store.search(vector, k=k, persona_id=persona_id))
        if bm25 is not None and len(bm25):
            lists.append(bm25.search(q, k=k, persona_id=persona_id))
    if len(lists) == 1:
        return lists[0]
    return reciprocal_rank_fusion(lists, k=k)
