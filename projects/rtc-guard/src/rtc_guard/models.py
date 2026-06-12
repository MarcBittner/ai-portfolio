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


class HealthResponse(BaseModel):
    status: str
    version: str
    templates: int
    threats: int
