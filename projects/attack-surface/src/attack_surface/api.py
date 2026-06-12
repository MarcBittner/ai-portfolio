"""FastAPI service: enumerate attack surface and produce a SOC 2 / ISO 27001
control-mapped exposure report. Fixture mode (offline, full report on the owned
synthetic domain) is the default; live mode does passive CT-log recon only.
Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from attack_surface import __version__, controls, scanner
from attack_surface.models import HealthResponse, ScanRequest

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="attack-surface",
    version=__version__,
    description="Attack-surface enumeration → SOC 2 / ISO 27001 control-mapped report.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          controls=len(controls.catalog()),
                          fixture_findings=len(scanner.scan_fixture()["findings"]))


@app.get("/controls")
def control_catalog() -> dict:
    return {"controls": controls.catalog()}


@app.get("/scan")
def scan_default() -> dict:
    return scanner.scan_fixture()


@app.post("/scan")
def scan(req: ScanRequest) -> dict:
    return scanner.scan(req.domain, req.mode)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
