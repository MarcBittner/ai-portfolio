"""Request/response models for the API."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    surfaces: list[str]
    controls: int
    frameworks: int


class ReportRequest(BaseModel):
    # Generate the board/exec narrative for one surface's current (or remediated)
    # posture. Optional `mode` pins the LLM routing tier (auto|paid|local|free|offline).
    surface: str = "exposure"
    remediated: bool = False
    mode: str | None = None
    # Raw board-report text the BROWSER obtained from a host-local Ollama
    # (browser→host). The cloud server can't reach your machine's Ollama; the
    # browser can, so when this is supplied the server skips its own LLM call and
    # parses this instead — letting a cloud-hosted demo run a real local model.
    # Other providers stay server-side. The deterministic shape guard still runs.
    client_narrative: str | None = None
