"""Request/response models for the API."""

from pydantic import BaseModel


class ScaffoldRequest(BaseModel):
    # Either a free-text description (the LLM/offline parser extracts the spec)…
    description: str | None = None
    # …or an explicit spec (skips extraction, goes straight to templating).
    name: str | None = None
    language: str | None = None
    needs_db: bool | None = None
    exposes_http: bool | None = None
    mode: str | None = None  # auto | paid | local | free | offline
    onboard: bool = False    # also add the service to the paved-road catalog


class IngestRequest(BaseModel):
    # Optional inline rate file (list of row dicts). Omit to use the bundled
    # synthetic machine-readable rate file.
    rows: list[dict] | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    catalog: int       # services on the paved road
    modules: int       # reusable terraform modules the platform provides
