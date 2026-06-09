"""Request/response models for the API."""

from pydantic import BaseModel, Field

MAX_TEXT = 100_000


class DetectRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    types: list[str] | None = None  # default: all supported types


class SpanOut(BaseModel):
    type: str
    start: int
    end: int


class DetectResponse(BaseModel):
    spans: list[SpanOut]
    counts: dict[str, int]
    total: int


class RedactRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    style: str = "token"
    types: list[str] | None = None


class RedactResponse(BaseModel):
    redacted: str
    counts: dict[str, int]
    total: int
    style: str


class TypeInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    version: str
    types: int
    styles: list[str]
