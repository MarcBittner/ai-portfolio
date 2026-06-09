"""FastAPI service: schema-driven extraction (regex core + optional LLM fill).

The deterministic label-anchored extractor needs no model. With ``use_llm`` (on
by default) the still-missing fields are filled by the multi-provider router
(Ollama-first, mock fallback). Stateless; offline-capable.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from doc_extract import __version__, llm
from doc_extract.extract import extract
from doc_extract.llm_extract import llm_fill
from doc_extract.models import (
    ExtractRequest,
    ExtractResponse,
    FieldInfo,
    FieldResult,
    HealthResponse,
    RoutingInfo,
    SchemaInfo,
)
from doc_extract.schemas import SCHEMA_NAMES, SCHEMAS

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", *llm.PROVIDERS)

app = FastAPI(
    title="doc-extract",
    version=__version__,
    description="Schema-driven extraction with optional LLM fill.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          schemas=len(SCHEMA_NAMES), ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/schemas", response_model=list[SchemaInfo])
def list_schemas() -> list[SchemaInfo]:
    return [
        SchemaInfo(name=s.name, description=s.description,
                   fields=[FieldInfo(name=f.name, type=f.type, description=f.description)
                           for f in s.fields])
        for s in SCHEMAS.values()
    ]


@app.post("/extract", response_model=ExtractResponse)
def run_extract(request: ExtractRequest) -> ExtractResponse:
    if request.schema_name not in SCHEMAS:
        raise HTTPException(
            status_code=422, detail=f"unknown schema: {request.schema_name}"
        )
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail="unknown provider")

    _schema, results = extract(request.text, request.schema_name)
    routing = None
    if request.use_llm:
        missing = {r.name for r in results if not r.found}
        filled, result = llm_fill(request.text, request.schema_name, missing,
                                  request.provider, request.model)
        by_name = {f.name: f for f in filled}
        results = [by_name.get(r.name, r) if not r.found else r for r in results]
        if result is not None:
            routing = RoutingInfo(provider=result.provider, model=result.model,
                                  fallbacks=result.fallbacks)

    fields = [FieldResult(**vars(r)) for r in results]
    return ExtractResponse(
        schema_name=request.schema_name, fields=fields,
        found=sum(1 for f in fields if f.found), total=len(fields), routing=routing,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
