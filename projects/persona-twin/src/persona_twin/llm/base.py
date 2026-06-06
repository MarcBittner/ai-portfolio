"""LLM provider port and request/response types."""

from typing import Protocol, runtime_checkable

from pydantic import BaseModel

from persona_twin.models import RoutingDecision  # noqa: F401  (re-exported for callers)


class ModelSpec(BaseModel):
    provider: str
    id: str
    input_per_mtok: float
    output_per_mtok: float
    quality: int
    speed: int
    adaptive_thinking: bool = False

    @property
    def blended_price(self) -> float:
        """Cost rank for routing: RAG requests are input-heavy (~3:1)."""
        return 0.75 * self.input_per_mtok + 0.25 * self.output_per_mtok

    def cost_usd(self, input_tokens: int, output_tokens: int) -> float:
        return (
            input_tokens * self.input_per_mtok + output_tokens * self.output_per_mtok
        ) / 1_000_000


class LLMRequest(BaseModel):
    system: str
    user: str
    max_tokens: int = 1024
    json_schema: dict | None = None
    schema_name: str = "response"


class LLMUsage(BaseModel):
    input_tokens: int
    output_tokens: int


class LLMResponse(BaseModel):
    text: str
    provider: str
    model: str
    usage: LLMUsage
    latency_ms: float
    cost_usd: float


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    async def complete(self, request: LLMRequest, spec: ModelSpec) -> LLMResponse: ...
