"""FastAPI service: query persona twins over the RAG pipeline.

Backends assemble from the environment (see config.py); with no
configuration the whole stack is offline. The corpus is ingested at
startup if the store is empty; ``POST /ingest`` rebuilds on demand.

Routes are registered twice — bare (``/ask``) and under ``/api``
(``/api/ask``) — so the container image can serve the built frontend
and the API from one origin. Answers for non-debug requests are cached
(in-process LRU, or Redis when ``REDIS_URL`` is set).
"""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from persona_twin import __version__
from persona_twin.cache import DEFAULT_TTL_SECONDS, Cache, CacheStats, cache_key, get_cache
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings, get_settings
from persona_twin.corpus import PersonaRecord, load_personas
from persona_twin.embedding import get_embedder
from persona_twin.embedding.base import Embedder
from persona_twin.embedding.cached import CachedEmbedder
from persona_twin.eval.bench_store import AggregateEntry, BenchmarkStore, RunSummary
from persona_twin.eval.benchmark import (
    BENCH_TASKS,
    BenchmarkContext,
    BenchmarkRun,
    available_embedders,
    job_key,
    run_benchmark,
)
from persona_twin.eval.dataset import load_eval_dataset
from persona_twin.governance import Redactor
from persona_twin.llm import TASKS, LLMRouter, ModelSpec, RoutingPolicy, get_router
from persona_twin.log import configure, get_logger, kv, new_request_id
from persona_twin.models import (
    AskRequest,
    AskResponse,
    ChunkStrategy,
    HexacoProfile,
    Persona,
)
from persona_twin.observability import REQUESTS
from persona_twin.observability import render as render_metrics
from persona_twin.persona.chat import (
    ChatSessionStore,
    ChatTurn,
    CitationsEvent,
    DoneEvent,
    TokenEvent,
    chat_twin,
)
from persona_twin.persona.store import (
    PersonaStore,
    StoredDoc,
    StoredPersona,
    slugify,
    valid_persona_id,
)
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import IngestReport, ingest_corpus
from persona_twin.retrieval.bm25 import BM25Index
from persona_twin.vectorstore import get_vector_store
from persona_twin.vectorstore.base import VectorStore

DEFAULT_STRATEGY: ChunkStrategy = "content_aware"
STATIC_DIR = os.environ.get("PERSONA_TWIN_STATIC_DIR", "")

logger = get_logger("api")


@dataclass
class AppState:
    settings: Settings
    embedder: Embedder
    store: VectorStore
    router: LLMRouter
    records: list[PersonaRecord]
    cache: Cache
    cache_stats: CacheStats = field(default_factory=CacheStats)
    bm25: BM25Index = field(default_factory=BM25Index)
    benchmark: BenchmarkRun = field(default_factory=BenchmarkRun)
    benchmark_task: asyncio.Task | None = None
    bench_store: BenchmarkStore = field(default_factory=BenchmarkStore)
    sessions: ChatSessionStore = field(default_factory=ChatSessionStore)
    persona_store: PersonaStore = field(default_factory=PersonaStore)

    @property
    def personas(self) -> dict[str, Persona]:
        return {r.persona.persona_id: r.persona for r in self.records}


def _load_records(persona_store: PersonaStore) -> list[PersonaRecord]:
    """Baked-in corpus plus persisted browser-created twins; on an id
    collision the baked-in persona wins and the stored one is skipped."""
    records = load_personas()
    known = {r.persona.persona_id for r in records}
    for stored in persona_store.load_all():
        if stored.persona_id in known:
            logger.warning("stored persona shadows baked-in; skipping %s",
                           kv(persona=stored.persona_id))
            continue
        known.add(stored.persona_id)
        records.append(stored.to_record())
    return records


def build_state(settings: Settings | None = None) -> AppState:
    settings = settings or get_settings()
    cache = get_cache(settings)
    stats = CacheStats()
    embedder = CachedEmbedder(get_embedder(settings), cache, stats)
    persona_store = PersonaStore()
    return AppState(
        settings=settings,
        embedder=embedder,
        store=get_vector_store(settings, dimensions=embedder.dimensions),
        router=get_router(settings),
        records=_load_records(persona_store),
        cache=cache,
        cache_stats=stats,
        persona_store=persona_store,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure()
    state: AppState = getattr(app.state, "twin", None) or build_state()
    app.state.twin = state
    if await state.store.count() == 0:
        await ingest_corpus(
            get_chunker(DEFAULT_STRATEGY), state.embedder, state.store,
            records=state.records,
        )
    if state.settings.hybrid_retrieval:
        state.bm25.build(await state.store.all_chunks())
    yield


app = FastAPI(
    title="persona-twin",
    version=__version__,
    description="Query RAG-grounded digital twins of synthetic personas.",
    lifespan=lifespan,
)
router = APIRouter()


def _state() -> AppState:
    return app.state.twin


class HealthResponse(BaseModel):
    status: str
    version: str
    vector_backend: str
    embedding_backend: str
    llm_backends: list[str]
    route_objective: str
    cache_backend: str
    cache_stats: dict[str, dict[str, int]]
    chunks_indexed: int
    personas: int


class IngestRequest(BaseModel):
    strategy: ChunkStrategy = DEFAULT_STRATEGY


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    state = _state()
    return HealthResponse(
        status="ok",
        version=__version__,
        vector_backend=state.settings.vector_backend,
        embedding_backend=getattr(state.embedder, "name", "unknown"),
        llm_backends=state.settings.llm_backends,
        route_objective=state.settings.route_objective,
        cache_backend=state.cache.name,
        cache_stats=state.cache_stats.as_dict(),
        chunks_indexed=await state.store.count(),
        personas=len(state.records),
    )


@router.get("/metrics")
async def metrics() -> PlainTextResponse:
    """Prometheus exposition. Accumulated metrics (request/LLM/circuit) plus
    pull-style gauges sampled from current state at scrape time."""
    state = _state()
    extra: list[str] = [
        "# HELP persona_twin_build_info Build metadata",
        "# TYPE persona_twin_build_info gauge",
        f'persona_twin_build_info{{version="{__version__}"}} 1',
        "# HELP persona_twin_chunks_indexed Chunks currently in the vector store",
        "# TYPE persona_twin_chunks_indexed gauge",
        f"persona_twin_chunks_indexed {await state.store.count()}",
        "# HELP persona_twin_personas Personas currently loaded",
        "# TYPE persona_twin_personas gauge",
        f"persona_twin_personas {len(state.records)}",
        "# HELP persona_twin_cache_events_total Cache lookups by kind and result",
        "# TYPE persona_twin_cache_events_total counter",
    ]
    for kind, n in sorted(state.cache_stats.hits.items()):
        extra.append(f'persona_twin_cache_events_total{{kind="{kind}",result="hit"}} {n}')
    for kind, n in sorted(state.cache_stats.misses.items()):
        extra.append(f'persona_twin_cache_events_total{{kind="{kind}",result="miss"}} {n}')
    cooling = state.router.breaker.cooling_down()
    extra.append("# HELP persona_twin_circuit_cooldown_seconds Seconds until a circuit half-opens")
    extra.append("# TYPE persona_twin_circuit_cooldown_seconds gauge")
    for target, secs in sorted(cooling.items()):
        safe = target.replace("\\", "\\\\").replace('"', '\\"')
        extra.append(f'persona_twin_circuit_cooldown_seconds{{target="{safe}"}} {secs:g}')
    return PlainTextResponse(
        render_metrics(extra), media_type="text/plain; version=0.0.4; charset=utf-8"
    )


@router.get("/personas", response_model=list[Persona])
async def list_personas() -> list[Persona]:
    return [r.persona for r in _state().records]


@router.get("/personas/{persona_id}", response_model=Persona)
async def get_persona(persona_id: str) -> Persona:
    persona = _state().personas.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail=f"unknown persona: {persona_id}")
    return persona


async def _rebuild_bm25(state: AppState) -> None:
    if state.settings.hybrid_retrieval:
        state.bm25.build(await state.store.all_chunks())


# ---- Persona builder: live redaction preview + create/delete -------------

class DocumentInput(BaseModel):
    name: str = ""
    text: str = Field(min_length=1, max_length=20000)


class RedactionPreviewRequest(BaseModel):
    documents: list[DocumentInput] = Field(min_length=1, max_length=20)


class DocRedaction(BaseModel):
    name: str
    counts: dict[str, int]  # PII type -> count; values are never returned
    redacted: str


class RedactionPreview(BaseModel):
    documents: list[DocRedaction]
    total_counts: dict[str, int]
    total: int


@router.post("/redaction/preview", response_model=RedactionPreview)
async def preview_redaction(request: RedactionPreviewRequest) -> RedactionPreview:
    """Show what the mandatory ingest-time redactor would remove — counts by
    type and the tokenized text. Stateless; redacted *values* never leave."""
    redactor = Redactor()
    docs: list[DocRedaction] = []
    totals: dict[str, int] = {}
    for doc in request.documents:
        result = redactor.redact(doc.text)
        docs.append(
            DocRedaction(
                name=doc.name.strip() or "document",
                counts=result.counts,
                redacted=result.text,
            )
        )
        for pii_type, n in result.counts.items():
            totals[pii_type] = totals.get(pii_type, 0) + n
    return RedactionPreview(documents=docs, total_counts=totals, total=sum(totals.values()))


class PersonaCreate(BaseModel):
    persona_id: str | None = None  # slug; derived from name when omitted
    name: str = Field(min_length=1, max_length=80)
    tagline: str = Field(min_length=1, max_length=160)
    bio: str = Field(min_length=1, max_length=2000)
    hexaco: HexacoProfile
    voice_notes: list[str] = Field(default_factory=list, max_length=12)
    documents: list[DocumentInput] = Field(min_length=1, max_length=20)


class PersonaCreated(BaseModel):
    persona: Persona
    chunks: int
    redactions: dict[str, int]  # PII removed before anything was stored/embedded


def _redacted_docs(documents: list[DocumentInput]) -> tuple[list[StoredDoc], dict]:
    """Redact each document (the mandatory gate) and assign unique slug names.
    Returns the stored (redacted) docs and the redaction totals."""
    redactor = Redactor()
    used: set[str] = set()
    stored: list[StoredDoc] = []
    totals: dict[str, int] = {}
    for i, doc in enumerate(documents):
        name = slugify(doc.name, fallback=f"document-{i + 1}")
        while name in used:
            name = f"{name}-{i + 1}"
        used.add(name)
        result = redactor.redact(doc.text)
        stored.append(StoredDoc(name=name, text=result.text))
        for pii_type, n in result.counts.items():
            totals[pii_type] = totals.get(pii_type, 0) + n
    return stored, totals


@router.post("/personas", response_model=PersonaCreated, status_code=201)
async def create_persona(request: PersonaCreate) -> PersonaCreated:
    """Create a twin from the browser: redact its documents, persist it,
    ingest it incrementally, and make it immediately queryable."""
    state = _state()
    persona_id = request.persona_id or slugify(request.name, fallback="")
    if not valid_persona_id(persona_id):
        raise HTTPException(
            status_code=422,
            detail="persona_id must be a slug: lowercase letters, digits, hyphens",
        )
    if persona_id in state.personas:
        raise HTTPException(status_code=409, detail=f"persona exists: {persona_id}")

    stored_docs, redactions = _redacted_docs(request.documents)
    stored = StoredPersona(
        persona_id=persona_id,
        name=request.name.strip(),
        tagline=request.tagline.strip(),
        bio=request.bio.strip(),
        hexaco=request.hexaco,
        voice_notes=[v.strip() for v in request.voice_notes if v.strip()],
        documents=stored_docs,
    )
    record = stored.to_record()

    state.persona_store.save(stored)
    state.records.append(record)
    # incremental ingest: append this twin's chunks without dropping the rest
    report = await ingest_corpus(
        get_chunker(DEFAULT_STRATEGY), state.embedder, state.store, records=[record]
    )
    await _rebuild_bm25(state)
    REQUESTS.inc("personas", "created")
    logger.info(
        "persona created %s",
        kv(persona=persona_id, chunks=report.chunks, redacted=sum(redactions.values())),
    )
    return PersonaCreated(
        persona=record.persona, chunks=report.chunks, redactions=redactions
    )


@router.delete("/personas/{persona_id}", status_code=200)
async def delete_persona(persona_id: str) -> dict[str, str]:
    """Delete a browser-created twin (baked-in personas are not deletable).
    Rebuilds the index from the remaining corpus."""
    state = _state()
    if not state.persona_store.exists(persona_id):
        raise HTTPException(
            status_code=404, detail=f"no user-created persona: {persona_id}"
        )
    state.persona_store.delete(persona_id)
    state.records = [r for r in state.records if r.persona.persona_id != persona_id]
    await state.store.drop()
    await ingest_corpus(
        get_chunker(DEFAULT_STRATEGY), state.embedder, state.store, records=state.records
    )
    await _rebuild_bm25(state)
    logger.info("persona deleted %s", kv(persona=persona_id))
    return {"deleted": persona_id}


@router.post("/ingest", response_model=IngestReport)
async def ingest(request: IngestRequest) -> IngestReport:
    state = _state()
    await state.store.drop()
    report = await ingest_corpus(
        get_chunker(request.strategy), state.embedder, state.store,
        records=state.records,
    )
    await _rebuild_bm25(state)
    return report


class RoutingView(BaseModel):
    """Routing console payload: policy + everything needed to edit it."""

    policy: RoutingPolicy
    tasks: list[str]
    providers: dict[str, bool]  # provider -> configured (mock always true)
    registry: list[ModelSpec]
    plans: dict[str, list[str]]  # task -> ordered "provider:model" candidates
    cooling_down: dict[str, float]  # provider:model -> seconds remaining
    bench_tasks: list[str]  # benchmarkable tasks (routed tasks + "embedding")


def _routing_view(state: AppState) -> RoutingView:
    llm = state.router
    available = set(llm.providers)
    return RoutingView(
        policy=llm.policy,
        tasks=list(TASKS),
        providers={
            spec_provider: spec_provider in available
            for spec_provider in sorted({s.provider for s in llm.registry.specs})
        },
        registry=llm.registry.specs,
        plans={
            task: [f"{s.provider}:{s.id}" for s in llm.plan(task=task)]
            for task in TASKS
        },
        cooling_down=llm.breaker.cooling_down(),
        bench_tasks=list(BENCH_TASKS),
    )


@router.get("/routing", response_model=RoutingView)
async def get_routing() -> RoutingView:
    return _routing_view(_state())


@router.put("/routing", response_model=RoutingView)
async def put_routing(policy: RoutingPolicy) -> RoutingView:
    state = _state()
    known = {f"{s.provider}:{s.id}" for s in state.router.registry.specs}
    for task, route in policy.tasks.items():
        if route.pin is not None and route.pin not in known:
            raise HTTPException(
                status_code=422,
                detail=f"unknown pin for {task}: {route.pin}",
            )
    state.router.policy = policy
    return _routing_view(state)


class BenchmarkRequest(BaseModel):
    models: list[str] | None = None  # "provider:model_id"; default: all available
    tasks: list[str] = Field(default_factory=lambda: list(BENCH_TASKS))
    items_limit: int = Field(default=6, ge=1, le=28)
    # False (default): skip combos that already have aggregated results.
    # True ("rerun selected"): measure everything selected again.
    force: bool = False


@router.get("/benchmark", response_model=BenchmarkRun)
async def get_benchmark() -> BenchmarkRun:
    return _state().benchmark


@router.post("/benchmark", response_model=BenchmarkRun, status_code=202)
async def post_benchmark(request: BenchmarkRequest) -> BenchmarkRun:
    state = _state()
    if state.benchmark.status == "running":
        raise HTTPException(status_code=409, detail="a benchmark is already running")
    unknown_tasks = set(request.tasks) - set(BENCH_TASKS)
    if unknown_tasks:
        raise HTTPException(status_code=422, detail=f"unknown tasks: {sorted(unknown_tasks)}")

    available = {
        f"{s.provider}:{s.id}": s
        for s in state.router.registry.specs
        if s.provider in state.router.providers
    }
    if request.models is None:
        specs = list(available.values())
    else:
        missing = [m for m in request.models if m not in available]
        if missing:
            raise HTTPException(status_code=422, detail=f"unknown models: {missing}")
        specs = [available[m] for m in request.models]

    ctx = BenchmarkContext(
        personas=state.personas,
        records=state.records,
        items=load_eval_dataset(),
        embedder=state.embedder,
        store=state.store,
        providers=state.router.providers,
        settings=state.settings,
    )
    llm_tasks = [t for t in request.tasks if t != "embedding"]
    embedding_combos: list[str] = []
    if "embedding" in request.tasks:
        embedding_combos = [
            f"embedding|{name}:{mode}"
            for name in available_embedders(state.settings)
            for mode in ("vector", "hybrid")
        ]
    skip: set[str] = set()
    if not request.force:
        existing = {
            (e.task, e.provider, e.model) for e in state.bench_store.aggregate()
        }
        skip = {
            job_key(t, s)
            for t in llm_tasks
            for s in specs
            if (t, s.provider, s.id) in existing
        }
        skip |= {
            combo
            for combo in embedding_combos
            if ("embedding", *combo.split("|")[1].rsplit(":", 1)) in existing
        }
        total = len(llm_tasks) * len(specs) + len(embedding_combos)
        if total and len(skip) == total:
            raise HTTPException(
                status_code=409,
                detail="all selected task×model combos already have results — "
                "use force=true (Rerun selected) to measure them again",
            )

    from datetime import UTC, datetime
    from uuid import uuid4

    now = datetime.now(UTC)
    state.benchmark = BenchmarkRun(
        status="running",
        # uuid suffix: runs started within the same second must not collide
        run_id=f"{now.strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:4]}",
        started_at=now.isoformat(timespec="seconds"),
    )
    state.benchmark_task = asyncio.create_task(
        _run_and_persist(state, ctx, specs, request.tasks, request.items_limit, skip)
    )
    return state.benchmark


@router.get("/benchmark/aggregate", response_model=list[AggregateEntry])
async def benchmark_aggregate() -> list[AggregateEntry]:
    state = _state()
    return state.bench_store.aggregate(current=state.benchmark)


async def _run_and_persist(state: AppState, ctx, specs, tasks, items_limit, skip) -> None:
    from datetime import UTC, datetime

    run = state.benchmark
    try:
        await run_benchmark(ctx, run, specs, tasks, items_limit, skip=skip)
    except asyncio.CancelledError:
        run.status = "stopped"  # partial results retained
        run.current = None
    finally:
        run.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
        if run.results:
            state.bench_store.save(run)


@router.post("/benchmark/stop", response_model=BenchmarkRun)
async def stop_benchmark() -> BenchmarkRun:
    state = _state()
    if state.benchmark.status != "running" or state.benchmark_task is None:
        raise HTTPException(status_code=409, detail="no benchmark is running")
    state.benchmark_task.cancel()
    return state.benchmark  # client keeps polling until status == "stopped"


@router.get("/benchmark/history", response_model=list[RunSummary])
async def benchmark_history() -> list[RunSummary]:
    return _state().bench_store.list_runs()


@router.get("/benchmark/history/{run_id}", response_model=BenchmarkRun)
async def benchmark_history_run(run_id: str) -> BenchmarkRun:
    run = _state().bench_store.load(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"unknown run: {run_id}")
    return run


class ChatRequest(BaseModel):
    persona_id: str
    message: str = Field(min_length=1, max_length=2000)
    session_id: str | None = None  # omit to start a new conversation
    k: int = Field(default=5, ge=1, le=20)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Streamed conversational twin (Server-Sent Events).

    Events: ``meta`` (session_id) → ``token`` (prose deltas) → ``citations``
    (validated tail) → ``done`` (routing); ``error`` on failure. Conversation
    memory is keyed by ``session_id`` (generated when omitted). The stateless
    ``/ask`` path is untouched — it remains the measured/eval path."""
    new_request_id()
    state = _state()
    persona = state.personas.get(request.persona_id)
    if persona is None:
        raise HTTPException(
            status_code=404, detail=f"unknown persona: {request.persona_id}"
        )

    from uuid import uuid4

    session_id = request.session_id or uuid4().hex[:12]
    history = state.sessions.history(session_id)  # turns before this message
    state.sessions.append(session_id, ChatTurn(role="user", content=request.message))

    async def events():
        yield _sse("meta", {"session_id": session_id})
        answer_parts: list[str] = []
        try:
            async for ev in chat_twin(
                persona,
                request.message,
                history,
                embedder=state.embedder,
                store=state.store,
                router=state.router,
                bm25=state.bm25 if state.settings.hybrid_retrieval else None,
                k=request.k,
            ):
                if isinstance(ev, TokenEvent):
                    answer_parts.append(ev.text)
                    yield _sse("token", {"text": ev.text})
                elif isinstance(ev, CitationsEvent):
                    yield _sse(
                        "citations",
                        {
                            "answered": ev.answered,
                            "citations": [c.model_dump() for c in ev.citations],
                        },
                    )
                elif isinstance(ev, DoneEvent):
                    yield _sse("done", {"routing": ev.routing.model_dump()})
        except Exception as exc:  # noqa: BLE001 — surface as a stream error event
            yield _sse("error", {"detail": f"{type(exc).__name__}: {exc}"})
            return
        state.sessions.append(
            session_id, ChatTurn(role="assistant", content="".join(answer_parts))
        )

    REQUESTS.inc("chat", "started")
    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-accel-buffering": "no",  # don't let a proxy buffer the stream
        },
    )


@router.post("/ask", response_model=AskResponse)
async def ask(request: AskRequest) -> AskResponse:
    new_request_id()
    state = _state()
    persona = state.personas.get(request.persona_id)
    if persona is None:
        raise HTTPException(
            status_code=404, detail=f"unknown persona: {request.persona_id}"
        )

    # Answer cache: non-debug requests only (debug recomputes and shows work)
    key = cache_key(
        "ask",
        request.persona_id,
        str(request.k),
        request.question,
        ",".join(state.settings.llm_backends),
    )
    if not request.debug:
        cached = await state.cache.get(key)
        if cached is not None:
            state.cache_stats.hit("answer")
            REQUESTS.inc("ask", "cache_hit")
            return AskResponse.model_validate_json(cached)
        state.cache_stats.miss("answer")

    response = await ask_twin(
        persona,
        request.question,
        embedder=state.embedder,
        store=state.store,
        router=state.router,
        bm25=state.bm25 if state.settings.hybrid_retrieval else None,
        k=request.k,
        rewrite=state.settings.query_rewrite,
        debug=request.debug,
    )
    if not request.debug:
        await state.cache.set(key, response.model_dump_json(), ttl=DEFAULT_TTL_SECONDS)
    elif response.debug is not None:
        response.debug.cache = {
            "backend": state.cache.name,
            **{
                f"{kind}_hits": str(n)
                for kind, n in state.cache_stats.hits.items()
            },
        }
    REQUESTS.inc("ask", "answered" if response.answered else "refused")
    return response


app.include_router(router)
app.include_router(router, prefix="/api", include_in_schema=False)

# Serve the built frontend when present (container image / PERSONA_TWIN_STATIC_DIR).
# SPA fallback: unknown GET paths return index.html so client-side routes
# (/routing) deep-link correctly; API routes above always win the match.
if STATIC_DIR and Path(STATIC_DIR).is_dir():  # pragma: no cover - container path
    _static_root = Path(STATIC_DIR)
    app.mount("/assets", StaticFiles(directory=_static_root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        candidate = _static_root / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_static_root / "index.html")
