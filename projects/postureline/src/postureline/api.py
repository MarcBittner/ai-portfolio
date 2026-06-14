"""FastAPI service: ONE posture/compliance engine exposing BOTH surfaces.

Stateless; synthetic data only; no real PHI; no secrets. The board/exec narrative
routes through the LLM chain and degrades to a deterministic template when no
provider is configured, so the public demo runs fully offline.

Shared endpoints take a ``surface`` (warehouse | exposure); the warehouse-only
endpoints (`/policy`, `/privacy`, `/gate`) expose maskline's distinctive artifacts.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse

from postureline import (
    __version__,
    controls,
    evidence,
    llm,
    narrative,
    scan,
    scanners,
)
from postureline.models import HealthResponse, ReportRequest

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="postureline",
    version=__version__,
    description="One security-posture & compliance engine, two exposure surfaces: "
                "a Snowflake-compatible analytics warehouse and an "
                "internet-intelligence estate.",
)


def _require_surface(surface: str) -> str:
    if surface not in scanners.SURFACES:
        raise HTTPException(
            status_code=404,
            detail=f"unknown surface {surface!r}; "
                   f"known: {', '.join(scanners.SURFACES)}")
    return surface


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", version=__version__,
        surfaces=list(scanners.SURFACES),
        controls=len(controls.catalog()),
        frameworks=len(controls.frameworks()))


@app.get("/scan/{surface}")
def scan_surface(surface: str, remediated: bool = False,
                 mode: str | None = None, narrative: bool = False) -> dict:
    """Full posture result for a surface: findings → unified controls → posture
    (+ optional LLM narrative). ``surface`` ∈ {warehouse, exposure}."""
    _require_surface(surface)
    return scan.run(surface, remediated=remediated, mode=mode,
                    include_narrative=narrative)


@app.get("/controls")
def control_rollup(surface: str = "exposure",
                   framework: str | None = None) -> dict:
    """The unified multi-framework control roll-up for a surface. ``?framework=``
    filters the per-control status to one framework's view."""
    _require_surface(surface)
    report = scan.run(surface)
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
    return {"surface": surface, "framework": framework,
            "frameworks": controls.frameworks(),
            "framework_rollup": fw_rows, "controls": rows,
            "catalog": controls.catalog() if not framework else None}


@app.get("/posture")
def posture_view(surface: str = "exposure") -> dict:
    """The governed posture headline + framework view for a surface."""
    _require_surface(surface)
    report = scan.run(surface)
    return {
        "surface": surface,
        "posture": report["posture"],
        "severity_counts": report["severity_counts"],
        "framework_rollup": report["framework_rollup"],
        "findings": report["findings"],
        "extras": report["extras"],
    }


@app.get("/diff")
def diff_view(surface: str = "exposure") -> dict:
    """Remediation delta: before/after the remediation wave for a surface."""
    _require_surface(surface)
    return scan.diff(surface)


@app.get("/report")
def report_get(surface: str = "exposure", remediated: bool = False,
               mode: str | None = None) -> dict:
    """LLM board/exec risk report over a surface's computed posture (GET)."""
    _require_surface(surface)
    return narrative.generate(scan.run(surface, remediated=remediated), mode=mode)


@app.post("/report")
def report_post(req: ReportRequest) -> dict:
    """LLM board/exec risk report (POST: ``{surface, remediated, mode}``).

    When ``client_narrative`` is present the browser ran the prompt against the
    user's host Ollama (browser→host); the server parses it instead of calling a
    provider. Absent, behavior is unchanged.
    """
    _require_surface(req.surface)
    return narrative.generate(
        scan.run(req.surface, remediated=req.remediated), mode=req.mode,
        client_narrative=req.client_narrative)


@app.get("/evidence")
def evidence_export(surface: str = "exposure", control: str | None = None,
                    format: str = "json"):
    """Auditor evidence bundle: per-control findings + six-framework crosswalk.
    ``?control=`` narrows to one control; ``?format=csv`` returns CSV."""
    _require_surface(surface)
    if format.lower() == "csv":
        return PlainTextResponse(evidence.to_csv(surface, control),
                                 media_type="text/csv")
    return evidence.bundle(surface, control)


# --------------------------------------------------------------------------- #
# Warehouse-specific endpoints (maskline's distinctive artifacts)             #
# --------------------------------------------------------------------------- #

@app.get("/policy")
def policy_artifacts(mode: str | None = None) -> dict:
    """Generated Snowflake masking + row-access DDL, Terraform, and the gap."""
    report = scan.run("warehouse", mode=mode)
    return report["extras"]["policy"]


@app.get("/policy/ddl", response_class=PlainTextResponse)
def policy_ddl() -> str:
    """Raw Snowflake DDL (text/plain — paste-ready)."""
    return scan.run("warehouse")["extras"]["policy"]["snowflake_ddl"]


@app.get("/policy/terraform", response_class=PlainTextResponse)
def policy_terraform() -> str:
    """Raw Terraform (text/plain — paste-ready)."""
    return scan.run("warehouse")["extras"]["policy"]["terraform"]


@app.get("/privacy")
def privacy_kanon() -> dict:
    """k-anonymity over quasi-identifiers + the generalization sweep (warehouse)."""
    x = scan.run("warehouse")["extras"]
    return {"kanon": x["kanon"], "sweep": x["sweep"]}


@app.get("/gate")
def ci_gate(surface: str = "warehouse", mode: str | None = None,
            min_score: int = Query(60)) -> dict:
    """CI gate. Warehouse: any unmasked sensitive column ⇒ fail. Exposure: posture
    below ``min_score`` or any open critical ⇒ fail."""
    _require_surface(surface)
    if surface == "warehouse":
        return scan.gate(mode=mode)
    return scan.exposure_gate(min_score=min_score)


# --------------------------------------------------------------------------- #
# Cross-cutting                                                                #
# --------------------------------------------------------------------------- #

@app.get("/evals")
def evals(mode: str | None = None) -> dict:
    """Eval over BOTH surfaces: warehouse classification/coverage/k-anon + exposure
    coverage + cross-surface invariants + remediation-diff posture deltas."""
    from postureline import evaluate
    return evaluate.run(mode=mode)


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
