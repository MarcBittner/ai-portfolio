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


class ToolRequest(BaseModel):
    # One ReAct step executed server-side. When the browser drives the loop
    # (planner LLM ran browser→host on the user's Ollama), it picks the tool and
    # args, but the deterministic tool itself ALWAYS runs here with its existing
    # safety (whitelisted AST eval, etc.) — browser input is never trusted to run.
    name: str = Field(min_length=1, max_length=64)
    args: dict[str, Any] = Field(default_factory=dict)


class ToolResponse(BaseModel):
    name: str
    observation: str
    ok: bool


class HealthResponse(BaseModel):
    status: str
    version: str
    tools: int
    ollama: bool
