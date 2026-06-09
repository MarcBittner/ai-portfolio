"""Request/response models for the API."""

from typing import Literal

from pydantic import BaseModel, Field


class ScanRequest(BaseModel):
    text: str = Field(max_length=100_000)
    direction: Literal["input", "output", "both"] = "both"


class FindingOut(BaseModel):
    rule_id: str
    category: str
    severity: str
    start: int
    end: int
    snippet: str


class ScanResponse(BaseModel):
    verdict: Literal["allow", "flag", "block"]
    score: float
    direction: str
    findings: list[FindingOut]
    counts: dict[str, int]


class RuleInfo(BaseModel):
    id: str
    category: str
    severity: str
    applies_to: str
    description: str


class HealthResponse(BaseModel):
    status: str
    version: str
    rules: int
