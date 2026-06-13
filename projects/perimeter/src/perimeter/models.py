"""Request/response models for the API."""

from pydantic import BaseModel


class ReportRequest(BaseModel):
    # Generate the board/exec narrative for the current (or remediated) estate.
    # Optional `mode` pins the LLM routing tier (auto|paid|local|free|offline).
    remediated: bool = False
    mode: str | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    controls: int
    frameworks: int
    exposures: int
    grade: str
