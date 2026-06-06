"""Lexical reranker: repairs term-presence misordering, keeps provenance."""

from persona_twin.models import Chunk, ScoredChunk
from persona_twin.reranking import LexicalReranker


def sc(i: int, text: str, score: float) -> ScoredChunk:
    return ScoredChunk(
        chunk=Chunk(
            chunk_id=f"d:fixed:{i:04d}",
            doc_id="d",
            persona_id="p",
            text=text,
            strategy="fixed",
            char_span=(0, len(text)),
        ),
        score=score,
    )


CANDIDATES = [
    # topically adjacent, high vector score, no answer
    sc(0, "The garden was lovely in spring, full of flowers and bees.", 0.95),
    # contains the literal answer terms, lower vector score
    sc(1, "The tomato variety this year is Black Krim, started from seedlings.", 0.80),
    sc(2, "I prefer coffee from the roasters on Pelican Lane.", 0.75),
]


def test_term_bearing_chunk_moves_to_top():
    reranked = LexicalReranker().rerank("What tomato variety is she growing?", CANDIDATES)
    assert reranked[0].chunk.chunk_id == "d:fixed:0001"
    assert reranked[0].pre_rerank_rank == 1  # was second before rerank


def test_rerank_metadata_present_and_sorted():
    reranked = LexicalReranker().rerank("tomato variety", CANDIDATES)
    scores = [r.rerank_score for r in reranked]
    assert scores == sorted(scores, reverse=True)
    assert {r.pre_rerank_rank for r in reranked} == {0, 1, 2}


def test_deterministic():
    r1 = LexicalReranker().rerank("tomato", CANDIDATES)
    r2 = LexicalReranker().rerank("tomato", CANDIDATES)
    assert [c.chunk.chunk_id for c in r1] == [c.chunk.chunk_id for c in r2]


def test_empty_candidates():
    assert LexicalReranker().rerank("anything", []) == []
