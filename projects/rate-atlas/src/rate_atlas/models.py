"""Response models for the API."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    sources: int
    procedures: int
    total_rows: int
