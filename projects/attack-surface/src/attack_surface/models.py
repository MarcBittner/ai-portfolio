"""Request/response models for the API."""

from typing import Literal

from pydantic import BaseModel


class ScanRequest(BaseModel):
    domain: str | None = None
    mode: Literal["fixture", "live"] = "fixture"


class NarrativeRequest(BaseModel):
    # Generate the exec narrative for the current (or remediated) fixture report.
    # Optional `mode` pins the LLM routing tier (auto|paid|local|free|offline).
    remediated: bool = False
    mode: str | None = None
    # Narrative the BROWSER obtained from a host-local Ollama (browser→host). The
    # cloud server can't reach your machine's Ollama; the browser can, so when this
    # is supplied the server skips its own LLM call and uses it — letting a
    # cloud-hosted demo run a real local model. Other providers stay server-side.
    client_narrative: str | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    controls: int
    fixture_findings: int
