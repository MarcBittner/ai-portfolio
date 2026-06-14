"""Request/response models for the API."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    sources: int
    procedures: int
    total_rows: int


class AssistRequest(BaseModel):
    """A sample of an UNKNOWN-format price file to map to the canonical schema.

    ``sample`` is the raw text (a JSON array of objects, or delimited CSV/pipe/TSV
    with a header). With no ``sample``, the bundled unknown-format file is used.
    """

    sample: str | None = None
    hospital: str | None = None
    mode: str | None = None       # pin the routing tier: auto|paid|local|free|offline
    ingest: bool = True           # apply the mapping and load the rows into the store
    # Column→canonical mapping the BROWSER obtained from a host-local Ollama
    # (browser→host). The cloud server can't reach your machine's Ollama; the
    # browser can, so when this is supplied the server skips its own LLM call and
    # applies this mapping directly — letting a cloud-hosted demo run a real local
    # model. Other providers stay server-side.
    client_mapping: dict[str, str | None] | None = None
