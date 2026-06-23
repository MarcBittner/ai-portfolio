"""Pydantic request/response models for the vigil API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    version: str
    targets: int
    poller_running: bool


class SignupRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)


class LoginRequest(BaseModel):
    email: str
    password: str


class TargetRequest(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,48}$")
    name: str
    url: str
    health_path: str = "/health"
    repo: str | None = None
    tags: list[str] = Field(default_factory=list)


class RoleRequest(BaseModel):
    email: str
    role: str  # registered | elevated | admin


class AlertRuleRequest(BaseModel):
    slug: str
    metric: str  # availability | error_rate | response_ms | down
    comparator: str = "gt"  # lt | gt
    threshold: float = 0
    channel: str = "console"  # console | email | sms | webhook
    target_addr: str | None = None


class IncidentRequest(BaseModel):
    mode: str | None = None
    client_summary: str | None = None


class CheckRequest(BaseModel):
    """Create a synthetic check. ``assertions`` is a list of assertion dicts (shape
    validated in the handler against ``checks.ASSERTION_TYPES``)."""

    slug: str
    name: str = Field(min_length=1, max_length=80)
    method: str = "GET"
    path: str = "/health"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    assertions: list[dict] = Field(default_factory=list)
    required: bool = True
    enabled: bool = True


class CheckUpdateRequest(BaseModel):
    """PATCH a check — every field optional; only provided fields are applied."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    method: str | None = None
    path: str | None = None
    headers: dict[str, str] | None = None
    body: str | None = None
    assertions: list[dict] | None = None
    required: bool | None = None
    enabled: bool | None = None
