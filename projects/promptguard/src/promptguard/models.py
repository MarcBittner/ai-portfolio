"""Request/response models for the API."""

from typing import Literal

from pydantic import BaseModel, Field


class ClientClassification(BaseModel):
    """The LLM injection verdict produced by the BROWSER running the user's own
    host Ollama (the browser→host bridge). A cloud server can't reach a user's
    ``localhost:11434``, so for the local tier the browser runs the classifier and
    posts the verdict back here instead of the server calling the model."""

    injection: bool
    reason: str = Field(default="", max_length=400)
    model: str = ""


class ScanRequest(BaseModel):
    text: str = Field(max_length=100_000)
    direction: Literal["input", "output", "both"] = "both"
    use_llm: bool = True            # add the LLM semantic classifier
    provider: str = "auto"
    model: str | None = None
    # When present, the browser already ran the classifier on the user's host
    # Ollama (browser→host); fold this verdict in instead of calling the model.
    client_classification: ClientClassification | None = None


class FindingOut(BaseModel):
    rule_id: str
    category: str
    severity: str
    start: int
    end: int
    snippet: str


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class ScanResponse(BaseModel):
    verdict: Literal["allow", "flag", "block"]
    score: float
    direction: str
    findings: list[FindingOut]
    counts: dict[str, int]
    routing: RoutingInfo | None = None


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
    ollama: bool
