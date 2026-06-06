"""Benchmark result persistence — one JSON file per run.

Filesystem-backed on purpose: results are small, append-only, and the
deployment decides durability (a PVC in k8s, a plain directory locally).
``PERSONA_TWIN_BENCH_DIR`` sets the location (default ``./benchmarks``,
gitignored).
"""

import os
import re
from pathlib import Path

from pydantic import BaseModel

from persona_twin.eval.benchmark import BenchmarkRun
from persona_twin.log import get_logger, kv

logger = get_logger("eval.bench_store")

_RUN_ID = re.compile(r"^[A-Za-z0-9_-]+$")  # also guards path traversal


class RunSummary(BaseModel):
    run_id: str
    status: str
    started_at: str | None
    finished_at: str | None
    items_limit: int
    tasks: list[str]
    models: list[str]
    results_count: int


def default_bench_dir() -> Path:
    return Path(os.environ.get("PERSONA_TWIN_BENCH_DIR", "benchmarks"))


class BenchmarkStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or default_bench_dir()
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self.writable = True
        except OSError:  # read-only fs etc. — degrade to in-memory only
            self.writable = False
            logger.warning("bench store unwritable %s", kv(root=str(self.root)))

    def save(self, run: BenchmarkRun) -> None:
        if not self.writable or not run.run_id:
            return
        path = self.root / f"{run.run_id}.json"
        path.write_text(run.model_dump_json(indent=2))
        logger.info("benchmark persisted %s", kv(run_id=run.run_id, path=str(path)))

    def load(self, run_id: str) -> BenchmarkRun | None:
        if not _RUN_ID.match(run_id):
            return None
        path = self.root / f"{run_id}.json"
        if not path.is_file():
            return None
        return BenchmarkRun.model_validate_json(path.read_text())

    def list_runs(self) -> list[RunSummary]:
        summaries: list[RunSummary] = []
        if not self.root.is_dir():
            return summaries
        for path in self.root.glob("*.json"):
            try:
                run = BenchmarkRun.model_validate_json(path.read_text())
            except ValueError:
                continue
            if not run.run_id:
                continue
            summaries.append(
                RunSummary(
                    run_id=run.run_id,
                    status=run.status,
                    started_at=run.started_at,
                    finished_at=run.finished_at,
                    items_limit=run.items_limit,
                    tasks=sorted({r.task for r in run.results}),
                    models=sorted(
                        {f"{r.provider}:{r.model}" for r in run.results}
                    ),
                    results_count=len(run.results),
                )
            )
        return sorted(summaries, key=lambda s: s.started_at or "", reverse=True)
