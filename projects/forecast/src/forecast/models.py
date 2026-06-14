"""Request/response models for the API."""

from pydantic import BaseModel, Field


class ForecastRequest(BaseModel):
    series: list[float] = Field(min_length=2, max_length=10_000)
    horizon: int = Field(default=5, ge=1, le=200)
    method: str = "auto"
    alpha: float | None = Field(default=None, ge=0.0, le=1.0)
    beta: float | None = Field(default=None, ge=0.0, le=1.0)
    season_period: int | None = Field(default=None, ge=1, le=1000)
    use_llm: bool = True            # natural-language summary via the router
    provider: str = "auto"
    model: str | None = None
    # Narrative the BROWSER obtained from a host-local Ollama (browser→host).
    # The cloud server can't reach your machine's Ollama; the browser can, so when
    # this is supplied the server skips its own LLM call and uses it as the summary —
    # letting a cloud-hosted demo narrate with a real local model. The deterministic
    # forecast/anomaly math is unaffected. Other providers stay server-side.
    client_narrative: str | None = None


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class ForecastResponse(BaseModel):
    method: str
    forecast: list[float]
    lower: list[float]
    upper: list[float]
    fitted: list[float | None]
    backtest: dict[str, float] | None
    rolling_backtest: dict[str, float] | None = None
    season_period: int = 0
    summary: str | None = None
    routing: RoutingInfo | None = None


class AnomalyRequest(BaseModel):
    series: list[float] = Field(min_length=1, max_length=10_000)
    window: int = Field(default=8, ge=2, le=1000)
    threshold: float = Field(default=3.0, gt=0.0)


class AnomalyPoint(BaseModel):
    index: int
    value: float
    zscore: float


class AnomalyResponse(BaseModel):
    window: int
    threshold: float
    anomalies: list[AnomalyPoint]


class MethodInfo(BaseModel):
    name: str


class HealthResponse(BaseModel):
    status: str
    version: str
    methods: int
    ollama: bool
