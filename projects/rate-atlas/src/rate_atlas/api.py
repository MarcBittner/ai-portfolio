"""FastAPI service: ingest synthetic price-transparency files in three shapes,
normalize them into one model in SQLite, and compare a procedure's negotiated rate
across payers/hospitals (+ outlier detection). Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from rate_atlas import __version__, outliers, store
from rate_atlas.models import HealthResponse

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="rate-atlas",
    version=__version__,
    description="Normalize inconsistent price files; compare rates across payers.",
)

store.ingest()  # build the in-memory DB from the synthetic sources at startup


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, sources=len(store.sources()),
                          procedures=len(store.procedures()),
                          total_rows=store.ingest()["total_rows"])


@app.get("/sources")
def sources() -> dict:
    return {"sources": store.sources()}


@app.get("/procedures")
def procedures() -> dict:
    return {"procedures": store.procedures()}


@app.get("/compare/{code}")
def compare(code: str) -> dict:
    result = store.compare(code)
    if not result["quotes"]:
        raise HTTPException(404, f"no rates for code {code!r}")
    return result


@app.get("/outliers")
def get_outliers(threshold: float = 2.0) -> dict:
    return outliers.find_outliers(threshold)


@app.get("/search")
def search(q: str = "") -> dict:
    return {"results": store.search(q)}


@app.post("/admin/reingest")
def reingest() -> dict:
    return store.ingest()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
