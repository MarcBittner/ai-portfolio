"""Request/response models for the API."""

from pydantic import BaseModel, Field


class LoadRequest(BaseModel):
    n: int = Field(default=500, ge=1, le=20_000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    mode: str | None = None  # auto | paid | local | free | offline


class HealthResponse(BaseModel):
    status: str
    version: str
    rows: int
    committees: int
    cycles: int
