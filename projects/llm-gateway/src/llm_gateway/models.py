"""Request/response models for the API."""

from pydantic import BaseModel, Field


class CompleteRequest(BaseModel):
    prompt: str = Field(max_length=100_000)
    system: str = "You are a precise assistant."
    provider: str = "auto"
    model: str | None = None


class ExtractRequest(BaseModel):
    text: str = Field(max_length=100_000)
    instruction: str = "Extract the key fields as a JSON object."
    provider: str = "auto"
    model: str | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    providers: int
    audit_entries: int
    policy_layers: int
    ollama: bool
