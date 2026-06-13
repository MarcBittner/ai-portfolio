"""FastAPI service: an instrumented outreach API with RED metrics, SLOs + error
budgets, traces, and an on-demand incident (fault injection) to burn and recover
the budget. The dashboard at ``/`` visualizes it. Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse

from slo_kit import __version__, incident, llm, service, slo
from slo_kit.metrics import registry
from slo_kit.models import (
    FaultRequest,
    HealthResponse,
    IncidentRequest,
    LoadRequest,
    SendRequest,
)
from slo_kit.tracing import tracer

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="slo-kit",
    version=__version__,
    description="Instrumented reference service — RED metrics, SLOs, error budgets.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    snap = registry.snapshot()
    return HealthResponse(
        status="ok", version=__version__, window_requests=snap["total"],
        slo_status=slo.compute(snap)["overall_status"],
        fault_active=(service.fault.error_rate > 0 or service.fault.latency_ms > 0),
    )


# ---- the instrumented "business" API -----------------------------------------

@app.post("/v1/messages")
def send(req: SendRequest) -> JSONResponse:
    status, payload = service.send_message(req.channel, req.to, req.body)
    return JSONResponse(content=payload, status_code=status)


@app.get("/v1/messages")
def messages() -> dict:
    return {"sent": service.outbox()}


# ---- observability surfaces --------------------------------------------------

@app.get("/metrics")
def metrics() -> PlainTextResponse:
    return PlainTextResponse(registry.prometheus())


@app.get("/metrics/snapshot")
def metrics_snapshot() -> dict:
    return registry.snapshot()


@app.get("/slo")
def slo_status() -> dict:
    return slo.compute(registry.snapshot())


@app.get("/traces")
def traces(limit: int = 25) -> dict:
    return {"spans": tracer.recent(limit)}


# ---- on-call: compress telemetry into an incident summary (LLM) --------------

@app.post("/incident/summary")
def incident_summary(req: IncidentRequest) -> dict:
    """Compress the current SLO snapshot + error spans into an on-call incident
    summary, a deterministically-classified severity, and the matching runbook
    steps. Routes through the LLM chain; the offline drafter is the terminal,
    zero-key fallback."""
    return incident.summarize(mode=req.mode)


@app.get("/evals")
def evals() -> dict:
    """Score the incident-summary generator (severity/situation accuracy) over a
    set of labeled snapshots, computed from the deterministic SLO math."""
    return incident.evaluate()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


# ---- operator controls (the incident demo) -----------------------------------

@app.post("/admin/fault")
def admin_fault(req: FaultRequest) -> dict:
    f = service.set_fault(req.error_rate, req.latency_ms)
    return {"fault": {"error_rate": f.error_rate, "latency_ms": f.latency_ms},
            "slo": slo.compute(registry.snapshot())}


@app.post("/admin/loadtest")
def admin_loadtest(req: LoadRequest) -> dict:
    return service.loadtest(req.n)


@app.post("/admin/reset")
def admin_reset() -> dict:
    service.reset()
    return {"reset": True, "slo": slo.compute(registry.snapshot())}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
