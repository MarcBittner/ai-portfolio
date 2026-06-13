"""FastAPI service: detect/redact PII (regex core + optional LLM NER) and the UI.

The deterministic regex+checksum core needs no model. With ``use_llm`` (on by
default) it also runs a named-entity pass via the multi-provider router
(Ollama-first, mock fallback) to catch names/orgs/locations, merged with the
regex spans. Stateless; secrets never required.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from pii_redactor import __version__, llm
from pii_redactor.detect import TYPE_NAMES, TYPES, Span, detect
from pii_redactor.llm_ner import LLM_TYPES, llm_entities, merge
from pii_redactor.models import (
    DetectRequest,
    DetectResponse,
    HealthResponse,
    RedactRequest,
    RedactResponse,
    RoutingInfo,
    SpanOut,
    TypeInfo,
)
from pii_redactor.redact import STYLES, redact_spans

STATIC_DIR = Path(__file__).parent / "static"
ALL_TYPES = list(TYPE_NAMES) + list(LLM_TYPES)
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="pii-redactor",
    version=__version__,
    description="Deterministic PII detection/redaction with optional LLM NER.",
)


def _valid_types(types: list[str] | None) -> set[str] | None:
    if types is None:
        return None
    unknown = sorted(set(types) - set(ALL_TYPES))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown types: {unknown}")
    return set(types)


def _check_provider(provider: str) -> None:
    if provider not in VALID_PROVIDERS:
        raise HTTPException(
            status_code=422, detail=f"unknown provider; valid: {list(VALID_PROVIDERS)}"
        )


def _gather(
    text, types, use_llm, provider, model
) -> tuple[list[Span], RoutingInfo | None]:
    wanted = _valid_types(types)
    spans = detect(text, wanted)
    routing = None
    if use_llm:
        _check_provider(provider)
        llm_spans, result = llm_entities(text, provider, model)
        if wanted is not None:
            llm_spans = [s for s in llm_spans if s.type in wanted]
        spans = merge(spans, llm_spans)
        routing = RoutingInfo(provider=result.provider, model=result.model,
                              fallbacks=result.fallbacks)
    return spans, routing


def _counts(spans: list[Span]) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in spans:
        out[s.type] = out.get(s.type, 0) + 1
    return out


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, types=len(ALL_TYPES),
                          styles=list(STYLES), ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/types", response_model=list[TypeInfo])
def list_types() -> list[TypeInfo]:
    regex = [TypeInfo(name=n, description=d, source="regex") for n, d in TYPES]
    ner = [TypeInfo(name=t, description=f"{t.title()} (LLM NER)", source="llm")
           for t in LLM_TYPES]
    return regex + ner


@app.post("/detect", response_model=DetectResponse)
def detect_pii(request: DetectRequest) -> DetectResponse:
    spans, routing = _gather(request.text, request.types, request.use_llm,
                             request.provider, request.model)
    return DetectResponse(
        spans=[SpanOut(type=s.type, start=s.start, end=s.end,
                       source="llm" if s.type in LLM_TYPES else "regex") for s in spans],
        counts=_counts(spans), total=len(spans), routing=routing,
    )


@app.post("/redact", response_model=RedactResponse)
def redact_pii(request: RedactRequest) -> RedactResponse:
    if request.style not in STYLES:
        raise HTTPException(status_code=422, detail=f"unknown style; valid: {STYLES}")
    spans, routing = _gather(request.text, request.types, request.use_llm,
                             request.provider, request.model)
    redacted, counts = redact_spans(request.text, spans, request.style)
    return RedactResponse(redacted=redacted, counts=counts, total=sum(counts.values()),
                          style=request.style, routing=routing)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
