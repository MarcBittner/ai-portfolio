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


class LogEntry(BaseModel):
    """One structured log line pushed to the ingestion endpoint."""

    ts: float | None = None
    level: str = "info"  # debug | info | warn | error (coerced to 'info' if other)
    source: str | None = None
    message: str = Field(min_length=1, max_length=8000)
    meta: dict | None = None


class LogIngestRequest(BaseModel):
    """Batch of log entries for one target slug (token- or loopback-authenticated)."""

    slug: str
    entries: list[LogEntry] = Field(default_factory=list)


class QualityIngestRequest(BaseModel):
    """One code-quality result pushed from CI (token- or loopback-authenticated).

    The caller supplies raw measurements only; vigil derives the letter ``grade``
    deterministically (see ``quality.derive_grade``) — the grade is never accepted
    from the caller."""

    slug: str
    commit_sha: str | None = None
    lint_errors: int = Field(default=0, ge=0)
    tests_passed: int = Field(default=0, ge=0)
    tests_failed: int = Field(default=0, ge=0)
    coverage_pct: float | None = Field(default=None, ge=0, le=100)
    complexity: float | None = None
    raw: dict | None = None


class RepoScanIngestRequest(BaseModel):
    """A CI-pushed repo secret-scan result (the secretscan finding shape), keyed by
    commit, used by the live fleet where vigil has no local checkout."""

    slug: str
    commit_sha: str | None = None
    findings: list[dict] = Field(default_factory=list)


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
