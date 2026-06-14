"""Request/response models for the API."""


from pydantic import BaseModel, Field


class EvalItem(BaseModel):
    prediction: str
    reference: str


class ClientJudgment(BaseModel):
    """One per-item LLM-judge verdict the BROWSER obtained from a host-local
    Ollama (browser→host)."""
    correct: bool


class EvaluateRequest(BaseModel):
    items: list[EvalItem] = Field(min_length=1, max_length=2000)
    metrics: list[str] | None = None     # may include "llm_judge"
    thresholds: dict[str, float] | None = None
    provider: str = "auto"               # for the llm_judge metric
    model: str | None = None
    # Judge verdicts the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # these are supplied the server skips its own LLM-judge call and uses them —
    # letting a cloud-hosted demo grade with a real local model. The deterministic
    # metric math, thresholds, and gate are unchanged. One entry per item, in order.
    client_judgments: list[ClientJudgment] | None = None


class ItemResult(BaseModel):
    index: int
    scores: dict[str, float]


class GateResult(BaseModel):
    passed: bool
    failures: dict[str, dict[str, float]]


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class EvaluateResponse(BaseModel):
    n: int
    metrics: list[str]
    per_item: list[ItemResult]
    aggregate: dict[str, float]
    gate: GateResult | None = None
    routing: RoutingInfo | None = None   # present when llm_judge ran


class CompareRequest(BaseModel):
    baseline: dict[str, float]
    candidate: dict[str, float]


class CompareResponse(BaseModel):
    comparison: dict[str, dict[str, float | None]]


class MetricInfo(BaseModel):
    name: str
    description: str
    source: str = "deterministic"


class HealthResponse(BaseModel):
    status: str
    version: str
    metrics: int
    ollama: bool
