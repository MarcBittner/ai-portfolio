"""FastAPI service: reconcile a change-order / invoice document against a baseline
contract and market rates, flag overcharges, and queue money-path lines for review.

The deterministic core needs no model. With a configured provider (Anthropic /
Ollama / OpenAI), the extraction step uses schema-constrained structured outputs;
otherwise it falls back to the deterministic table parser. Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware

from reconcile import __version__, llm
from reconcile.data import BASELINE, MARKET, SAMPLES
from reconcile.evaluate import run_eval
from reconcile.extract import extract_line_items, parse_table, prepare, rows_to_items
from reconcile.models import AnalyzeRequest, HealthResponse, RoutingInfo, SampleInfo
from reconcile.review import build_queue
from reconcile.variance import reconcile_items

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="reconcile",
    version=__version__,
    description="Document line-item reconciliation against a baseline + market rates.",
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add standard security headers to every response."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src 'self' https:; font-src 'self' data:"
        )
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response


app.add_middleware(SecurityHeadersMiddleware)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__, baseline_lines=len(BASELINE),
        market_codes=len(MARKET), samples=len(SAMPLES), ollama=llm.reachable(),
    )


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/samples", response_model=list[SampleInfo])
def samples() -> list[SampleInfo]:
    return [SampleInfo(name=n, text=t) for n, t in SAMPLES.items()]


@app.get("/baseline")
def baseline() -> dict:
    return {"lines": [
        {"csi": csi, "description": s.description, "unit": s.unit,
         "quantity": s.quantity, "unit_cost": s.unit_cost}
        for csi, s in BASELINE.items()
    ]}


@app.get("/rates")
def rates() -> dict:
    return {"rates": [
        {"csi": csi, "unit": b.unit, "low": b.low, "typical": b.typical, "high": b.high}
        for csi, b in MARKET.items()
    ]}


@app.get("/eval")
def eval_extraction() -> dict:
    return run_eval()


def _resolve_text(request: AnalyzeRequest) -> tuple[str, str | None]:
    """Resolve the request to ``(text, doc_name)`` — a bundled sample or pasted
    text. Raises 404/422 the same way for /analyze and /analyze/prepare."""
    if request.sample is not None:
        if request.sample not in SAMPLES:
            raise HTTPException(404, f"unknown sample; valid: {list(SAMPLES)}")
        return SAMPLES[request.sample], request.sample
    if request.text:
        return request.text, None
    raise HTTPException(422, "provide either 'text' or 'sample'")


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(422, f"unknown provider; valid: {list(VALID_PROVIDERS)}")
    text, doc = _resolve_text(request)

    ce = request.client_extraction
    if request.use_llm and ce is not None:
        # Browser→host: the user's own Ollama already extracted the rows in the
        # browser; fold them in here rather than calling the model server-side.
        # Fall back to the deterministic table parser if none validate.
        client_items = rows_to_items([i.model_dump() for i in ce.items])
        if client_items is not None:
            items, method = client_items, "llm"
            routing = RoutingInfo(provider="ollama (browser→host)",
                                  model=ce.model or "ollama", fallbacks=[])
        else:
            items, routing, method = parse_table(text), None, "table"
    else:
        items, routing, method = extract_line_items(
            text, request.use_llm, request.provider, request.model
        )
    reconciled = reconcile_items(items)
    return {
        "document": doc,
        "extraction": {"method": method, "count": len(items)},
        "routing": (
            {"provider": routing.provider, "model": routing.model,
             "fallbacks": routing.fallbacks} if routing else None
        ),
        "summary": reconciled["summary"],
        "lines": reconciled["lines"],
        "review_queue": build_queue(reconciled),
    }


@app.post("/analyze/prepare")
def analyze_prepare(request: AnalyzeRequest) -> dict:
    """Browser→host step 1: return the extractor prompt WITHOUT calling a model, so
    the browser can run it on the user's own host Ollama (the local tier) and POST
    the rows back to ``/analyze`` as ``client_extraction``. ``applies`` is False when
    the LLM path wouldn't run (no use_llm), in which case the browser should just
    call ``/analyze`` normally."""
    text, _doc = _resolve_text(request)
    system, user_prompt = prepare(text)
    return {"applies": bool(request.use_llm), "system": system,
            "user_prompt": user_prompt}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
