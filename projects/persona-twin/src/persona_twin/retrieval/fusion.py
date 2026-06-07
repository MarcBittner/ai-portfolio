"""Reciprocal-rank fusion of retrieval result lists.

RRF is rank-based, so it fuses score spaces that aren't comparable
(cosine similarity vs BM25) without normalization gymnastics:
``score(d) = Σ 1 / (RRF_K + rank_i(d))``. The fused score replaces the
per-retriever scores; provenance survives on the chunks themselves.
"""

from persona_twin.models import ScoredChunk

RRF_K = 60


def reciprocal_rank_fusion(
    result_lists: list[list[ScoredChunk]], k: int = 25
) -> list[ScoredChunk]:
    scores: dict[str, float] = {}
    chunks: dict[str, ScoredChunk] = {}
    for results in result_lists:
        for rank, sc in enumerate(results):
            cid = sc.chunk.chunk_id
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            chunks.setdefault(cid, sc)
    ordered = sorted(scores.items(), key=lambda t: -t[1])
    return [
        chunks[cid].model_copy(update={"score": round(score, 6)})
        for cid, score in ordered[:k]
    ]
