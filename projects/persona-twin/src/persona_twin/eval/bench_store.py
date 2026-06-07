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

from persona_twin.eval.benchmark import BenchmarkRun, TaskResult
from persona_twin.log import get_logger, kv

logger = get_logger("eval.bench_store")

_RUN_ID = re.compile(r"^[A-Za-z0-9_-]+$")  # also guards path traversal


class AggregateEntry(TaskResult):
    """A task×model scorecard cell, annotated with the run it came from."""

    run_id: str
    finished_at: str | None = None


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

    def save(self, run: BenchmarkRun) -> None:
        """Persist a run; the directory is created lazily on first write.
        A read-only filesystem degrades to in-memory-only with a warning."""
        if not run.run_id:
            return
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.root / f"{run.run_id}.json"
            path.write_text(run.model_dump_json(indent=2))
        except OSError:
            logger.warning("bench store unwritable %s", kv(root=str(self.root)))
            return
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

    def _iter_runs(self) -> list[BenchmarkRun]:
        runs: list[BenchmarkRun] = []
        if not self.root.is_dir():
            return runs
        for path in self.root.glob("*.json"):
            try:
                runs.append(BenchmarkRun.model_validate_json(path.read_text()))
            except ValueError:
                continue
        return sorted(runs, key=lambda r: r.started_at or "")

    def aggregate(self, current: BenchmarkRun | None = None) -> list[AggregateEntry]:
        """Latest result per (task, provider, model) across all persisted
        runs, optionally overlaid with a live in-memory run."""
        runs = self._iter_runs()
        if current is not None and current.run_id:
            runs = [r for r in runs if r.run_id != current.run_id] + [current]
        latest: dict[tuple[str, str, str], AggregateEntry] = {}
        for run in runs:
            for result in run.results:
                latest[(result.task, result.provider, result.model)] = AggregateEntry(
                    **result.model_dump(),
                    run_id=run.run_id or "live",
                    finished_at=run.finished_at,
                )
        return list(latest.values())
