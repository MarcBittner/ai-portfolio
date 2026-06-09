"""Request/response models for the API."""

from pydantic import BaseModel, Field


class TokenIO(BaseModel):
    text: str
    x: int
    y: int
    w: int
    h: int


class ProcessRequest(BaseModel):
    sample: str | None = None
    tokens: list[TokenIO] | None = None
    types: list[str] | None = None


class BoxOut(BaseModel):
    x: int
    y: int
    w: int
    h: int
    type: str


class FindingOut(BaseModel):
    type: str
    start: int
    end: int
    snippet: str


class ProcessResponse(BaseModel):
    text: str
    redacted_text: str
    tokens: list[TokenIO]            # ordered tokens used (for rendering)
    findings: list[FindingOut]
    boxes: list[BoxOut]
    counts: dict[str, int]


class SampleInfo(BaseModel):
    name: str
    tokens: list[TokenIO]


class OcrRequest(BaseModel):
    image_b64: str = Field(description="base64-encoded image bytes")


class HealthResponse(BaseModel):
    status: str
    version: str
    samples: int
    types: int
    ocr_backend: str  # "tesseract" if available, else "samples-only"
