"""Request/response models for the counsel API."""

from typing import Any

from pydantic import BaseModel, Field


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    mode: str | None = None         # auto | paid | local | free | offline


class ProposeRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    category: str | None = Field(default=None, max_length=64)


class DecideRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    approve: bool


class AddTransactionRequest(BaseModel):
    """A human-entered ledger row. Code recomputes over it; no LLM writes data."""

    account_id: str = Field(min_length=1, max_length=64)
    date: str = Field(min_length=1, max_length=10)   # ISO yyyy-mm-dd
    merchant: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=32)
    amount: float       # signed: negative = money out, positive = money in


class HealthResponse(BaseModel):
    status: str
    version: str
    accounts: int
    transactions: int
    pending_proposals: int
    offline_fallback: bool


class VerifyRowOut(BaseModel):
    label: str
    code_value: float
    stated_value: float | None
    ok: bool


class RoutingOut(BaseModel):
    provider: str
    model: str
    mode: str
    latency_ms: float | None = None
    cost_usd: float | None = None
    fallbacks: list[str] = []
    blocked: bool | None = None


class AskResponse(BaseModel):
    question: str
    refused: bool
    refusal_reason: str
    answer: str
    intent: str
    facts: dict[str, Any]
    citations: list[str]
    dropped_citations: list[str]
    verify: list[VerifyRowOut]
    verified_ok: bool
    records: list[dict[str, Any]]
    routing: dict[str, Any]
    proposals_available: list[str]
