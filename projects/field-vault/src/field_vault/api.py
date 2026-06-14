"""FastAPI service: ingest synthetic claims de-identified, serve policy-gated,
audited field access, recover identities only under role+purpose, and compute a
de-identified provider outcome score. Stateless; no real PHI; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from field_vault import __version__, audit, llm, notes, policy, privacy, store
from field_vault.models import AccessRequest, HealthResponse, NoteRequest
from field_vault.score import provider_scores

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="field-vault",
    version=__version__,
    description="Field-level de-identification + least-privilege access + audit.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, records=len(store.records()),
                          roles=len(policy.roles()), audit_entries=len(audit.log))


@app.get("/roles")
def roles() -> list[dict]:
    return policy.roles()


@app.get("/records")
def records() -> dict:
    return {"records": store.records()}


@app.get("/records/{record_id}")
def record(record_id: str) -> JSONResponse:
    rec = store.get(record_id)
    if rec is None:
        return JSONResponse({"error": "unknown record"}, status_code=404)
    return JSONResponse(rec)


@app.post("/access")
def access(req: AccessRequest) -> JSONResponse:
    result = store.access_field(req.role, req.record_id, req.field,
                                req.purpose, req.reidentify)
    return JSONResponse(result, status_code=result.get("status", 200))


@app.get("/scores")
def scores() -> dict:
    return {"providers": provider_scores(store.records())}


@app.post("/notes/detect")
def notes_detect(req: NoteRequest) -> JSONResponse:
    """Detect + redact PHI in a free-text note via the LLM routing chain.

    Accepts raw ``note`` text, or a ``record_id`` whose intake note to scrub.
    """
    note = req.note
    if note is None and req.record_id is not None:
        note = store.intake_note(req.record_id)
    if not note:
        return JSONResponse({"error": "provide 'note' or a known 'record_id'"},
                            status_code=400)
    client_spans = ([s.model_dump() for s in req.client_spans]
                    if req.client_spans is not None else None)
    return JSONResponse(notes.detect(note, mode=req.mode, client_spans=client_spans))


@app.get("/privacy")
def privacy_kanon() -> dict:
    """k-anonymity of the de-identified surface — re-identification by linkage."""
    return privacy.k_anonymity(store.records())


@app.get("/privacy/sweep")
def privacy_sweep() -> dict:
    """How coarser generalization raises k (the privacy/utility lever)."""
    return {"sweep": privacy.generalization_sweep(store.records())}


@app.get("/evals")
def evals() -> dict:
    """Score PHI detection over the labeled note set (precision/recall/F1)."""
    return notes.evaluate()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/audit")
def audit_log() -> dict:
    return {"entries": audit.log.entries(), "length": len(audit.log)}


@app.get("/audit/verify")
def audit_verify() -> dict:
    return audit.log.verify()


@app.post("/audit/_demo_tamper")
def audit_tamper(seq: int = 0) -> dict:
    """Demo aid: mutate a logged decision to show that verification then fails."""
    ok = audit.log.demo_tamper(seq)
    return {"tampered": ok, "seq": seq, "verify": audit.log.verify()}


@app.post("/admin/reset")
def admin_reset() -> dict:
    store.reset()
    return {"reset": True, "records": len(store.records())}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
