"""Lexical reranker — the zero-dependency default.

Rescores vector-search candidates by IDF-weighted query-term overlap,
computed over the candidate set itself. Catches the classic dense-
retrieval failure where a topically-adjacent chunk outranks the chunk
that literally contains the asked-about term. Deterministic.
"""

import math
import re

from persona_twin.models import ScoredChunk

_WORD = re.compile(r"[a-z0-9]{2,}")


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


class LexicalReranker:
    name = "lexical"

    def rerank(self, question: str, candidates: list[ScoredChunk]) -> list[ScoredChunk]:
        if not candidates:
            return []
        q_tokens = _tokens(question)
        n = len(candidates)
        # document frequency of each query token across the candidate set
        chunk_tokens = [_tokens(sc.chunk.text) for sc in candidates]
        df = {t: sum(1 for toks in chunk_tokens if t in toks) for t in q_tokens}

        rescored: list[ScoredChunk] = []
        for rank, (sc, toks) in enumerate(zip(candidates, chunk_tokens, strict=True)):
            overlap = q_tokens & toks
            lexical = sum(math.log(1 + n / df[t]) for t in overlap)
            rescored.append(
                sc.model_copy(
                    update={
                        # retrieval score breaks ties between equal overlaps
                        "rerank_score": round(lexical + 0.01 * sc.score, 6),
                        "pre_rerank_rank": rank,
                    }
                )
            )
        rescored.sort(key=lambda s: -s.rerank_score)
        return rescored
