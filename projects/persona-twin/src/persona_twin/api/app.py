"""FastAPI service: query persona twins over the RAG pipeline.

Backends assemble from the environment (see config.py); with no
configuration the whole stack is offline. The corpus is ingested at
startup if the store is empty; ``POST /ingest`` rebuilds on demand.
"""

from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from persona_twin import __version__
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings, get_settings
from persona_twin.corpus import PersonaRecord, load_personas
from persona_twin.embedding import get_embedder
from persona_twin.embedding.base import Embedder
from persona_twin.llm import LLMRouter, get_router
from persona_twin.log import configure, new_request_id
from persona_twin.models import AskRequest, AskResponse, ChunkStrategy, Persona
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import IngestReport, ingest_corpus
from persona_twin.vectorstore import get_vector_store
from persona_twin.vectorstore.base import VectorStore

DEFAULT_STRATEGY: ChunkStrategy = "content_aware"


@dataclass
class AppState:
    settings: Settings
    embedder: Embedder
    store: VectorStore
    router: LLMRouter
    records: list[PersonaRecord]

    @property
    def personas(self) -> dict[str, Persona]:
        return {r.persona.persona_id: r.persona for r in self.records}


def build_state(settings: Settings | None = None) -> AppState:
    settings = settings or get_settings()
    embedder = get_embedder(settings)
    return AppState(
        settings=settings,
        embedder=embedder,
        store=get_vector_store(settings, dimensions=embedder.dimensions),
        router=get_router(settings),
        records=load_personas(),
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


def _state() -> AppState:
    return app.state.twin


class HealthResponse(BaseModel):
    status: str
    version: str
    vector_backend: str
    embedding_backend: str
    llm_backends: list[str]
    route_objective: str
    chunks_indexed: int
    personas: int


class IngestRequest(BaseModel):
    strategy: ChunkStrategy = DEFAULT_STRATEGY


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    state = _state()
    return HealthResponse(
        status="ok",
        version=__version__,
        vector_backend=state.settings.vector_backend,
        embedding_backend=state.settings.embedding_backend,
        llm_backends=state.settings.llm_backends,
        route_objective=state.settings.route_objective,
        chunks_indexed=await state.store.count(),
        personas=len(state.records),
    )


@app.get("/personas", response_model=list[Persona])
async def list_personas() -> list[Persona]:
    return [r.persona for r in _state().records]


@app.get("/personas/{persona_id}", response_model=Persona)
async def get_persona(persona_id: str) -> Persona:
    persona = _state().personas.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail=f"unknown persona: {persona_id}")
    return persona


@app.post("/ingest", response_model=IngestReport)
async def ingest(request: IngestRequest) -> IngestReport:
    state = _state()
    await state.store.drop()
    return await ingest_corpus(
        get_chunker(request.strategy), state.embedder, state.store,
        records=state.records,
    )


@app.post("/ask", response_model=AskResponse)
async def ask(request: AskRequest) -> AskResponse:
    new_request_id()
    state = _state()
    persona = state.personas.get(request.persona_id)
    if persona is None:
        raise HTTPException(
            status_code=404, detail=f"unknown persona: {request.persona_id}"
        )
    return await ask_twin(
        persona,
        request.question,
        embedder=state.embedder,
        store=state.store,
        router=state.router,
        k=request.k,
        debug=request.debug,
    )
