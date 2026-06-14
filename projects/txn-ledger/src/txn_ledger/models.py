"""Request/response models for the API."""

from pydantic import BaseModel, Field


class LoadRequest(BaseModel):
    n: int = Field(default=500, ge=1, le=20_000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    mode: str | None = None  # auto | paid | local | free | offline
    # SQL the BROWSER obtained from a host-local Ollama (browser→host). The cloud
    # server can't reach your machine's Ollama; the browser can, so when this is
    # supplied the server skips its own LLM *generation* call and uses this SQL —
    # but it is NEVER trusted: guard_sql() still runs on it before execution.
    # Other providers stay server-side. Absent → today's server-side behavior.
    client_sql: str | None = Field(default=None, max_length=4000)


class HealthResponse(BaseModel):
    status: str
    version: str
    rows: int
    committees: int
    cycles: int
