"""FastAPI service: introspect the warehouse, classify columns, generate masking +
row-access policy-as-code (Snowflake DDL + Terraform), score re-identification
risk, map to SOC 2 / HIPAA controls, write an executive summary, and run the CI
gate. Stateless; synthetic data only; no real PHI; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse

from maskline import (
    __version__,
    classify,
    controls,
    llm,
    narrative,
    policy,
    risk,
    scan,
    warehouse,
)
from maskline.models import HealthResponse

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="maskline",
    version=__version__,
    description="Data-access governance + masking-policy-as-code for a regulated "
                "analytics warehouse (Snowflake-compatible SQL on DuckDB).",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    classified = classify.classify_all()
    sens = sum(1 for c in classified if c["sensitive"])
    return HealthResponse(status="ok", version=__version__,
                          tables=len(warehouse.tables()),
                          columns=len(classified), sensitive_columns=sens)


@app.get("/warehouse")
def warehouse_schema() -> dict:
    """Introspected schema: tables → columns + types + sample values."""
    return {"warehouse": warehouse.FQ,
            "engine": "duckdb (Snowflake-compatible SQL)",
            "tables": warehouse.schema()}


@app.get("/classify")
def classify_columns(mode: str | None = None) -> dict:
    """Classify every column (name/type heuristics + LLM for free-text PHI)."""
    rows = classify.classify_all(mode=mode)
    return {"columns": rows,
            "sensitive": [c for c in rows if c["sensitive"]]}


@app.get("/scan")
def full_scan(mode: str | None = None, narrative: bool = False) -> dict:
    """The full governance result: discover → classify → coverage → risk →
    controls → posture (+ optional LLM executive summary)."""
    return scan.scan(mode=mode, include_narrative=narrative)


@app.get("/policy")
def policy_artifacts(mode: str | None = None) -> dict:
    """Generated Snowflake DDL + Terraform + the coverage gap."""
    classified = classify.classify_all(mode=mode)
    return {
        "snowflake_ddl": policy.generate_snowflake_ddl(classified),
        "terraform": policy.generate_terraform(classified),
        "coverage": policy.coverage(classified),
    }


@app.get("/policy/ddl", response_class=PlainTextResponse)
def policy_ddl() -> str:
    """Raw Snowflake DDL (text/plain — paste-ready)."""
    return policy.generate_snowflake_ddl(classify.classify_all())


@app.get("/policy/terraform", response_class=PlainTextResponse)
def policy_terraform() -> str:
    """Raw Terraform (text/plain — paste-ready)."""
    return policy.generate_terraform(classify.classify_all())


@app.get("/risk")
def risk_kanon() -> dict:
    """k-anonymity over quasi-identifiers + the generalization sweep."""
    return {"kanon": risk.k_anonymity(), "sweep": risk.generalization_sweep()}


@app.get("/controls")
def controls_posture(mode: str | None = None) -> dict:
    """SOC 2 / HIPAA control pass-fail + severity-weighted posture score."""
    classified = classify.classify_all(mode=mode)
    cov = policy.coverage(classified)
    return controls.evaluate(classified, cov, risk.k_anonymity())


@app.get("/narrative")
def exec_narrative(mode: str | None = None) -> dict:
    """LLM executive risk summary (security-as-enabler framing)."""
    return narrative.summarize(scan.scan(mode=mode)["summary"], mode=mode)


@app.get("/gate")
def ci_gate(mode: str | None = None) -> dict:
    """CI pass/fail: any unmasked sensitive column ⇒ fail (exit_code 1)."""
    return scan.gate(mode=mode)


@app.get("/evals")
def evals(mode: str | None = None) -> dict:
    """Column-classification precision/recall + coverage + invariants."""
    from maskline import evaluate
    return evaluate.run(mode=mode)


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.post("/admin/reset")
def admin_reset() -> dict:
    warehouse.reset()
    return {"reset": True, "tables": len(warehouse.tables())}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
