"""Request/response models for the API."""

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    text: str | None = Field(default=None, max_length=100_000)
    sample: str | None = None       # name of a bundled sample (alternative to text)
    use_llm: bool = True            # try the LLM structured-output path first
    provider: str = "auto"
    model: str | None = None


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
