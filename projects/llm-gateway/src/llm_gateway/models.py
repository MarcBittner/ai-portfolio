"""Request/response models for the API."""

from pydantic import BaseModel, Field


class CompleteRequest(BaseModel):
    prompt: str = Field(max_length=100_000)
    system: str = "You are a precise assistant."
    provider: str = "auto"
    model: str | None = None
    # Completion the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # this is supplied the server skips its own provider routing/call and runs the
    # FULL governance pipeline (output firewall + redaction + audit) around it.
    # Letting a cloud-hosted demo run a real local model. Other providers stay
    # server-side. Absent → behavior unchanged.
    client_completion: str | None = Field(default=None, max_length=100_000)


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
