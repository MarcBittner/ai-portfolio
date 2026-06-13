"""Request/response models for the HTTP API."""

from pydantic import BaseModel, Field

from agent_factory.spec import AgentSpec


class RunRequest(BaseModel):
    """Run a task. Provide a full ``spec`` (advanced), or a ``template`` name
    (simple), or neither (defaults to the 'assistant' template)."""

    task: str = Field(min_length=1, max_length=4000)
    template: str | None = None
    spec: AgentSpec | None = None


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    active_mode: str


class TemplateInfo(BaseModel):
    name: str
    description: str
    spec: AgentSpec
