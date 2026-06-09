"""FastAPI service: scan prompts/outputs and serve the UI.

Stateless, fully offline (deterministic rules; no model, no network, no
secrets — and it never re-emits a secret it detects).
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from promptguard import __version__
from promptguard.models import (
    FindingOut,
    HealthResponse,
    RuleInfo,
    ScanRequest,
    ScanResponse,
)
from promptguard.rules import RULES
from promptguard.scan import counts_by_category, scan

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="promptguard",
    version=__version__,
    description="Deterministic LLM-firewall for prompts and outputs.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, rules=len(RULES))


@app.get("/rules", response_model=list[RuleInfo])
def list_rules() -> list[RuleInfo]:
    return [
        RuleInfo(id=r.id, category=r.category, severity=r.severity,
                 applies_to=r.applies_to, description=r.description)
        for r in RULES
    ]


@app.post("/scan", response_model=ScanResponse)
def run_scan(request: ScanRequest) -> ScanResponse:
    findings, score, verdict = scan(request.text, request.direction)
    return ScanResponse(
        verdict=verdict,
        score=score,
        direction=request.direction,
        findings=[FindingOut(**vars(f)) for f in findings],
        counts=counts_by_category(findings),
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
