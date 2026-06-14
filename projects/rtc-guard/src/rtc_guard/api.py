"""FastAPI service: mint scoped real-time access tokens, verify them, run the
adversarial suite, and serve the AV-pipeline threat model. The signing key is a
demo default (env ``RTC_GUARD_SIGNING_KEY`` overrides); no real secrets required.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from rtc_guard import __version__, adversary, grant_audit, llm, token
from rtc_guard.models import (
    GrantAuditRequest,
    HealthResponse,
    TokenRequest,
    VerifyRequest,
)
from rtc_guard.threat_model import threat_model

STATIC_DIR = Path(__file__).parent / "static"
SAMPLE = Path(__file__).parent.parent.parent / "samples" / "voice_agent.py"

app = FastAPI(
    title="rtc-guard",
    version=__version__,
    description="Scoped real-time access tokens + adversarial suite + threat model.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          templates=len(token.GRANT_TEMPLATES),
                          threats=threat_model()["count"])


@app.get("/templates")
def templates() -> dict:
    return {"templates": token.GRANT_TEMPLATES, "default_ttl": token.DEFAULT_TTL}


@app.post("/v1/token")
def mint_token(req: TokenRequest) -> dict:
    try:
        tok = token.mint(req.identity, req.room, req.template, req.ttl)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"token": tok, "claims": token.decode(tok), "expires_in": req.ttl}


@app.post("/v1/verify")
def verify_token(req: VerifyRequest) -> dict:
    return token.verify(req.token, expected_room=req.expected_room)


@app.get("/threat-model")
def threats() -> dict:
    return threat_model()


@app.get("/adversary")
def run_adversary() -> dict:
    return adversary.run()


@app.post("/grant/audit")
def audit_grant(req: GrantAuditRequest) -> dict:
    """LLM-assisted least-privilege audit of a proposed grant: a plain-English
    explanation + over-permissioning findings (deterministic offline fallback).

    When the BROWSER reached a host-local Ollama and submitted ``client_audit``,
    the server skips its own LLM call and uses that narration (browser→host);
    the deterministic rule findings still run server-side. Otherwise unchanged."""
    grant = req.model_dump(exclude={"mode", "client_audit"})
    client_audit = req.client_audit.model_dump() if req.client_audit else None
    return grant_audit.audit(grant, mode=req.mode, client_audit=client_audit)


@app.get("/evals")
def evals() -> dict:
    """Score the grant auditor over the labeled set (precision/recall on findings)."""
    return grant_audit.evaluate()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/sample/voice-agent")
def voice_agent_sample() -> PlainTextResponse:
    text = SAMPLE.read_text() if SAMPLE.exists() else "# sample unavailable"
    return PlainTextResponse(text)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
