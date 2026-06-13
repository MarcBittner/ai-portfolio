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


class HealthResponse(BaseModel):
    status: str
    version: str
    templates: int
    threats: int
