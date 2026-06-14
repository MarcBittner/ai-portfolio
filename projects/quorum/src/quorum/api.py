"""FastAPI service for the governed multi-agent orchestrator.

Endpoints run declarative workflow specs through the same governed engine, expose
the full agent trace + tamper-evident audit per run, and report the routing tier
each step used. Stateless modeling, in-memory run store; no real data; no secrets.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from quorum import __version__, evaluate, llm
from quorum.data import RISK_LABELS, contract_text, contracts, get_contract
from quorum.models import HealthResponse, PlanRequest, ReviewRequest, RunRequest
from quorum.orchestrator import Orchestrator, RunResult, plan_prompts
from quorum.workflows import get_spec, registry, tally_risks

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="quorum",
    version=__version__,
    description="Vendor-neutral, governed multi-agent orchestration.",
)

# In-memory run store so GET /trace/{run_id} can return the trace + audit.
_RUNS: dict[str, RunResult] = {}
_RUN_ORDER: list[str] = []
_MAX_RUNS = 50


def _store(rr: RunResult) -> None:
    _RUNS[rr.run_id] = rr
    _RUN_ORDER.append(rr.run_id)
    while len(_RUN_ORDER) > _MAX_RUNS:
        _RUNS.pop(_RUN_ORDER.pop(0), None)


def _trace_json(rr: RunResult) -> list[dict]:
    return [asdict(s) for s in rr.trace]


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          workflows=len(registry()), contracts=len(contracts()))


@app.get("/workflows")
def workflows() -> dict:
    return {"workflows": [
        {"name": s.name, "description": s.description, "steps": s.step_names()}
        for s in registry().values()
    ]}


@app.get("/contracts")
def list_contracts() -> dict:
    return {"contracts": [
        {"id": c["id"], "title": c["title"], "clauses": len(c["clauses"])}
        for c in contracts()
    ]}


@app.get("/contracts/{contract_id}")
def get_contract_route(contract_id: str) -> JSONResponse:
    c = get_contract(contract_id)
    if c is None:
        return JSONResponse({"error": "unknown contract"}, status_code=404)
    return JSONResponse(c)


@app.post("/review")
def review(req: ReviewRequest) -> JSONResponse:
    """Run the contract-review workflow on a supplied or selected document."""
    text = req.text
    if text is None and req.contract_id is not None:
        c = get_contract(req.contract_id)
        if c is None:
            return JSONResponse({"error": "unknown contract_id"}, status_code=404)
        text = contract_text(c)
    if not text:
        return JSONResponse({"error": "provide 'text' or a known 'contract_id'"},
                            status_code=400)
    spec = get_spec("contract-review")
    rr = Orchestrator().run(spec, {"text": text}, mode=req.mode,
                            client_completions=req.client_completions,
                            client_model=req.client_model)
    _store(rr)
    tally = tally_risks({s.step: s.output for s in rr.trace})
    return JSONResponse({
        "run_id": rr.run_id,
        "workflow": rr.workflow,
        "risk_report": {
            "flagged": [
                {**f, "risk_label": RISK_LABELS.get(f.get("risk_class", ""), "")}
                for f in tally["flagged"]
            ],
            "by_class": tally["by_class"],
            "count": tally["count"],
        },
        "exec_summary": rr.result.get("summary", ""),
        "redlines": rr.result.get("redlines", []),
        "rollup": rr.rollup,
        "audit_verified": rr.audit_verified,
        "trace": _trace_json(rr),
    })


@app.post("/run")
def run_workflow(req: RunRequest) -> JSONResponse:
    """Run any named workflow spec through the same governed engine."""
    spec = get_spec(req.workflow)
    if spec is None:
        return JSONResponse(
            {"error": f"unknown workflow '{req.workflow}'",
             "available": list(registry())}, status_code=404)
    rr = Orchestrator().run(spec, req.payload, mode=req.mode,
                            client_completions=req.client_completions,
                            client_model=req.client_model)
    _store(rr)
    return JSONResponse({
        "run_id": rr.run_id, "workflow": rr.workflow, "result": rr.result,
        "rollup": rr.rollup, "audit_verified": rr.audit_verified,
        "trace": _trace_json(rr),
    })


@app.post("/plan")
def plan(req: PlanRequest) -> JSONResponse:
    """Resolve each agent step's redacted {system, user} prompt for a run.

    The browser calls this for a local/auto run with host Ollama reachable, runs
    each returned prompt against the user's host Ollama (browser→host), then submits
    the completions to /run or /review as ``client_completions``. Orchestration and
    governance stay server-side; the returned prompts are already PII-redacted.
    """
    spec = get_spec(req.workflow)
    if spec is None:
        return JSONResponse(
            {"error": f"unknown workflow '{req.workflow}'",
             "available": list(registry())}, status_code=404)
    return JSONResponse({
        "workflow": spec.name,
        "steps": plan_prompts(spec, req.payload),
    })


@app.get("/trace/{run_id}")
def trace(run_id: str) -> JSONResponse:
    """The full agent trace + tamper-evident audit for a run."""
    rr = _RUNS.get(run_id)
    if rr is None:
        return JSONResponse({"error": "unknown run_id"}, status_code=404)
    return JSONResponse({
        "run_id": rr.run_id, "workflow": rr.workflow,
        "trace": _trace_json(rr), "audit": rr.audit,
        "audit_verified": rr.audit_verified, "rollup": rr.rollup,
    })


@app.get("/evals")
def evals() -> dict:
    """Score contract-review over the labeled set + the governance assertion."""
    return evaluate.run()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
