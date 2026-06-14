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


class IncidentRequest(BaseModel):
    # None → summarize the live state; pin a routing tier with `mode`.
    mode: str | None = Field(
        default=None, description="auto | paid | local | free | offline")
    # Summary prose the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # this is supplied the server skips its own LLM call and uses it as the summary
    # narrative — letting a cloud-hosted demo run a real local model. Severity is
    # still classified deterministically. Other providers stay server-side.
    client_summary: str | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    window_requests: int
    slo_status: str
    fault_active: bool
