"""FastAPI service: schema-driven extraction + the single-page UI.

Stateless, fully offline (deterministic; no model, no network, no secrets).
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from doc_extract import __version__
from doc_extract.extract import extract
from doc_extract.models import (
    ExtractRequest,
    ExtractResponse,
    FieldInfo,
    FieldResult,
    HealthResponse,
    SchemaInfo,
)
from doc_extract.schemas import SCHEMA_NAMES, SCHEMAS

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="doc-extract",
    version=__version__,
    description="Deterministic, schema-driven document field extraction.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, schemas=len(SCHEMA_NAMES))


@app.get("/schemas", response_model=list[SchemaInfo])
def list_schemas() -> list[SchemaInfo]:
    return [
        SchemaInfo(
            name=s.name, description=s.description,
            fields=[FieldInfo(name=f.name, type=f.type, description=f.description)
                    for f in s.fields],
        )
        for s in SCHEMAS.values()
    ]


@app.post("/extract", response_model=ExtractResponse)
def run_extract(request: ExtractRequest) -> ExtractResponse:
    try:
        _schema, results = extract(request.text, request.schema_name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    fields = [FieldResult(**vars(r)) for r in results]
    return ExtractResponse(
        schema_name=request.schema_name,
        fields=fields,
        found=sum(1 for f in fields if f.found),
        total=len(fields),
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
