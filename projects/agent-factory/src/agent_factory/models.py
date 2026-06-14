"""Request/response models for the HTTP API."""

from typing import Any

from pydantic import BaseModel, Field

from agent_factory.spec import AgentSpec


class RunRequest(BaseModel):
    """Run a task. Provide a full ``spec`` (advanced), or a ``template`` name
    (simple), or neither (defaults to the 'assistant' template)."""

    task: str = Field(min_length=1, max_length=4000)
    template: str | None = None
    spec: AgentSpec | None = None


class ToolRequest(BaseModel):
    """Execute a single deterministic tool server-side.

    The browser→host Ollama bridge runs the agent's LLM *reasoning* on the
    user's local Ollama, but tool execution is never trusted to the browser:
    each step is dispatched here so the allowlist, argument validation, and the
    sandboxed implementations all stay server-side. ``tools`` is the agent's
    allowlist (the server refuses anything outside it); ``args`` is the
    LLM-proposed call, validated against the real tool signature."""

    tool: str = Field(min_length=1, max_length=60)
    args: dict[str, Any] = Field(default_factory=dict)
    tools: list[str] | None = None  # allowlist; None = the full catalog


class ToolResponse(BaseModel):
    tool: str
    args: dict[str, Any]
    observation: str
    ok: bool


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    active_mode: str


class TemplateInfo(BaseModel):
    name: str
    description: str
    spec: AgentSpec
