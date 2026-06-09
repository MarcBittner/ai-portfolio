"""Request/response models for the API."""

from typing import Any

from pydantic import BaseModel, Field


class RunRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    use_llm: bool = True            # LLM planner first; rule planner fallback
    provider: str = "auto"
    model: str | None = None


class StepOut(BaseModel):
    thought: str
    tool: str
    args: dict[str, Any]
    observation: str
    ok: bool


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class RunResponse(BaseModel):
    query: str
    steps: list[StepOut]
    answer: str
    n_steps: int
    planner: str                    # "rule" or "llm"
    routing: RoutingInfo | None = None


class ToolInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    version: str
    tools: int
    ollama: bool
