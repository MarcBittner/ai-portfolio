"""Eval harness runner: ``make eval`` → eval-report.md.

Three metric layers, reported separately:

1. retrieval   — hit-rate@k, MRR per chunking strategy, ± rerank
2. grounding   — citation precision, claim support, refusal behavior
3. quality     — token F1 / fact presence vs reference, voice violations

No composite score is computed, deliberately — see docs/evaluation.md.
"""

import asyncio
from pathlib import Path

from pydantic import BaseModel

from persona_twin.api.app import build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.corpus import load_personas
from persona_twin.eval.dataset import EvalItem, load_eval_dataset
from persona_twin.eval.judge import judge_support
from persona_twin.eval.metrics import (
    contains_reference,
    token_f1,
    voice_violations,
)
from persona_twin.log import configure
from persona_twin.models import AskResponse, ChunkStrategy
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import ingest_corpus
from persona_twin.reranking import LexicalReranker
from persona_twin.vectorstore import MemoryVectorStore

K = 5
N_CANDIDATES = 25
STRATEGIES: list[ChunkStrategy] = ["fixed", "semantic", "content_aware"]
REPORT_PATH = Path(__file__).resolve().parents[3] / "eval-report.md"


class RetrievalRow(BaseModel):
    strategy: str
    reranked: bool
    hit_rate: float
    mrr: float
    n: int


class GroundingReport(BaseModel):
    citation_precision: float
    support_rate: float
    support_method: str
    refusal_recall: float  # unanswerable → refused
    false_refusal_rate: float  # answerable → wrongly refused
    n_answerable: int
    n_unanswerable: int


class QualityReport(BaseModel):
    mean_token_f1: float
    fact_presence_rate: float
    voice_violation_rate: float
    n: int


async def evaluate_retrieval(
    items: list[EvalItem], embedder, records, strategy: ChunkStrategy, reranked: bool
) -> RetrievalRow:
    store = MemoryVectorStore(dimensions=embedder.dimensions)
    await ingest_corpus(get_chunker(strategy), embedder, store, records=records)
    reranker = LexicalReranker()

    answerable = [i for i in items if i.answerable]
    hits, rr_sum = 0, 0.0
    for item in answerable:
        qv = await embedder.embed_query(item.question)
        results = await store.search(qv, k=N_CANDIDATES, persona_id=item.persona_id)
        if reranked:
            results = reranker.rerank(item.question, results)
        results = results[:K]
        rank = next(
            (
                i + 1
                for i, sc in enumerate(results)
                if sc.chunk.doc_id in item.source_docs
            ),
            None,
        )
        if rank is not None:
            hits += 1
            rr_sum += 1.0 / rank
    n = len(answerable)
    return RetrievalRow(
        strategy=strategy,
        reranked=reranked,
        hit_rate=round(hits / n, 3),
        mrr=round(rr_sum / n, 3),
        n=n,
    )


async def evaluate_answers(
    items: list[EvalItem], state
) -> tuple[GroundingReport, QualityReport, list[tuple[EvalItem, AskResponse]]]:
    responses: list[tuple[EvalItem, AskResponse]] = []
    for item in items:
        response = await ask_twin(
            state.personas[item.persona_id],
            item.question,
            embedder=state.embedder,
            store=state.store,
            router=state.router,
            k=K,
            debug=True,
        )
        responses.append((item, response))

    answerable = [(i, r) for i, r in responses if i.answerable]
    unanswerable = [(i, r) for i, r in responses if not i.answerable]

    # --- grounding ---
    cited_total, cited_correct = 0, 0
    supported, support_method = 0, "lexical-heuristic"
    answered = [(i, r) for i, r in answerable if r.answered]
    for item, r in answered:
        for c in r.citations:
            cited_total += 1
            if c.doc_id in item.source_docs:
                cited_correct += 1
        cited_texts = [
            sc.chunk.text
            for sc in (r.debug.retrieved if r.debug else [])
            if sc.chunk.chunk_id in {c.chunk_id for c in r.citations}
        ]
        ok, support_method = await judge_support(r.answer, cited_texts, state.router)
        supported += ok

    grounding = GroundingReport(
        citation_precision=round(cited_correct / cited_total, 3) if cited_total else 0.0,
        support_rate=round(supported / len(answered), 3) if answered else 0.0,
        support_method=support_method,
        refusal_recall=round(
            sum(1 for _, r in unanswerable if not r.answered) / len(unanswerable), 3
        )
        if unanswerable
        else 0.0,
        false_refusal_rate=round(
            sum(1 for _, r in answerable if not r.answered) / len(answerable), 3
        )
        if answerable
        else 0.0,
        n_answerable=len(answerable),
        n_unanswerable=len(unanswerable),
    )

    # --- quality (scored over answered answerable items) ---
    f1s = [token_f1(r.answer, i.reference) for i, r in answered]
    facts = [contains_reference(r.answer, i.reference) for i, r in answered]
    violations = [bool(voice_violations(r.answer)) for i, r in answered]
    quality = QualityReport(
        mean_token_f1=round(sum(f1s) / len(f1s), 3) if f1s else 0.0,
        fact_presence_rate=round(sum(facts) / len(facts), 3) if facts else 0.0,
        voice_violation_rate=round(sum(violations) / len(violations), 3)
        if violations
        else 0.0,
        n=len(answered),
    )
    return grounding, quality, responses


def render_report(
    retrieval: list[RetrievalRow],
    grounding: GroundingReport,
    quality: QualityReport,
    backends: str,
) -> str:
    lines = [
        "# persona-twin eval report",
        "",
        f"_Backends: {backends}_",
        "",
        "Three layers, three tables. **No composite score** — see "
        "[docs/evaluation.md](docs/evaluation.md) for why.",
        "",
        "## 1. Retrieval",
        "",
        f"| strategy | rerank | hit-rate@{K} | MRR | n |",
        "|---|---|---|---|---|",
    ]
    for row in retrieval:
        lines.append(
            f"| {row.strategy} | {'yes' if row.reranked else 'no'} "
            f"| {row.hit_rate:.3f} | {row.mrr:.3f} | {row.n} |"
        )
    lines += [
        "",
        "## 2. Grounding / faithfulness",
        "",
        "| metric | value |",
        "|---|---|",
        f"| citation precision | {grounding.citation_precision:.3f} |",
        f"| claim support rate ({grounding.support_method}) | {grounding.support_rate:.3f} |",
        f"| refusal recall (unanswerable → refused) | {grounding.refusal_recall:.3f} |",
        f"| false refusal rate (answerable → refused) | {grounding.false_refusal_rate:.3f} |",
        "",
        f"n = {grounding.n_answerable} answerable + "
        f"{grounding.n_unanswerable} unanswerable",
        "",
        "## 3. Answer quality",
        "",
        "| metric | value |",
        "|---|---|",
        f"| mean token F1 vs reference | {quality.mean_token_f1:.3f} |",
        f"| fact presence rate | {quality.fact_presence_rate:.3f} |",
        f"| voice violation rate | {quality.voice_violation_rate:.3f} |",
        "",
        f"n = {quality.n} answered items",
        "",
    ]
    return "\n".join(lines)


async def main() -> None:
    configure()
    settings = Settings()
    items = load_eval_dataset()
    records = load_personas()
    state = build_state(settings)

    retrieval_rows = [
        await evaluate_retrieval(items, state.embedder, records, strategy, reranked)
        for strategy in STRATEGIES
        for reranked in (False, True)
    ]

    if await state.store.count() == 0:
        await ingest_corpus(
            get_chunker("content_aware"), state.embedder, state.store, records=records
        )
    grounding, quality, _ = await evaluate_answers(items, state)

    backends = (
        f"vector={settings.vector_backend}, embeddings={settings.embedding_backend}, "
        f"llm={settings.llm_backends}"
    )
    report = render_report(retrieval_rows, grounding, quality, backends)
    REPORT_PATH.write_text(report)
    print(report)
    print(f"\nreport written to {REPORT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
