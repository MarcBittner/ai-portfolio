"""Request/response models for the API."""

from pydantic import BaseModel, Field


class EvalItem(BaseModel):
    prediction: str
    reference: str


class EvaluateRequest(BaseModel):
    items: list[EvalItem] = Field(min_length=1, max_length=2000)
    metrics: list[str] | None = None  # default: all
    thresholds: dict[str, float] | None = None  # metric -> minimum (gate)


class ItemResult(BaseModel):
    index: int
    scores: dict[str, float]


class GateResult(BaseModel):
    passed: bool
    failures: dict[str, dict[str, float]]


class EvaluateResponse(BaseModel):
    n: int
    metrics: list[str]
    per_item: list[ItemResult]
    aggregate: dict[str, float]
    gate: GateResult | None = None


class CompareRequest(BaseModel):
    baseline: dict[str, float]
    candidate: dict[str, float]


class CompareResponse(BaseModel):
    comparison: dict[str, dict[str, float | None]]


class MetricInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    version: str
    metrics: int
