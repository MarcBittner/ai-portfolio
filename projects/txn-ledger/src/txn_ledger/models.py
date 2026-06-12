"""Request/response models for the API."""

from pydantic import BaseModel, Field


class LoadRequest(BaseModel):
    n: int = Field(default=500, ge=1, le=20_000)


class HealthResponse(BaseModel):
    status: str
    version: str
    rows: int
    committees: int
    cycles: int
