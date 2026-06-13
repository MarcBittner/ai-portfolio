"""Request/response models for the API."""

from pydantic import BaseModel


class AccessRequest(BaseModel):
    role: str = "analyst"
    record_id: str
    field: str
    purpose: str | None = None
    reidentify: bool = False


class NoteRequest(BaseModel):
    note: str | None = None       # raw note text, or…
    record_id: str | None = None  # …a record whose intake note to scrub
    mode: str | None = None       # auto | paid | local | free | offline


class HealthResponse(BaseModel):
    status: str
    version: str
    records: int
    roles: int
    audit_entries: int
