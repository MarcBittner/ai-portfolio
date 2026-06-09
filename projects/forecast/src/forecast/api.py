"""FastAPI service: forecasting + anomaly detection, and the chart UI.

Stateless, fully offline (classic stats in pure Python; no model, no network).
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from forecast import __version__
from forecast.anomaly import detect
from forecast.forecast import forecast
from forecast.methods import METHOD_NAMES
from forecast.models import (
    AnomalyRequest,
    AnomalyResponse,
    ForecastRequest,
    ForecastResponse,
    HealthResponse,
    MethodInfo,
)

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="forecast",
    version=__version__,
    description="Classic-ML time-series forecasting and anomaly detection.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, methods=len(METHOD_NAMES))


@app.get("/methods", response_model=list[MethodInfo])
def list_methods() -> list[MethodInfo]:
    return [MethodInfo(name="auto")] + [MethodInfo(name=m) for m in METHOD_NAMES]


@app.post("/forecast", response_model=ForecastResponse)
def run_forecast(request: ForecastRequest) -> ForecastResponse:
    params = {
        k: v for k, v in (("alpha", request.alpha), ("beta", request.beta),
                          ("season_period", request.season_period)) if v is not None
    }
    try:
        result = forecast(request.series, request.horizon, request.method, **params)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ForecastResponse(**result)


@app.post("/anomalies", response_model=AnomalyResponse)
def run_anomalies(request: AnomalyRequest) -> AnomalyResponse:
    found = detect(request.series, request.window, request.threshold)
    return AnomalyResponse(window=request.window, threshold=request.threshold,
                           anomalies=found)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
