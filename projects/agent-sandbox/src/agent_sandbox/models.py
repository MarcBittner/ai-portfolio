"""Request/response models for the API."""

from typing import Any

from pydantic import BaseModel, Field


class RunRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)


class StepOut(BaseModel):
    thought: str
    tool: str
    args: dict[str, Any]
    observation: str
    ok: bool


class RunResponse(BaseModel):
    query: str
    steps: list[StepOut]
    answer: str
    n_steps: int


class ToolInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    version: str
    tools: int
