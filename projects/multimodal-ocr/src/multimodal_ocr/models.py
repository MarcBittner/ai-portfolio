"""Request/response models for the API."""

from pydantic import BaseModel, Field


class TokenIO(BaseModel):
    text: str
    x: int
    y: int
    w: int
    h: int


class NerEntity(BaseModel):
    type: str
    text: str


class ProcessRequest(BaseModel):
    sample: str | None = None
    tokens: list[TokenIO] | None = None
    types: list[str] | None = None
    use_llm: bool = True            # LLM NER over the OCR text (names/orgs)
    provider: str = "auto"
    model: str | None = None
    # NER entities the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # these are supplied the server skips its own LLM call and maps them to token
    # boxes — letting a cloud-hosted demo run a real local model. Other providers
    # stay server-side.
    client_ner: list[NerEntity] | None = None


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


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
    routing: RoutingInfo | None = None


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
    ollama: bool
