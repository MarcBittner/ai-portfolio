"""Request/response models for the API."""

from pydantic import BaseModel


class AccessRequest(BaseModel):
    role: str = "analyst"
    record_id: str
    field: str
    purpose: str | None = None
    reidentify: bool = False


class HealthResponse(BaseModel):
    status: str
    version: str
    records: int
    roles: int
    audit_entries: int
