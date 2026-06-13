"""FastAPI service: generate synthetic datasets and serve the UI.

Deterministic generators are PII-free by construction. Fields of type ``llm``
are filled by the multi-provider router (Ollama by default) from the field's
``description`` — realistic but not PII-guaranteed; they fall back to the
deterministic placeholder when no provider is reachable.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from synth_data import __version__, llm
from synth_data.generate import PRESET_NAMES, PRESETS, generate, to_csv
from synth_data.generators import TYPE_NAMES
from synth_data.llm_gen import fill_column
from synth_data.models import (
    GenerateRequest,
    GenerateResponse,
    HealthResponse,
    PresetInfo,
    RoutingInfo,
    TypeInfo,
)

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="synth-data",
    version=__version__,
    description="Deterministic, PII-free synthetic dataset generation.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, types=len(TYPE_NAMES),
                          presets=len(PRESET_NAMES), ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/types", response_model=list[TypeInfo])
def list_types() -> list[TypeInfo]:
    return [TypeInfo(name=t) for t in TYPE_NAMES]


@app.get("/schemas", response_model=list[PresetInfo])
def list_presets() -> list[PresetInfo]:
    return [PresetInfo(name=name, fields=fields) for name, fields in PRESETS.items()]


@app.post("/generate")
def run_generate(request: GenerateRequest):
    if request.preset:
        if request.preset not in PRESETS:
            raise HTTPException(
                status_code=422, detail=f"unknown preset: {request.preset}"
            )
        fields = [dict(f) for f in PRESETS[request.preset]]
    elif request.fields:
        fields = [f.model_dump() for f in request.fields]
    else:
        raise HTTPException(status_code=422, detail="provide a preset or fields")
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail="unknown provider")

    try:
        rows = generate(fields, request.n, request.seed)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    routing = None
    if request.use_llm:
        for f in fields:
            if f.get("type") == "llm":
                vals, result = fill_column(f.get("description", ""), len(rows),
                                           request.provider, request.model)
                routing = RoutingInfo(provider=result.provider, model=result.model,
                                      fallbacks=result.fallbacks)
                if vals:
                    for row, v in zip(rows, vals, strict=False):
                        row[f["name"]] = v

    if request.fmt == "csv":
        return PlainTextResponse(to_csv(rows), media_type="text/csv")
    return GenerateResponse(
        n=len(rows), seed=request.seed,
        columns=list(rows[0].keys()) if rows else [], rows=rows, routing=routing,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
