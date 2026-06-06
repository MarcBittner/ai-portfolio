"""FastAPI service: query persona twins over the RAG pipeline.

Backends assemble from the environment (see config.py); with no
configuration the whole stack is offline. The corpus is ingested at
startup if the store is empty; ``POST /ingest`` rebuilds on demand.

Routes are registered twice — bare (``/ask``) and under ``/api``
(``/api/ask``) — so the container image can serve the built frontend
and the API from one origin. Answers for non-debug requests are cached
(in-process LRU, or Redis when ``REDIS_URL`` is set).
"""

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from persona_twin import __version__
from persona_twin.cache import DEFAULT_TTL_SECONDS, Cache, CacheStats, cache_key, get_cache
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings, get_settings
from persona_twin.corpus import PersonaRecord, load_personas
from persona_twin.embedding import get_embedder
from persona_twin.embedding.base import Embedder
from persona_twin.embedding.cached import CachedEmbedder
from persona_twin.llm import TASKS, LLMRouter, ModelSpec, RoutingPolicy, get_router
from persona_twin.log import configure, new_request_id
from persona_twin.models import AskRequest, AskResponse, ChunkStrategy, Persona
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import IngestReport, ingest_corpus
from persona_twin.vectorstore import get_vector_store
from persona_twin.vectorstore.base import VectorStore

DEFAULT_STRATEGY: ChunkStrategy = "content_aware"
STATIC_DIR = os.environ.get("PERSONA_TWIN_STATIC_DIR", "")


@dataclass
class AppState:
    settings: Settings
    embedder: Embedder
    store: VectorStore
    router: LLMRouter
    records: list[PersonaRecord]
    cache: Cache
    cache_stats: CacheStats = field(default_factory=CacheStats)

    @property
    def personas(self) -> dict[str, Persona]:
        return {r.persona.persona_id: r.persona for r in self.records}


def build_state(settings: Settings | None = None) -> AppState:
    settings = settings or get_settings()
    cache = get_cache(settings)
    stats = CacheStats()
    embedder = CachedEmbedder(get_embedder(settings), cache, stats)
    return AppState(
        settings=settings,
        embedder=embedder,
        store=get_vector_store(settings, dimensions=embedder.dimensions),
        router=get_router(settings),
        records=load_personas(),
        cache=cache,
        cache_stats=stats,
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
        embedding_backend=state.settings.embedding_backend,
        llm_backends=state.settings.llm_backends,
        route_objective=state.settings.route_objective,
        cache_backend=state.cache.name,
        cache_stats=state.cache_stats.as_dict(),
        chunks_indexed=await state.store.count(),
        personas=len(state.records),
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


@router.post("/ingest", response_model=IngestReport)
async def ingest(request: IngestRequest) -> IngestReport:
    state = _state()
    await state.store.drop()
    return await ingest_corpus(
        get_chunker(request.strategy), state.embedder, state.store,
        records=state.records,
    )


class RoutingView(BaseModel):
    """Routing console payload: policy + everything needed to edit it."""

    policy: RoutingPolicy
    tasks: list[str]
    providers: dict[str, bool]  # provider -> configured (mock always true)
    registry: list[ModelSpec]
    plans: dict[str, list[str]]  # task -> ordered "provider:model" candidates


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
            return AskResponse.model_validate_json(cached)
        state.cache_stats.miss("answer")

    response = await ask_twin(
        persona,
        request.question,
        embedder=state.embedder,
        store=state.store,
        router=state.router,
        k=request.k,
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
