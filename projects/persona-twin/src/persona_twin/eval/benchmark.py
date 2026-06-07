"""Per-model × per-task benchmark harness.

Measures each candidate model at each assignable task over the
committed eval dataset, with **pinned-model isolation**: every
measurement runs through a single-spec router with no fallback chain,
so a failing model records errors instead of silently measuring
whatever it would have failed over to.

Task scorecards:

- ``twin_answer`` — fact presence, token F1, citation precision,
  lexical claim support, false-refusal rate (+ refusal recall when the
  sample includes unanswerables)
- ``rerank``      — hit-rate@5 and MRR, alongside ``baseline:none`` and
  ``baseline:lexical`` rows for honest comparison
- ``eval_judge``  — verdict accuracy over synthesized pairs: the
  reference answer with its gold document (supported) and with a
  different persona's document (unsupported)
"""

import time
from typing import Literal

from pydantic import BaseModel, Field

from persona_twin.corpus import PersonaRecord
from persona_twin.embedding.base import Embedder
from persona_twin.eval.dataset import EvalItem
from persona_twin.eval.judge import JUDGE_SYSTEM, SupportVerdict
from persona_twin.eval.metrics import (
    contains_reference,
    lexical_support,
    token_f1,
)
from persona_twin.llm.base import LLMProvider, LLMRequest, ModelSpec
from persona_twin.llm.registry import ModelRegistry
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter
from persona_twin.log import get_logger, kv
from persona_twin.models import Persona, ScoredChunk
from persona_twin.persona.twin import ask_twin
from persona_twin.reranking import LexicalReranker
from persona_twin.reranking.llm_rerank import LLMReranker
from persona_twin.vectorstore.base import VectorStore

logger = get_logger("eval.benchmark")

BENCH_TASKS = ("twin_answer", "rerank", "eval_judge")
K = 5
N_CANDIDATES = 25


class TaskResult(BaseModel):
    task: str
    provider: str
    model: str
    n: int
    errors: int = 0
    metrics: dict[str, float] = Field(default_factory=dict)
    mean_latency_ms: float = 0.0
    total_cost_usd: float = 0.0


class BenchmarkRun(BaseModel):
    status: Literal["idle", "running", "completed", "failed", "stopped"] = "idle"
    run_id: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    progress_done: int = 0
    progress_total: int = 0
    current: str | None = None
    items_limit: int = 0
    results: list[TaskResult] = Field(default_factory=list)
    error: str | None = None


class BenchmarkContext(BaseModel):
    model_config = {"arbitrary_types_allowed": True}

    personas: dict[str, Persona]
    records: list[PersonaRecord]
    items: list[EvalItem]
    embedder: Embedder
    store: VectorStore
    providers: dict[str, LLMProvider]


def _pinned_router(spec: ModelSpec, providers: dict[str, LLMProvider]) -> LLMRouter:
    """Single-spec router: the model under test, nothing to fall back to."""
    return LLMRouter(ModelRegistry([spec]), {spec.provider: providers[spec.provider]})


def _sample(items: list[EvalItem], limit: int) -> list[EvalItem]:
    answerable = [i for i in items if i.answerable][:limit]
    unanswerable = [i for i in items if not i.answerable][: max(1, limit // 4)]
    return answerable + unanswerable


def job_key(task: str, spec: ModelSpec) -> str:
    return f"{task}|{spec.provider}:{spec.id}"


async def run_benchmark(
    ctx: BenchmarkContext,
    run: BenchmarkRun,
    specs: list[ModelSpec],
    tasks: list[str],
    items_limit: int,
    skip: set[str] | None = None,
) -> None:
    """Mutates ``run`` in place as progress; appends results as they land.

    ``skip`` holds ``job_key`` strings for (task, model) combos that
    already have aggregated results and should not be rerun.
    """
    skip = skip or set()
    sample = _sample(ctx.items, items_limit)
    jobs = [(t, s) for t in tasks for s in specs if job_key(t, s) not in skip]
    has_rerank = any(t == "rerank" for t, _ in jobs)
    run.status = "running"
    run.items_limit = items_limit
    run.progress_total = len(jobs) + (2 if has_rerank else 0)
    run.progress_done = 0
    run.results = []
    run.error = None
    try:
        if has_rerank:
            for baseline in ("none", "lexical"):
                run.current = f"rerank/baseline:{baseline}"
                run.results.append(await _bench_rerank_baseline(ctx, sample, baseline))
                run.progress_done += 1
        for task, spec in jobs:
            run.current = f"{task}/{spec.provider}:{spec.id}"
            logger.info("benchmark %s", kv(task=task, model=spec.id))
            bench = {
                "twin_answer": _bench_twin,
                "rerank": _bench_rerank,
                "eval_judge": _bench_judge,
            }[task]
            run.results.append(await bench(ctx, sample, spec))
            run.progress_done += 1
        run.status = "completed"
    except Exception as exc:  # noqa: BLE001 — surface, don't crash the app
        run.status = "failed"
        run.error = f"{type(exc).__name__}: {exc}"
        logger.warning("benchmark failed %s", kv(error=run.error))
    finally:
        run.current = None


async def _bench_twin(
    ctx: BenchmarkContext, sample: list[EvalItem], spec: ModelSpec
) -> TaskResult:
    router = _pinned_router(spec, ctx.providers)
    errors = 0
    latencies: list[float] = []
    cost = 0.0
    f1s: list[float] = []
    facts: list[bool] = []
    supports: list[float] = []
    cited_total = cited_ok = 0
    false_refusals = 0
    refused_unanswerable = 0
    answerable = [i for i in sample if i.answerable]
    unanswerable = [i for i in sample if not i.answerable]

    for item in sample:
        started = time.perf_counter()
        try:
            r = await ask_twin(
                ctx.personas[item.persona_id],
                item.question,
                embedder=ctx.embedder,
                store=ctx.store,
                router=router,
                k=K,
                debug=True,
            )
        except AllProvidersFailedError:
            errors += 1
            continue
        latencies.append((time.perf_counter() - started) * 1000)
        if r.debug and r.debug.routing and r.debug.routing.estimated_cost_usd:
            cost += r.debug.routing.estimated_cost_usd
        if not item.answerable:
            refused_unanswerable += 0 if r.answered else 1
            continue
        if not r.answered:
            false_refusals += 1
            continue
        f1s.append(token_f1(r.answer, item.reference))
        facts.append(contains_reference(r.answer, item.reference))
        retrieved = {sc.chunk.chunk_id: sc for sc in (r.debug.retrieved if r.debug else [])}
        cited_texts = []
        for c in r.citations:
            cited_total += 1
            cited_ok += c.doc_id in item.source_docs
            if c.chunk_id in retrieved:
                cited_texts.append(retrieved[c.chunk_id].chunk.text)
        supports.append(lexical_support(r.answer, cited_texts) if cited_texts else 0.0)

    metrics = {
        "fact_presence": _mean([float(x) for x in facts]),
        "token_f1": _mean(f1s),
        "citation_precision": (cited_ok / cited_total) if cited_total else 0.0,
        "claim_support": _mean(supports),
        "false_refusal_rate": false_refusals / len(answerable) if answerable else 0.0,
    }
    if unanswerable:
        metrics["refusal_recall"] = refused_unanswerable / len(unanswerable)
    return TaskResult(
        task="twin_answer",
        provider=spec.provider,
        model=spec.id,
        n=len(sample),
        errors=errors,
        metrics={k: round(v, 3) for k, v in metrics.items()},
        mean_latency_ms=round(_mean(latencies), 1),
        total_cost_usd=round(cost, 6),
    )


async def _retrieval_candidates(
    ctx: BenchmarkContext, item: EvalItem
) -> list[ScoredChunk]:
    qv = await ctx.embedder.embed_query(item.question)
    return await ctx.store.search(qv, k=N_CANDIDATES, persona_id=item.persona_id)


def _rank_metrics(ordered: list[ScoredChunk], item: EvalItem) -> tuple[int, float]:
    rank = next(
        (i + 1 for i, sc in enumerate(ordered[:K]) if sc.chunk.doc_id in item.source_docs),
        None,
    )
    return (1 if rank else 0), (1.0 / rank if rank else 0.0)


async def _bench_rerank_baseline(
    ctx: BenchmarkContext, sample: list[EvalItem], baseline: str
) -> TaskResult:
    hits = 0
    rrs: list[float] = []
    answerable = [i for i in sample if i.answerable]
    lexical = LexicalReranker()
    for item in answerable:
        candidates = await _retrieval_candidates(ctx, item)
        if baseline == "lexical":
            ordered = lexical.rerank(item.question, candidates)
        else:
            ordered = candidates
        hit, rr = _rank_metrics(ordered, item)
        hits += hit
        rrs.append(rr)
    n = len(answerable)
    return TaskResult(
        task="rerank",
        provider="baseline",
        model=baseline,
        n=n,
        metrics={"hit_rate": round(hits / n, 3) if n else 0.0, "mrr": round(_mean(rrs), 3)},
    )


async def _bench_rerank(
    ctx: BenchmarkContext, sample: list[EvalItem], spec: ModelSpec
) -> TaskResult:
    router = _pinned_router(spec, ctx.providers)
    reranker = LLMReranker(router)
    hits = 0
    rrs: list[float] = []
    latencies: list[float] = []
    answerable = [i for i in sample if i.answerable]
    for item in answerable:
        candidates = await _retrieval_candidates(ctx, item)
        started = time.perf_counter()
        ordered = await reranker.rerank(item.question, candidates)
        latencies.append((time.perf_counter() - started) * 1000)
        hit, rr = _rank_metrics(ordered, item)
        hits += hit
        rrs.append(rr)
    n = len(answerable)
    return TaskResult(
        task="rerank",
        provider=spec.provider,
        model=spec.id,
        n=n,
        metrics={"hit_rate": round(hits / n, 3) if n else 0.0, "mrr": round(_mean(rrs), 3)},
        mean_latency_ms=round(_mean(latencies), 1),
    )


def _judge_pairs(
    ctx: BenchmarkContext, sample: list[EvalItem]
) -> list[tuple[str, str, bool]]:
    """(answer, evidence, expected_supported) triples from the dataset."""
    docs = {d.doc_id: d.text for r in ctx.records for d in r.documents}
    by_persona: dict[str, list[str]] = {}
    for r in ctx.records:
        by_persona[r.persona.persona_id] = [d.doc_id for d in r.documents]
    pairs: list[tuple[str, str, bool]] = []
    personas = sorted(by_persona)
    for item in (i for i in sample if i.answerable):
        gold = docs[item.source_docs[0]]
        answer = f"{item.question} {item.reference}"
        pairs.append((answer, gold, True))
        other_persona = personas[(personas.index(item.persona_id) + 1) % len(personas)]
        foreign = docs[by_persona[other_persona][0]]
        pairs.append((answer, foreign, False))
    return pairs


async def _bench_judge(
    ctx: BenchmarkContext, sample: list[EvalItem], spec: ModelSpec
) -> TaskResult:
    router = _pinned_router(spec, ctx.providers)
    pairs = _judge_pairs(ctx, sample)
    correct = errors = 0
    latencies: list[float] = []
    cost = 0.0
    for answer, evidence, expected in pairs:
        request = LLMRequest(
            system=JUDGE_SYSTEM,
            user=f"ANSWER:\n{answer}\n\nEVIDENCE:\n- {evidence}",
            max_tokens=512,
        )
        started = time.perf_counter()
        try:
            verdict, response, _ = await router.complete_structured(
                request, SupportVerdict, task="eval_judge"
            )
        except AllProvidersFailedError:
            errors += 1
            continue
        latencies.append((time.perf_counter() - started) * 1000)
        cost += response.cost_usd
        correct += verdict.supported is expected
    judged = len(pairs) - errors
    return TaskResult(
        task="eval_judge",
        provider=spec.provider,
        model=spec.id,
        n=len(pairs),
        errors=errors,
        metrics={"accuracy": round(correct / judged, 3) if judged else 0.0},
        mean_latency_ms=round(_mean(latencies), 1),
        total_cost_usd=round(cost, 6),
    )


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0
