"""Request/response models for the API."""

from pydantic import BaseModel, Field


class ClientLineItem(BaseModel):
    """One extracted row produced by the BROWSER running the user's host Ollama."""

    csi: str
    description: str
    quantity: float
    unit: str
    unit_cost: float
    total: float | None = None


class ClientExtraction(BaseModel):
    """Line items extracted by the BROWSER running the user's own host Ollama (the
    browser→host bridge). A cloud server can't reach a user's ``localhost:11434``,
    so for the local tier the browser runs the extractor and posts the rows back
    here instead of the server calling the model."""

    items: list[ClientLineItem]
    model: str = ""


class AnalyzeRequest(BaseModel):
    text: str | None = Field(default=None, max_length=100_000)
    sample: str | None = None       # name of a bundled sample (alternative to text)
    use_llm: bool = True            # try the LLM structured-output path first
    provider: str = "auto"
    model: str | None = None
    # When present, the browser already ran the extractor on the user's host
    # Ollama (browser→host); fold these rows in instead of calling the model.
    client_extraction: ClientExtraction | None = None


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class SampleInfo(BaseModel):
    name: str
    text: str


class HealthResponse(BaseModel):
    status: str
    version: str
    baseline_lines: int
    market_codes: int
    samples: int
    ollama: bool
