"""Request/response models for the API."""

from pydantic import BaseModel


class ClassifyRequest(BaseModel):
    mode: str | None = None  # auto | paid | local | free | offline


class ScanRequest(BaseModel):
    mode: str | None = None
    narrative: bool = False


class HealthResponse(BaseModel):
    status: str
    version: str
    tables: int
    columns: int
    sensitive_columns: int
