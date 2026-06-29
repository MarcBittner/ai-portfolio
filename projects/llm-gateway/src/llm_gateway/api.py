"""FastAPI service: a provider-agnostic LLM gateway with governance on the path.

Every completion runs through firewall → redaction → routing → output firewall →
redaction → tamper-evident audit log. The deterministic guardrails need no model;
routing falls back to a mock provider offline. Stateless; no secrets required.
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response

from llm_gateway import __version__, audit, firewall, gateway, llm
from llm_gateway.evaluate import run_eval
from llm_gateway.models import CompleteRequest, ExtractRequest, HealthResponse
from llm_gateway.policy import DEFAULT

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "paid", "local", "free", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="llm-gateway",
    version=__version__,
    description="Provider-agnostic LLM gateway with governance on the request path.",
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    ),
}


@app.middleware("http")
async def add_security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    for header, value in _SECURITY_HEADERS.items():
        response.headers[header] = value
    return response


def _check_provider(provider: str) -> None:
    if provider not in VALID_PROVIDERS:
        raise HTTPException(422, f"unknown provider; valid: {list(VALID_PROVIDERS)}")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__, providers=len(llm.PROVIDERS),
        audit_entries=len(audit.log),
        policy_layers=sum(DEFAULT.as_dict().values()), ollama=llm.reachable(),
    )


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/policy")
def policy() -> dict:
    return DEFAULT.as_dict()


@app.get("/rules")
def rules() -> list[dict]:
    return firewall.rules()


@app.post("/v1/complete")
def complete(req: CompleteRequest) -> dict:
    _check_provider(req.provider)
    return gateway.complete(
        req.prompt, req.system, req.provider, req.model,
        client_completion=req.client_completion,
    ).as_dict()


@app.post("/v1/extract")
def extract(req: ExtractRequest) -> dict:
    _check_provider(req.provider)
    system = "Return ONLY a JSON object, no prose. " + req.instruction
    res = gateway.complete(req.text, system, req.provider, req.model)
    parsed = None
    if res.blocked is None:
        raw = res.output
        i, j = raw.find("{"), raw.rfind("}")
        if i != -1 and j > i:
            try:
                parsed = json.loads(raw[i:j + 1])
            except (ValueError, json.JSONDecodeError):
                parsed = None
    return {"parsed": parsed, "governed": res.as_dict()}


@app.get("/v1/audit")
def audit_log() -> dict:
    return {"entries": audit.log.entries(), "length": len(audit.log)}


@app.get("/v1/audit/verify")
def audit_verify() -> dict:
    return audit.log.verify()


@app.post("/v1/audit/_demo_tamper")
def audit_tamper(seq: int = 0) -> dict:
    """Demo aid: mutate a logged entry to show that verification then fails.
    Disabled by default; set GATEWAY_DEMO_TAMPER=1 to enable."""
    if not os.environ.get("GATEWAY_DEMO_TAMPER"):
        raise HTTPException(
            501,
            "Demo tamper endpoint is disabled in this deployment. "
            "Set GATEWAY_DEMO_TAMPER=1 to enable.",
        )
    ok = audit.log.demo_tamper(seq)
    return {"tampered": ok, "seq": seq, "verify": audit.log.verify()}


@app.get("/eval")
def eval_governance() -> dict:
    return run_eval()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
