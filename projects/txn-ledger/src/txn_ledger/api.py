"""FastAPI service: a high-volume contributions data service — a seeded synthetic
dataset in SQLite with a tuned, partitioned-by-cycle access pattern, FEC-style
rollups, the before/after query plan, and an end-of-quarter surge load test.
Stateless; no secrets.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from txn_ledger import __version__, db, llm, loadtest, nl2sql, queries
from txn_ledger.generate import COMMITTEES, CYCLES
from txn_ledger.models import AskRequest, HealthResponse, LoadRequest

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="txn-ledger",
    version=__version__,
    description="High-volume contributions store — partitioned schema + query plans.",
)

db.build()  # load the seeded dataset + capture the query plan at startup


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, rows=db.meta()["rows"],
                          committees=len(COMMITTEES), cycles=len(CYCLES))


@app.get("/summary")
def summary() -> dict:
    return queries.summary()


@app.get("/schema")
def schema() -> dict:
    m = db.meta()
    return {
        "table": "contributions(id, donor_id, committee_id, cycle, amount, ts)",
        "indexes": m["indexes"],
        "partitioning": "by election cycle (Postgres declarative partitioning in "
                        "production; emulated here by a leading-cycle composite index)",
        "rows": m["rows"], "load_ms": m["load_ms"],
    }


@app.get("/cycles")
def cycles() -> dict:
    return {"cycles": queries.cycles()}


@app.get("/committees")
def committees() -> dict:
    return {"committees": queries.committees()}


@app.get("/aggregate")
def aggregate(cycle: int, committee: str | None = None) -> dict:
    if cycle not in CYCLES:
        raise HTTPException(422, f"unknown cycle; valid: {CYCLES}")
    return queries.aggregate(cycle, committee)


@app.get("/plan")
def plan() -> dict:
    return queries.plan()


@app.post("/loadtest")
def run_loadtest(req: LoadRequest) -> dict:
    return loadtest.surge(req.n)


@app.post("/ask")
def ask(req: AskRequest) -> dict:
    """Natural-language → SQL: translate the question via the routing chain,
    guard the generated SQL to a single read-only SELECT, run it, and return the
    rows plus the generated SQL and provider telemetry. A guard rejection returns
    ``safe: false`` with the offending SQL and is never executed."""
    return nl2sql.ask(req.question, mode=req.mode)


@app.get("/evals")
def evals() -> dict:
    """Plan-regression (hot path still uses the covering index) + NL→SQL accuracy
    over the labeled question set."""
    return {
        "plan_regression": queries.plan_regression(),
        "nl2sql": nl2sql.evaluate(),
    }


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
