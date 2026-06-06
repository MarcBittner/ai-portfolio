"""Core domain models shared across pipeline stages."""

from typing import Literal

from pydantic import BaseModel, Field

ChunkStrategy = Literal["fixed", "semantic", "content_aware"]


class Chunk(BaseModel):
    """A retrievable unit of text with full provenance."""

    chunk_id: str
    doc_id: str
    persona_id: str
    text: str
    strategy: ChunkStrategy
    char_span: tuple[int, int]


class ScoredChunk(BaseModel):
    """A chunk with retrieval (and optionally rerank) scores attached."""

    chunk: Chunk
    score: float
    rerank_score: float | None = None
    pre_rerank_rank: int | None = None


class HexacoProfile(BaseModel):
    """Six HEXACO dimensions, each 0.0–1.0."""

    honesty_humility: float = Field(ge=0.0, le=1.0)
    emotionality: float = Field(ge=0.0, le=1.0)
    extraversion: float = Field(ge=0.0, le=1.0)
    agreeableness: float = Field(ge=0.0, le=1.0)
    conscientiousness: float = Field(ge=0.0, le=1.0)
    openness: float = Field(ge=0.0, le=1.0)


class Persona(BaseModel):
    """A synthetic, clearly-fictional audience persona."""

    persona_id: str
    name: str
    tagline: str
    bio: str
    hexaco: HexacoProfile
    voice_notes: list[str] = []
    doc_count: int = 0


class Citation(BaseModel):
    """Pointer from an answer back to a retrieved chunk."""

    doc_id: str
    chunk_id: str
    score: float
    excerpt: str


class RoutingDecision(BaseModel):
    """How the router picked a provider/model for one request."""

    provider: str
    model: str
    objective: str
    task: str | None = None
    fallbacks_taken: list[str] = []
    estimated_cost_usd: float | None = None
    latency_ms: float | None = None


class AskRequest(BaseModel):
    persona_id: str
    question: str = Field(min_length=1, max_length=2000)
    k: int = Field(default=5, ge=1, le=20)
    debug: bool = False


class DebugInfo(BaseModel):
    routing: RoutingDecision | None = None
    retrieved: list[ScoredChunk] = []
    stage_timings_ms: dict[str, float] = {}
    cache: dict[str, str] = {}


class AskResponse(BaseModel):
    persona_id: str
    question: str
    answer: str
    answered: bool  # False when the twin refuses for lack of grounding
    citations: list[Citation] = []
    debug: DebugInfo | None = None
