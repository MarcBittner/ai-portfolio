"""Request/response models for the API."""

from pydantic import BaseModel


class AccessRequest(BaseModel):
    role: str = "analyst"
    record_id: str
    field: str
    purpose: str | None = None
    reidentify: bool = False


class ClientSpan(BaseModel):
    text: str
    type: str


class NoteRequest(BaseModel):
    note: str | None = None       # raw note text, or…
    record_id: str | None = None  # …a record whose intake note to scrub
    mode: str | None = None       # auto | paid | local | free | offline
    # PHI spans the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # these are supplied the server skips its own LLM call and uses them — letting a
    # cloud-hosted demo run a real local model. Other providers stay server-side.
    client_spans: list[ClientSpan] | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    records: int
    roles: int
    audit_entries: int
