"""FastAPI service: grounded, verified Q&A + a human-approval action queue.

Endpoints (all stateless except the in-memory approval queue; no secrets):

  GET  /health                  liveness + dataset/queue counts
  GET  /llm                     which providers are reachable + active mode
  GET  /dataset                 PII-free dataset summary (counts only)
  GET  /records                 the actual accounts + a page of transactions
  POST /transactions            human-entered ledger row (explicit data entry)
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

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from counsel import __version__, agent, approvals, data, diagnostics, llm
from counsel.approvals import ACTION_KINDS, QUEUE
from counsel.models import (
    AddTransactionRequest,
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

# CORS: restrict to the explicit deployment origin (or localhost for dev).
# An explicit allowlist prevents browsers from treating this as open to all origins.
_ALLOW_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ALLOW_ORIGINS", "http://localhost:8080").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOW_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

data.build_dataset()  # warm the deterministic ground truth at startup


def _ds():
    """Always resolve the *current* cached dataset.

    The ledger is appendable (human-entered rows) and resettable, so handlers
    must read the live cache rather than a stale reference captured at import.
    """
    return data.build_dataset()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    ds = _ds()
    return HealthResponse(
        status="ok", version=__version__,
        accounts=len(ds.accounts), transactions=len(ds.transactions),
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
    return data.summary(_ds())


@app.get("/examples")
def examples() -> dict:
    """The guided-demo question set (grounded, ungrounded, and guardrail asks)."""
    return {"examples": diagnostics.EXAMPLES}


@app.post("/ask/prepare")
def ask_prepare(req: AskRequest) -> dict:
    """Browser→host step 1: run the deterministic core, return prompt or refusal.

    The cloud server can't reach a user's localhost Ollama — only the browser
    can. So for the local tier the browser asks the server to prepare: the
    server runs guardrail + retrieve + compute (NO provider call) and returns
    either a ready refusal (guardrail/ungrounded — no narration needed) or the
    exact SYSTEM + user prompt counsel would send the LLM, plus the facts and
    citable ids. The browser then runs its local Ollama on that prompt and POSTs
    the narration back to ``/ask`` as ``client_summary`` for verification.
    """
    if req.mode is not None and req.mode not in VALID_MODES:
        raise HTTPException(status_code=422, detail="unknown mode")
    return agent.prepare(_ds(), req.question).to_dict()


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    if req.mode is not None and req.mode not in VALID_MODES:
        raise HTTPException(status_code=422, detail="unknown mode")
    # Browser→host step 3 (finalize): when ``client_summary`` is present, the
    # server recomputes every fact itself and uses the client text only as the
    # narration, then verifies it — the trust boundary stays server-side.
    result = agent.answer(_ds(), req.question, mode=req.mode,
                          client_summary=req.client_summary,
                          client_model=req.model)
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
    ds = _ds()
    built = approvals.build(req.kind, ds) if req.kind != "set_budget" else \
        approvals.build_set_budget(ds, req.category)
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
        p = QUEUE.decide(req.id, req.approve, _ds())
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
    return diagnostics.benchmark(_ds(), mode=mode)


def _txn_row(ds, t) -> dict:
    """A PII-free transaction row for the Data tab, tagged seed-vs-user-added."""
    acct = ds.account(t.account_id)
    return {
        "id": t.id, "account_id": t.account_id,
        "account_name": acct.name if acct else None,
        "date": t.date, "merchant": t.merchant, "category": t.category,
        "amount": t.amount, "user_added": data.is_user_added(t),
    }


@app.get("/records")
def records(limit: int = 50, account: str | None = None,
            category: str | None = None) -> dict:
    """The ACTUAL ledger so the UI can show what's populated.

    Returns the real accounts (with computed balances), a page of the most-recent
    transactions (optionally filtered by account/category, each tagged
    seed-vs-user-added), and totals + the date window. Still PII-free — the
    dataset is synthetic by construction.
    """
    ds = _ds()
    if limit < 1:
        limit = 1
    if limit > 500:
        limit = 500
    txns = ds.transactions
    if account is not None:
        txns = [t for t in txns if t.account_id == account]
    if category is not None:
        txns = [t for t in txns if t.category == category]
    n_total = len(txns)
    n_user = sum(1 for t in txns if data.is_user_added(t))
    # most recent first for browsing
    ordered = sorted(txns, key=lambda t: (t.date, t.id), reverse=True)[:limit]
    accounts = [{
        "id": a.id, "name": a.name, "type": a.type, "mask": a.mask,
        "balance": data.account_balance(ds, a.id),
    } for a in ds.accounts]
    return {
        "accounts": accounts,
        "transactions": [_txn_row(ds, t) for t in ordered],
        "categories": sorted(data.CATEGORIES),
        "totals": {
            "transactions": n_total,
            "user_added": n_user,
            "seed": n_total - n_user,
            "returned": len(ordered),
        },
        "window": {
            "start": data.summary(ds)["window_start"],
            "today": data.TODAY.isoformat(),
        },
        "filtered": {"account": account, "category": category},
    }


@app.post("/transactions")
def add_transaction(req: AddTransactionRequest) -> dict:
    """Add a human-entered transaction to the ledger.

    This is explicit USER data entry: the human supplies a source record and code
    recomputes over it (``/ask``, ``/dataset``, compute all read the same list, so
    the new row flows through automatically). The agent/LLM never mutates data.
    Malformed input is rejected with 422 — never a 500.
    """
    ds = _ds()
    try:
        txn = data.add_transaction(
            ds, account_id=req.account_id, date_iso=req.date,
            merchant=req.merchant, category=req.category, amount=req.amount)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return {
        "transaction": _txn_row(ds, txn),
        "counts": {
            "accounts": len(ds.accounts),
            "transactions": len(ds.transactions),
            "user_added": sum(1 for t in ds.transactions
                              if data.is_user_added(t)),
        },
    }


@app.post("/admin/reset_data")
def reset_data() -> dict:
    """Restore the seed-only ledger (drops every user-added row)."""
    ds = data.reset_dataset()
    return {
        "status": "reset",
        "transactions": len(ds.transactions),
        "user_added": 0,
    }


@app.post("/admin/reset_queue")
def reset_queue() -> dict:
    QUEUE.reset()
    return {"status": "reset", "pending": 0}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    # no-cache: still ETag-revalidated, but never serve a stale SPA — a new deploy
    # is picked up on the next load instead of lingering in the browser cache.
    return FileResponse(STATIC_DIR / "index.html",
                        headers={"Cache-Control": "no-cache"})
