"""Request/response models for the API."""

from pydantic import BaseModel, Field


class SendRequest(BaseModel):
    channel: str = "email"
    to: str = "user@example.com"
    body: str = Field(default="hello", max_length=10_000)


class FaultRequest(BaseModel):
    error_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    latency_ms: float = Field(default=0.0, ge=0.0, le=10_000)


class LoadRequest(BaseModel):
    n: int = Field(default=200, ge=1, le=5000)


class HealthResponse(BaseModel):
    status: str
    version: str
    window_requests: int
    slo_status: str
    fault_active: bool
