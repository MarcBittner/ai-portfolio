"""FastAPI service: ingest internet-intelligence inventory and produce a governed,
multi-framework GRC posture with board reporting and auditor evidence export.

Runs fully offline on the synthetic estate (the hosted demo's default); stateless;
no secrets. The board narrative routes through the LLM chain and degrades to a
deterministic template when no provider is configured.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse

from perimeter import __version__, controls, evidence, llm, narrative, scan
from perimeter.models import HealthResponse, ReportRequest

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="perimeter",
    version=__version__,
    description="Internet-exposure inventory → multi-framework GRC posture, "
                "board reporting, and auditor evidence export.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    report = scan.scan()
    return HealthResponse(
        status="ok", version=__version__,
        controls=len(controls.catalog()),
        frameworks=len(controls.frameworks()),
        exposures=len(report["findings"]),
        grade=report["posture"]["grade"])


@app.get("/inventory")
def inventory() -> dict:
    """The internet-intelligence host inventory + summary (hosts, services, ASNs)."""
    report = scan.scan()
    return {"estate": report["estate"], "scan_date": report["scan_date"],
            "summary": report["inventory"], "hosts": report["hosts"]}


@app.get("/exposures")
def exposures() -> dict:
    """The exposure findings (severity, rule, host:port, evidence, mapped controls)."""
    report = scan.scan()
    return {"estate": report["estate"], "findings": report["findings"],
            "severity_counts": report["severity_counts"]}


@app.get("/posture")
def posture() -> dict:
    """The governed posture run: inventory summary, posture headline, framework view."""
    report = scan.scan()
    return {
        "estate": report["estate"], "scan_date": report["scan_date"],
        "inventory": report["inventory"],
        "posture": report["posture"],
        "severity_counts": report["severity_counts"],
        "framework_rollup": report["framework_rollup"],
    }


@app.get("/controls")
def control_catalog(framework: str | None = None) -> dict:
    """The multi-framework control roll-up. ``?framework=`` filters the per-control
    status to one framework's view (and returns that framework's summary row)."""
    report = scan.scan()
    rows = report["controls"]
    fw_rows = report["framework_rollup"]
    if framework:
        match = {r["framework"].lower(): r["framework"] for r in fw_rows}
        canon = match.get(framework.lower())
        if not canon:
            return {"error": f"unknown framework {framework!r}",
                    "frameworks": controls.frameworks()}
        rows = [{**c, "framework_id": c["frameworks"].get(canon)}
                for c in rows if canon in c["frameworks"]]
        fw_rows = [r for r in fw_rows if r["framework"] == canon]
    return {"framework": framework, "frameworks": controls.frameworks(),
            "framework_rollup": fw_rows, "controls": rows,
            "catalog": controls.catalog() if not framework else None}


@app.get("/diff")
def diff() -> dict:
    """Posture over time: before/after the top remediations — score lift + the
    controls and frameworks that flip fail → pass."""
    return scan.remediation_diff()


@app.get("/gate")
def gate(min_score: int = 60) -> dict:
    """CI gate decision: pass only if posture clears ``min_score`` and no critical
    exposure is open."""
    return scan.gate(min_score=min_score)


@app.get("/report")
def report_get(remediated: bool = False, mode: str | None = None) -> dict:
    """LLM board/exec risk report over the governed posture (GET convenience)."""
    return narrative.generate(scan.scan(remediated=remediated), mode=mode)


@app.post("/report")
def report_post(req: ReportRequest) -> dict:
    """LLM board/exec risk report: posture, top risks, what remediation buys,
    residual risk. Reads the deterministic report; never re-derives findings/scores."""
    return narrative.generate(scan.scan(remediated=req.remediated), mode=req.mode)


@app.get("/evidence")
def evidence_export(control: str | None = None, format: str = "json"):
    """Auditor evidence bundle: per-control findings + multi-framework crosswalk.
    ``?control=`` narrows to one control; ``?format=csv`` returns CSV."""
    if format.lower() == "csv":
        return PlainTextResponse(evidence.to_csv(control), media_type="text/csv")
    return evidence.bundle(control)


@app.get("/evals")
def evals() -> dict:
    """Structural eval: does the board report cover every critical exposure?"""
    return narrative.evaluate()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
