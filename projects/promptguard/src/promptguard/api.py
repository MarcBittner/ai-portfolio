"""FastAPI service: scan prompts/outputs (regex rules + optional LLM classifier).

The deterministic rule engine needs no model. With ``use_llm`` (on by default)
an LLM semantic classifier (Ollama-first, mock fallback) is added for paraphrased
injection attempts on the input; its verdict folds into the score/verdict. Never
re-emits a detected secret.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from promptguard import __version__, llm
from promptguard.llm_classify import classify
from promptguard.models import (
    FindingOut,
    HealthResponse,
    RoutingInfo,
    RuleInfo,
    ScanRequest,
    ScanResponse,
)
from promptguard.rules import RULES, SEVERITY_WEIGHT
from promptguard.scan import Finding, counts_by_category, scan

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="promptguard",
    version=__version__,
    description="Deterministic LLM-firewall with an optional LLM classifier.",
)


def _verdict(score: float) -> str:
    return "block" if score >= 0.85 else "flag" if score > 0 else "allow"


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, rules=len(RULES),
                          ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/rules", response_model=list[RuleInfo])
def list_rules() -> list[RuleInfo]:
    return [RuleInfo(id=r.id, category=r.category, severity=r.severity,
                     applies_to=r.applies_to, description=r.description) for r in RULES]


@app.post("/scan", response_model=ScanResponse)
def run_scan(request: ScanRequest) -> ScanResponse:
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail="unknown provider")
    findings, score, _v = scan(request.text, request.direction)

    routing = None
    if request.use_llm and request.direction in ("input", "both"):
        is_injection, reason, result = classify(
            request.text, request.provider, request.model)
        routing = RoutingInfo(provider=result.provider, model=result.model,
                              fallbacks=result.fallbacks)
        if is_injection:
            findings.append(Finding(
                rule_id="llm_semantic", category="injection", severity="high",
                start=0, end=0, snippet=f"LLM: {reason}" if reason else "LLM verdict"))
            score = max(score, SEVERITY_WEIGHT["high"])

    return ScanResponse(
        verdict=_verdict(score), score=round(score, 2), direction=request.direction,
        findings=[FindingOut(**vars(f)) for f in findings],
        counts=counts_by_category(findings), routing=routing,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
