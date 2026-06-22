"""FastAPI service: grounded, verified Q&A + a human-approval action queue.

Endpoints (all stateless except the in-memory approval queue; no secrets):

  GET  /health                  liveness + dataset/queue counts
  GET  /llm                     which providers are reachable + active mode
  GET  /dataset                 PII-free dataset summary (counts only)
  GET  /examples                the guided-demo question set
  POST /ask                     guardrail → retrieve → compute → narrate → verify
  GET  /proposals               the approval queue (optionally ?status=pending)
  POST /propose                 build a typed, code-derived action proposal
  POST /decide                  approve (→ deterministic simulated apply) / decline
  GET  /diagnostics             cross-routing-mode benchmark over example questions
  GET  /                        the static SPA

The trust boundary: /ask never executes anything; /propose only *queues* a typed
proposal; only /decide with approve=true applies it — and the apply is simulated
(it never mutates the ground-truth dataset). The model proposes; a human approves.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from counsel import __version__, agent, approvals, data, diagnostics, llm
from counsel.approvals import ACTION_KINDS, QUEUE
from counsel.models import (
    AskRequest,
    AskResponse,
    DecideRequest,
    HealthResponse,
    ProposeRequest,
)

STATIC_DIR = Path(__file__).parent / "static"
VALID_MODES = set(llm.MODES)

app = FastAPI(
    title="counsel",
    version=__version__,
    description=("Grounded, trust-gated personal-finance copilot — code decides "
                 "the numbers, the LLM narrates, actions need human approval."),
)

DS = data.build_dataset()  # the deterministic ground truth, built once at startup


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__,
        accounts=len(DS.accounts), transactions=len(DS.transactions),
        pending_proposals=len(QUEUE.list(status="pending")),
        offline_fallback=True,
    )


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/dataset")
def dataset() -> dict:
    """PII-free summary: counts + categories + the demo's anchor date. No records."""
    return data.summary(DS)


@app.get("/examples")
def examples() -> dict:
    """The guided-demo question set (grounded, ungrounded, and guardrail asks)."""
    return {"examples": diagnostics.EXAMPLES}


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    if req.mode is not None and req.mode not in VALID_MODES:
        raise HTTPException(status_code=422, detail="unknown mode")
    result = agent.answer(DS, req.question, mode=req.mode)
    return AskResponse(**result.to_dict())


@app.get("/proposals")
def proposals(status: str | None = None) -> dict:
    if status is not None and status not in ("pending", "approved", "applied",
                                             "declined"):
        raise HTTPException(status_code=422, detail="unknown status")
    return {"proposals": [p.to_dict() for p in QUEUE.list(status=status)],
            "action_kinds": list(ACTION_KINDS)}


@app.post("/propose")
def propose(req: ProposeRequest) -> dict:
    """Build a typed, code-derived proposal and queue it as PENDING.

    The proposal content (numbers, rationale, citations) is computed by code from
    the dataset — the model never authors it. Nothing is applied here.
    """
    if req.kind not in ACTION_KINDS:
        raise HTTPException(status_code=422, detail="unknown action kind")
    built = approvals.build(req.kind, DS) if req.kind != "set_budget" else \
        approvals.build_set_budget(DS, req.category)
    if built is None:
        raise HTTPException(status_code=409,
                            detail="no proposal applies to the current records")
    kind, title, rationale, params, cites = built
    p = QUEUE.propose(kind, title, rationale, params, cites)
    return {"proposal": p.to_dict()}


@app.post("/decide")
def decide(req: DecideRequest) -> dict:
    """Approve (→ deterministic simulated apply) or decline a pending proposal.

    This is the ONLY path from ``pending`` to a terminal state. Approving applies
    the effect against a copy of the world — the ground-truth dataset is never
    mutated, and no real money moves.
    """
    try:
        p = QUEUE.decide(req.id, req.approve, DS)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown proposal id") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"proposal": p.to_dict()}


@app.get("/diagnostics")
def diagnostics_endpoint(mode: str | None = None) -> dict:
    """Cross-routing-mode benchmark: grounding/verify/guardrail invariants."""
    if mode is not None and mode not in VALID_MODES:
        raise HTTPException(status_code=422, detail="unknown mode")
    return diagnostics.benchmark(DS, mode=mode)


@app.post("/admin/reset_queue")
def reset_queue() -> dict:
    QUEUE.reset()
    return {"status": "reset", "pending": 0}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
