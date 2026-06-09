"""FastAPI service: detect and redact PII, and serve the single-page UI.

Stateless and fully offline — no model, no network, no secrets. The UI at
``/`` is a self-contained static page (no build step) that calls these
endpoints.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from pii_redactor import __version__
from pii_redactor.detect import TYPE_NAMES, TYPES, detect
from pii_redactor.detect import counts as count_spans
from pii_redactor.models import (
    DetectRequest,
    DetectResponse,
    HealthResponse,
    RedactRequest,
    RedactResponse,
    SpanOut,
    TypeInfo,
)
from pii_redactor.redact import STYLES, redact

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="pii-redactor",
    version=__version__,
    description="Deterministic PII detection and redaction.",
)


def _types(types: list[str] | None) -> set[str] | None:
    if types is None:
        return None
    unknown = sorted(set(types) - set(TYPE_NAMES))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown types: {unknown}")
    return set(types)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__, types=len(TYPE_NAMES), styles=list(STYLES)
    )


@app.get("/types", response_model=list[TypeInfo])
def list_types() -> list[TypeInfo]:
    return [TypeInfo(name=name, description=desc) for name, desc in TYPES]


@app.post("/detect", response_model=DetectResponse)
def detect_pii(request: DetectRequest) -> DetectResponse:
    spans = detect(request.text, _types(request.types))
    return DetectResponse(
        spans=[SpanOut(type=s.type, start=s.start, end=s.end) for s in spans],
        counts=count_spans(spans),
        total=len(spans),
    )


@app.post("/redact", response_model=RedactResponse)
def redact_pii(request: RedactRequest) -> RedactResponse:
    if request.style not in STYLES:
        raise HTTPException(
            status_code=422, detail=f"unknown style: {request.style}; valid: {STYLES}"
        )
    redacted, counts = redact(request.text, request.style, _types(request.types))
    return RedactResponse(
        redacted=redacted, counts=counts, total=sum(counts.values()),
        style=request.style,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
