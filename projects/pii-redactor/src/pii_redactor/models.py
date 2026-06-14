"""Request/response models for the API."""

from pydantic import BaseModel, Field

MAX_TEXT = 100_000


class NerEntity(BaseModel):
    type: str
    text: str


class DetectRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    types: list[str] | None = None  # default: all supported types
    use_llm: bool = True            # Ollama-on by default; adds names/orgs/places
    provider: str = "auto"          # auto | ollama | openai | openrouter | mock
    model: str | None = None
    # NER entities the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # these are supplied the server skips its own LLM call and uses them — letting a
    # cloud-hosted demo run a real local model. Other providers stay server-side.
    client_ner: list[NerEntity] | None = None


class SpanOut(BaseModel):
    type: str
    start: int
    end: int
    source: str = "regex"           # "regex" or "llm"


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class DetectResponse(BaseModel):
    spans: list[SpanOut]
    counts: dict[str, int]
    total: int
    routing: RoutingInfo | None = None  # present when the LLM pass ran


class RedactRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    style: str = "token"
    types: list[str] | None = None
    use_llm: bool = True
    provider: str = "auto"
    model: str | None = None
    # browser→host Ollama NER (see DetectRequest)
    client_ner: list[NerEntity] | None = None


class RedactResponse(BaseModel):
    redacted: str
    counts: dict[str, int]
    total: int
    style: str
    routing: RoutingInfo | None = None


class TypeInfo(BaseModel):
    name: str
    description: str
    source: str = "regex"


class HealthResponse(BaseModel):
    status: str
    version: str
    types: int
    styles: list[str]
    ollama: bool
