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
from promptguard.llm_classify import classify, prepare
from promptguard.models import (
    FindingOut,
    HealthResponse,
    RoutingInfo,
    RuleInfo,
    ScanRequest,
    ScanResponse,
)
from promptguard.rules import RULES, SEVERITY_WEIGHT
from promptguard.scan import Finding, counts_by_category, scan, verdict_for_score

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="promptguard",
    version=__version__,
    description="Deterministic LLM-firewall with an optional LLM classifier.",
)


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
        cc = request.client_classification
        if cc is not None:
            # Browser→host: the user's own Ollama already produced the verdict in
            # the browser; trust it here rather than calling the model server-side.
            is_injection, reason = cc.injection, cc.reason
            routing = RoutingInfo(provider="ollama (browser→host)",
                                  model=cc.model or "ollama", fallbacks=[])
        else:
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
        verdict=verdict_for_score(score), score=round(score, 2),
        direction=request.direction,
        findings=[FindingOut(**vars(f)) for f in findings],
        counts=counts_by_category(findings), routing=routing,
    )


@app.post("/scan/prepare")
def scan_prepare(request: ScanRequest) -> dict:
    """Browser→host step 1: return the classifier prompt WITHOUT calling a model,
    so the browser can run it on the user's own host Ollama (the local tier) and
    POST the verdict back to ``/scan`` as ``client_classification``. ``applies`` is
    False when the LLM classifier wouldn't run (no use_llm, or output-only scan),
    in which case the browser should just call ``/scan`` normally."""
    applies = request.use_llm and request.direction in ("input", "both")
    system, user_prompt = prepare(request.text)
    return {"applies": applies, "system": system, "user_prompt": user_prompt}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
