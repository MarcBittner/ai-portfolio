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
    model: str | None = None  # optional model override (informational/echoed)
    onboard: bool = False    # also add the service to the paved-road catalog
    # ServiceSpec the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # this is supplied (mode local/auto + host Ollama reachable) the server skips
    # its own LLM call and uses this spec instead — letting a cloud-hosted demo run
    # a real local model. It is NOT trusted raw: the server re-validates/normalizes
    # it through the exact same path as the LLM's own spec output. Other providers
    # stay server-side. Shape: {name, language, needs_db, exposes_http}.
    client_spec: dict | None = None


class IngestRequest(BaseModel):
    # Optional inline rate file (list of row dicts). Omit to use the bundled
    # synthetic machine-readable rate file.
    rows: list[dict] | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    catalog: int       # services on the paved road
    modules: int       # reusable terraform modules the platform provides
