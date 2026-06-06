"""LLM reranker — routes through the ``rerank`` task policy.

Asks a model to order the candidates by relevance (structured output:
a list of candidate indices). Defensive by design: indices the model
omits keep their original relative order behind the ranked ones, and
any routing/validation failure falls back to the input order — a
broken reranker must never be worse than no reranker.
"""

from pydantic import BaseModel

from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter
from persona_twin.log import get_logger, kv
from persona_twin.models import ScoredChunk

logger = get_logger("reranking.llm")

RERANK_SYSTEM = """You are a retrieval reranker. Given a QUESTION and numbered
CANDIDATE passages, return the candidate indices ordered from most to least
relevant to answering the question. Judge relevance to the question only."""


class Ranking(BaseModel):
    ranking: list[int]


class LLMReranker:
    name = "llm"

    def __init__(self, router: LLMRouter) -> None:
        self._router = router

    async def rerank(
        self, question: str, candidates: list[ScoredChunk]
    ) -> list[ScoredChunk]:
        if len(candidates) < 2:
            return list(candidates)
        numbered = "\n".join(
            f"[{i}] {' '.join(sc.chunk.text.split())}" for i, sc in enumerate(candidates)
        )
        request = LLMRequest(
            system=RERANK_SYSTEM,
            user=f"QUESTION: {question}\n\nCANDIDATES:\n{numbered}",
            max_tokens=256,
        )
        try:
            parsed, _, _ = await self._router.complete_structured(
                request, Ranking, task="rerank"
            )
        except AllProvidersFailedError:
            logger.warning("llm rerank failed %s", kv(fallback="original order"))
            return list(candidates)

        seen: list[int] = []
        for idx in parsed.ranking:
            if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
                seen.append(idx)
        order = seen + [i for i in range(len(candidates)) if i not in seen]
        return [
            candidates[i].model_copy(
                update={"rerank_score": float(len(order) - rank), "pre_rerank_rank": i}
            )
            for rank, i in enumerate(order)
        ]
