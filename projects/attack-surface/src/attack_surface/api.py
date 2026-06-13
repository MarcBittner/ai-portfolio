"""FastAPI service: enumerate attack surface and produce a SOC 2 / ISO 27001
control-mapped exposure report. Fixture mode (offline, full report on the owned
synthetic domain) is the default; live mode does passive CT-log recon only.
Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from attack_surface import __version__, controls, llm, narrative, scanner
from attack_surface.models import HealthResponse, NarrativeRequest, ScanRequest

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


@app.get("/report/diff")
def report_diff() -> dict:
    """Before/after the two critical fixes: posture lift + controls that flip."""
    return scanner.remediation_diff()


@app.post("/report/narrative")
def report_narrative(req: NarrativeRequest) -> dict:
    """LLM exec risk narrative + remediation guidance for the fixture report.

    Reads the deterministic scan (optionally the remediated state) and writes a
    board-ready summary; findings/scores/control mappings are not re-derived.
    """
    report = scanner.scan_fixture(remediated=req.remediated)
    return narrative.generate(report, mode=req.mode)


@app.get("/report/exec")
def report_exec(remediated: bool = False, mode: str | None = None) -> dict:
    """GET convenience for the exec narrative (same as POST /report/narrative)."""
    report = scanner.scan_fixture(remediated=remediated)
    return narrative.generate(report, mode=mode)


@app.get("/evals")
def evals() -> dict:
    """Structural eval: does remediation guidance cover every critical finding?"""
    return narrative.evaluate()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
