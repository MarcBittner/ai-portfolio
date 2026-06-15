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


class WarehouseScanRequest(BaseModel):
    # Run the warehouse governance scan. Optional `mode` pins the LLM routing tier.
    remediated: bool = False
    mode: str | None = None
    # Free-text column→PHI-type labels the BROWSER obtained from a host-local Ollama
    # (browser→host), keyed by "TABLE.COLUMN" → ["NAME","DOB",...]. The cloud server
    # can't reach your machine's Ollama; the browser can, so when this is supplied
    # the server uses these labels for the LLM-classified columns instead of calling
    # its own provider. Only the labels are trusted — the column set, masking policy,
    # k-anonymity, and control mapping all re-run server-side on the canonical schema.
    client_classify: dict[str, list[str]] | None = None
