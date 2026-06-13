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
