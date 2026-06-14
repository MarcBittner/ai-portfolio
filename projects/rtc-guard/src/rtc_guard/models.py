"""Request/response models for the API."""

from pydantic import BaseModel, Field


class TokenRequest(BaseModel):
    identity: str = "alice"
    room: str = "room-a"
    template: str = "viewer"
    ttl: int = Field(default=300, ge=1, le=86_400)


class VerifyRequest(BaseModel):
    token: str
    expected_room: str | None = None


class ClientAudit(BaseModel):
    """The LLM narration a BROWSER obtained from a host-local Ollama (browser→host).

    The cloud server can't reach your machine's Ollama; the browser can, so when
    this is supplied the server skips its own LLM call and uses this explanation
    as the narration — letting a cloud-hosted demo run a real local model. The
    deterministic rule findings still run server-side; the LLM only narrates.
    Other providers stay server-side.
    """

    explanation: str = ""


class GrantAuditRequest(BaseModel):
    """A proposed real-time token grant to audit against least privilege."""

    identity: str = "alice"
    room: str = "room-a"
    role: str = "viewer"
    ttl: int = Field(default=300, ge=0, le=604_800)
    roomJoin: bool = True
    canSubscribe: bool = True
    canPublish: bool = False
    canPublishData: bool = False
    mode: str | None = None  # auto | paid | local | free | offline
    # browser→host Ollama narration (see ClientAudit); when present the server
    # skips its own LLM call and uses this explanation.
    client_audit: ClientAudit | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    templates: int
    threats: int
