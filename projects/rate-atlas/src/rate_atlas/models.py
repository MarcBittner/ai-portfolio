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
