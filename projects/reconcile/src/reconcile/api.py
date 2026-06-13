"""FastAPI service: reconcile a change-order / invoice document against a baseline
contract and market rates, flag overcharges, and queue money-path lines for review.

The deterministic core needs no model. With a configured provider (Anthropic /
Ollama / OpenAI), the extraction step uses schema-constrained structured outputs;
otherwise it falls back to the deterministic table parser. Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from reconcile import __version__, llm
from reconcile.data import BASELINE, MARKET, SAMPLES
from reconcile.evaluate import run_eval
from reconcile.extract import extract_line_items
from reconcile.models import AnalyzeRequest, HealthResponse, SampleInfo
from reconcile.review import build_queue
from reconcile.variance import reconcile_items

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="reconcile",
    version=__version__,
    description="Document line-item reconciliation against a baseline + market rates.",
)


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


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(422, f"unknown provider; valid: {list(VALID_PROVIDERS)}")
    if request.sample is not None:
        if request.sample not in SAMPLES:
            raise HTTPException(404, f"unknown sample; valid: {list(SAMPLES)}")
        text, doc = SAMPLES[request.sample], request.sample
    elif request.text:
        text, doc = request.text, None
    else:
        raise HTTPException(422, "provide either 'text' or 'sample'")

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


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
