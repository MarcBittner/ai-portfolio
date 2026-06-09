"""FastAPI service: evaluate predictions, gate, compare — and serve the UI.

Stateless and fully offline (deterministic metrics; no model, no network, no
secrets). The single-page UI at ``/`` calls these endpoints.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from evalkit import __version__
from evalkit.evaluate import compare, evaluate, gate
from evalkit.metrics import METRIC_NAMES, METRICS
from evalkit.models import (
    CompareRequest,
    CompareResponse,
    EvaluateRequest,
    EvaluateResponse,
    GateResult,
    HealthResponse,
    ItemResult,
    MetricInfo,
)

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="evalkit",
    version=__version__,
    description="Deterministic, offline-first LLM evaluation toolkit.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, metrics=len(METRIC_NAMES))


@app.get("/metrics", response_model=list[MetricInfo])
def list_metrics() -> list[MetricInfo]:
    return [MetricInfo(name=n, description=METRICS[n][1]) for n in METRIC_NAMES]


@app.post("/evaluate", response_model=EvaluateResponse)
def run_evaluate(request: EvaluateRequest) -> EvaluateResponse:
    try:
        pairs = [(it.prediction, it.reference) for it in request.items]
        per_item, aggregate = evaluate(pairs, request.metrics)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    gate_result = None
    if request.thresholds:
        unknown = [m for m in request.thresholds if m not in METRIC_NAMES]
        if unknown:
            raise HTTPException(
                status_code=422, detail=f"unknown gate metrics: {unknown}"
            )
        passed, failures = gate(aggregate, request.thresholds)
        gate_result = GateResult(passed=passed, failures=failures)

    metrics = list(aggregate.keys())
    return EvaluateResponse(
        n=len(per_item),
        metrics=metrics,
        per_item=[ItemResult(index=i, scores=s) for i, s in enumerate(per_item)],
        aggregate=aggregate,
        gate=gate_result,
    )


@app.post("/compare", response_model=CompareResponse)
def run_compare(request: CompareRequest) -> CompareResponse:
    return CompareResponse(comparison=compare(request.baseline, request.candidate))


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
