"""FastAPI service: evaluate / gate / compare (+ optional LLM-judge) and the UI.

Deterministic metrics need no model. The optional ``llm_judge`` metric routes
through the multi-provider router (Ollama by default) with a deterministic
fallback, so it's always defined.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from evalkit import __version__, llm
from evalkit.evaluate import compare, evaluate, gate
from evalkit.judge import JUDGE_NAME, judge
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
    RoutingInfo,
)

STATIC_DIR = Path(__file__).parent / "static"
ALL_METRICS = list(METRIC_NAMES) + [JUDGE_NAME]
VALID_PROVIDERS = ("auto", *llm.PROVIDERS)

app = FastAPI(
    title="evalkit",
    version=__version__,
    description="Deterministic, offline-first LLM evaluation toolkit.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          metrics=len(ALL_METRICS), ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/metrics", response_model=list[MetricInfo])
def list_metrics() -> list[MetricInfo]:
    out = [MetricInfo(name=n, description=METRICS[n][1]) for n in METRIC_NAMES]
    out.append(MetricInfo(name=JUDGE_NAME, source="llm",
                          description="LLM 'is this correct?' grade (Ollama→fallback)"))
    return out


@app.post("/evaluate", response_model=EvaluateResponse)
def run_evaluate(request: EvaluateRequest) -> EvaluateResponse:
    metrics = request.metrics or list(METRIC_NAMES)
    unknown = [m for m in metrics if m not in ALL_METRICS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown metrics: {unknown}")
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail="unknown provider")

    det_metrics = [m for m in metrics if m in METRIC_NAMES]
    pairs = [(it.prediction, it.reference) for it in request.items]
    if det_metrics:
        per_item, aggregate = evaluate(pairs, det_metrics)
    else:
        per_item, aggregate = [{} for _ in pairs], {}

    routing = None
    if JUDGE_NAME in metrics:
        scores = []
        for (pred, ref), row in zip(pairs, per_item, strict=True):
            s, result = judge(pred, ref, request.provider, request.model)
            row[JUDGE_NAME] = s
            scores.append(s)
            routing = RoutingInfo(provider=result.provider, model=result.model,
                                  fallbacks=result.fallbacks)
        aggregate[JUDGE_NAME] = round(sum(scores) / len(scores), 4) if scores else 0.0

    gate_result = None
    if request.thresholds:
        bad = [m for m in request.thresholds if m not in ALL_METRICS]
        if bad:
            raise HTTPException(status_code=422, detail=f"unknown gate metrics: {bad}")
        passed, failures = gate(aggregate, request.thresholds)
        gate_result = GateResult(passed=passed, failures=failures)

    return EvaluateResponse(
        n=len(per_item), metrics=metrics,
        per_item=[ItemResult(index=i, scores=s) for i, s in enumerate(per_item)],
        aggregate=aggregate, gate=gate_result, routing=routing,
    )


@app.post("/compare", response_model=CompareResponse)
def run_compare(request: CompareRequest) -> CompareResponse:
    return CompareResponse(comparison=compare(request.baseline, request.candidate))


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
