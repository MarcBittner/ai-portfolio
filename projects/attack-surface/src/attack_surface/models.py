"""Request/response models for the API."""

from typing import Literal

from pydantic import BaseModel


class ScanRequest(BaseModel):
    domain: str | None = None
    mode: Literal["fixture", "live"] = "fixture"


class HealthResponse(BaseModel):
    status: str
    version: str
    controls: int
    fixture_findings: int
