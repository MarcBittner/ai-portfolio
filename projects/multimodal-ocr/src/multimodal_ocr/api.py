"""FastAPI service: OCR→redact pipeline + UI.

Stateless and offline by default (sample documents + deterministic pipeline).
Real OCR (`/ocr`) is opt-in and only works if Tesseract is installed.
"""

import base64
import importlib.util
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from multimodal_ocr import __version__
from multimodal_ocr.detect import TYPE_NAMES
from multimodal_ocr.models import (
    BoxOut,
    FindingOut,
    HealthResponse,
    OcrRequest,
    ProcessRequest,
    ProcessResponse,
    SampleInfo,
    TokenIO,
)
from multimodal_ocr.ocr import (
    SAMPLE_NAMES,
    OcrToken,
    OcrUnavailable,
    ocr_image,
    sample_tokens,
)
from multimodal_ocr.pipeline import process, tokens_to_text

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="multimodal-ocr",
    version=__version__,
    description="OCR → PII detection → box-level redaction.",
)


def _ocr_backend() -> str:
    has = importlib.util.find_spec("pytesseract") and importlib.util.find_spec("PIL")
    return "tesseract" if has else "samples-only"


def _types(types: list[str] | None) -> set[str] | None:
    if types is None:
        return None
    unknown = sorted(set(types) - set(TYPE_NAMES))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown types: {unknown}")
    return set(types)


def _to_io(tok: OcrToken) -> TokenIO:
    return TokenIO(text=tok.text, x=tok.x, y=tok.y, w=tok.w, h=tok.h)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, samples=len(SAMPLE_NAMES),
                          types=len(TYPE_NAMES), ocr_backend=_ocr_backend())


@app.get("/samples", response_model=list[SampleInfo])
def list_samples() -> list[SampleInfo]:
    return [SampleInfo(name=n, tokens=[_to_io(t) for t in sample_tokens(n)])
            for n in SAMPLE_NAMES]


@app.post("/process", response_model=ProcessResponse)
def run_process(request: ProcessRequest) -> ProcessResponse:
    if request.sample:
        if request.sample not in SAMPLE_NAMES:
            raise HTTPException(
                status_code=422, detail=f"unknown sample: {request.sample}"
            )
        tokens = sample_tokens(request.sample)
    elif request.tokens:
        tokens = [OcrToken(t.text, t.x, t.y, t.w, t.h) for t in request.tokens]
    else:
        raise HTTPException(status_code=422, detail="provide a sample or tokens")

    result = process(tokens, _types(request.types))
    _text, ordered, _spans = tokens_to_text(tokens)
    return ProcessResponse(
        text=result.text,
        redacted_text=result.redacted_text,
        tokens=[_to_io(t) for t in ordered],
        findings=[FindingOut(**vars(f)) for f in result.findings],
        boxes=[BoxOut(**vars(b)) for b in result.boxes],
        counts=result.counts,
    )


@app.post("/ocr", response_model=ProcessResponse)
def run_ocr(request: OcrRequest) -> ProcessResponse:
    """Opt-in: OCR an uploaded image, then run the pipeline. 422 if Tesseract
    isn't installed (use a sample or supply tokens instead)."""
    try:
        image = base64.b64decode(request.image_b64)
        tokens = ocr_image(image)
    except OcrUnavailable as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(status_code=422, detail=f"bad image_b64: {exc}") from exc
    return run_process(ProcessRequest(tokens=[_to_io(t) for t in tokens]))


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
